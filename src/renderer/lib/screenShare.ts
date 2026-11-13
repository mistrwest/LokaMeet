export type ScreenSourceItem = {
  id: string;
  name: string;
  thumbnail: string;
};

export type ScreenShareTab = "screen" | "window" | "app";

/** Ниже 60 демонстрация выглядит рваной. Выше частоты монитора кадры только дублируются. */
export const SCREEN_SHARE_FPS_MIN = 60;
export const SCREEN_SHARE_FPS_MAX = 120;

let screenShareFps = SCREEN_SHARE_FPS_MIN;
let screenShareFpsPromise: Promise<number> | null = null;
let nativeCapture = { width: 0, height: 0, fullScreen: true };

export function resolveScreenShareFps(displayHz: number): number {
  const hz = Number.isFinite(displayHz) ? Math.round(displayHz) : SCREEN_SHARE_FPS_MIN;
  return Math.min(SCREEN_SHARE_FPS_MAX, Math.max(SCREEN_SHARE_FPS_MIN, hz));
}

export function getScreenShareFps() {
  return screenShareFps;
}

/** Частота захвата: частота монитора, но не ниже 60 и не выше 120. */
export function ensureScreenShareFps(): Promise<number> {
  if (typeof window === "undefined" || !window.lokameet?.screen?.getRefreshRate) {
    return Promise.resolve(screenShareFps);
  }
  if (!screenShareFpsPromise) {
    screenShareFpsPromise = window.lokameet.screen
      .getRefreshRate()
      .then((hz) => {
        screenShareFps = resolveScreenShareFps(hz);
        return screenShareFps;
      })
      .catch(() => screenShareFps);
  }
  return screenShareFpsPromise;
}

function screenShareFrameRate(): MediaTrackConstraints["frameRate"] {
  const fps = getScreenShareFps();
  // Потолок 120, а не частота монитора: жёсткий max на её такте выбрасывал кадр, пришедший чуть раньше.
  return { ideal: fps, max: SCREEN_SHARE_FPS_MAX };
}

export function bitrateForScreenTrack(track: MediaStreamTrack): number {
  const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
  const width = Number(settings.width) || nativeCapture.width || 1920;
  const height = Number(settings.height) || nativeCapture.height || 1080;
  const fps = Number(settings.frameRate) || getScreenShareFps();
  return screenShareBitrate(width, height, fps);
}

/** Битрейт LAN-трансляции: достаточно, чтобы кадр видео не дробился и не мылился. */
export function screenShareBitrate(width: number, height: number, fps: number): number {
  const w = width >= 320 ? width : 1920;
  const h = height >= 180 ? height : 1080;
  const rate = Math.min(SCREEN_SHARE_FPS_MAX, Math.max(30, Math.round(fps) || SCREEN_SHARE_FPS_MIN));
  return Math.min(60_000_000, Math.max(16_000_000, Math.round(w * h * rate * 0.2)));
}

/** Размер и частота именно того экрана, который демонстрируют, а не фиксированные 1920×1080. */
export async function prepareScreenShareCapture(sourceId: string | null): Promise<void> {
  const fullScreen = !sourceId || isScreenSourceId(sourceId);
  if (typeof window === "undefined" || !window.lokameet?.screen?.getCaptureTarget) {
    await ensureScreenShareFps();
    nativeCapture = { width: 0, height: 0, fullScreen };
    return;
  }
  try {
    const target = await window.lokameet.screen.getCaptureTarget(sourceId);
    screenShareFps = resolveScreenShareFps(target.fps);
    nativeCapture = {
      width: Math.max(0, Math.round(target.width) || 0),
      height: Math.max(0, Math.round(target.height) || 0),
      fullScreen
    };
  } catch {
    await ensureScreenShareFps();
    nativeCapture = { width: 0, height: 0, fullScreen };
  }
}

function screenShareVideoConstraints(): MediaTrackConstraints {
  const video = {
    frameRate: screenShareFrameRate(),
    resizeMode: "none"
  } as MediaTrackConstraints;
  if (nativeCapture.fullScreen && nativeCapture.width >= 640 && nativeCapture.height >= 360) {
    video.width = { ideal: nativeCapture.width };
    video.height = { ideal: nativeCapture.height };
    video.aspectRatio = { ideal: nativeCapture.width / nativeCapture.height };
  }
  return video;
}

const SYSTEM_WINDOW_RE =
  /program manager|^desktop$|windows input experience|microsoft text input application|task view|settings|nvidia|overlay/i;

export function categorizeScreenSources(sources: ScreenSourceItem[]) {
  const screens: ScreenSourceItem[] = [];
  const apps: ScreenSourceItem[] = [];

  for (const source of sources) {
    if (source.id.startsWith("screen:")) {
      screens.push(source);
      continue;
    }
    if (!source.id.startsWith("window:")) continue;
    const name = source.name.trim();
    if (!name || SYSTEM_WINDOW_RE.test(name)) continue;
    apps.push(source);
  }

  return { screens, apps };
}

export function isScreenSourceId(sourceId: string) {
  return sourceId.startsWith("screen:");
}

export function isAppWindowSourceId(sourceId: string) {
  return sourceId.startsWith("window:");
}

const SCREEN_AUDIO_LABEL_RE = /screen|desktop|display|loopback|system audio|tab audio/i;
const SCREEN_VIDEO_LABEL_RE = /screen|window|desktop|web-contents-media-stream|primary monitor/i;

export function isScreenBroadcastAudioTrack(track: MediaStreamTrack, stream: MediaStream, knownTrackId?: string) {
  if (track.kind !== "audio") return false;
  if (knownTrackId) return track.id === knownTrackId;
  return SCREEN_AUDIO_LABEL_RE.test(track.label);
}

export function findScreenBroadcastAudioTrack(stream: MediaStream, knownTrackId?: string) {
  return stream.getAudioTracks().find((track) => isScreenBroadcastAudioTrack(track, stream, knownTrackId)) ?? null;
}

export function getMicAudioTrack(stream: MediaStream, knownScreenAudioTrackId?: string) {
  const tracks = stream.getAudioTracks().filter((track) => !isScreenBroadcastAudioTrack(track, stream, knownScreenAudioTrackId));
  return tracks.find((track) => track.readyState === "live") ?? tracks[0];
}

/** Формирует поток плитки без звука трансляции, чтобы громкость микрофона не меняла громкость показа экрана. */
export function createPeerTileStream(stream: MediaStream, knownScreenAudioTrackId?: string) {
  const out = new MediaStream();
  for (const track of stream.getVideoTracks()) out.addTrack(track);
  for (const track of stream.getAudioTracks()) {
    if (track.readyState !== "live") continue;
    if (!isScreenBroadcastAudioTrack(track, stream, knownScreenAudioTrackId)) {
      out.addTrack(track);
    }
  }
  return out;
}

const screenVideoTracks = new WeakSet<MediaStreamTrack>();

export function markScreenVideoTrack(track: MediaStreamTrack) {
  screenVideoTracks.add(track);
}

export function isScreenVideoTrack(track: MediaStreamTrack, knownScreenVideoTrackId?: string) {
  if (track.kind !== "video") return false;
  if (screenVideoTracks.has(track)) return true;
  if (knownScreenVideoTrackId && track.id === knownScreenVideoTrackId) return true;
  return SCREEN_VIDEO_LABEL_RE.test(track.label);
}

export function pickScreenVideoTrack(stream: MediaStream, knownScreenVideoTrackId?: string) {
  const live = stream.getVideoTracks().filter((t) => t.readyState === "live");
  if (knownScreenVideoTrackId) {
    const exact = live.find((t) => t.id === knownScreenVideoTrackId);
    if (exact) return exact;
  }
  const labeled = live.find((t) => isScreenVideoTrack(t));
  if (labeled) return labeled;
  return live[0] ?? null;
}

export function findPresenterCameraTrack(stream: MediaStream, knownScreenVideoTrackId?: string) {
  const screen = pickScreenVideoTrack(stream, knownScreenVideoTrackId);
  return (
    stream.getVideoTracks().find(
      (t) =>
        t.readyState === "live" &&
        t.enabled &&
        !t.muted &&
        t.id !== screen?.id &&
        !isScreenVideoTrack(t, knownScreenVideoTrackId)
    ) ?? null
  );
}

/** Формирует поток просмотра без микрофона, чтобы зритель слышал только звук демонстрации. */
export function createScreenShareViewStream(
  stream: MediaStream,
  knownScreenAudioTrackId?: string,
  knownScreenVideoTrackId?: string
) {
  const out = new MediaStream();
  const screenVideo = pickScreenVideoTrack(stream, knownScreenVideoTrackId);
  if (screenVideo) out.addTrack(screenVideo);
  const screenAudio = findScreenBroadcastAudioTrack(stream, knownScreenAudioTrackId);
  if (screenAudio) out.addTrack(screenAudio);
  return out;
}

/** Удаляет завершённые и дублирующие видеотреки, чтобы плитка не замирала на последнем кадре трансляции. */
/** После стопа экрана у зрителя остаётся extra-audio (звук демо / тихий park). Mic — первый трек. */
export function dropExtraRemoteAudioTracks(stream: MediaStream) {
  const audio = stream.getAudioTracks();
  if (audio.length < 2) return;
  for (const track of audio.slice(1)) {
    try {
      stream.removeTrack(track);
    } catch {
      // Уже удалённый трек не должен прерывать очистку остальных.
    }
  }
}

export function pruneStaleRemoteStreamTracks(stream: MediaStream, opts?: { dropMutedVideo?: boolean }) {
  for (const track of [...stream.getTracks()]) {
    if (track.readyState === "ended") {
      try {
        stream.removeTrack(track);
      } catch {
        // Уже удалённый трек не должен прерывать очистку остальных.
      }
    }
  }

  if (opts?.dropMutedVideo) {
    for (const track of [...stream.getVideoTracks()]) {
      if (track.muted || track.readyState !== "live") {
        try {
          stream.removeTrack(track);
        } catch {
          // Ошибка удаления одного трека не должна оставлять остальные без очистки.
        }
      }
    }
  }

  // Два живых video — экран и вебкамера докладчика; не схлопываем до одного.
}

function isUserMediaCancelError(err: unknown) {
  const errorName = err instanceof Error ? err.name : String(err);
  const errorMsg = err instanceof Error ? err.message : String(err);
  return (
    errorName === "NotAllowedError" ||
    errorName === "AbortError" ||
    errorMsg.toLowerCase().includes("cancel") ||
    errorMsg.toLowerCase().includes("denied") ||
    errorMsg.toLowerCase().includes("not allowed") ||
    errorMsg.toLowerCase().includes("permission")
  );
}

/**
 * Использует getDisplayMedia и suppressLocalAudioPlayback, чтобы не воспроизводить локально захваченный системный звук.
 * Это предотвращает эхо, которое появляется при loopback через getUserMedia с chromeMediaSource: desktop.
 */
async function captureDisplayMedia(withAudio: boolean, preferredSourceId?: string | null): Promise<MediaStream> {
  const video = screenShareVideoConstraints();
  const audio: boolean | MediaTrackConstraints = withAudio
    ? ({ suppressLocalAudioPlayback: true } as MediaTrackConstraints)
    : false;

  if (preferredSourceId && typeof window !== "undefined" && window.lokameet?.screen?.setPreferredSource) {
    await window.lokameet.screen.setPreferredSource(preferredSourceId).catch(() => undefined);
  }

  const relaxed = {
    frameRate: { ideal: getScreenShareFps() },
    resizeMode: "none"
  } as MediaTrackConstraints;
  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio });
  } catch (err) {
    if (isUserMediaCancelError(err)) throw err;
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: relaxed, audio });
    } catch (errRelaxed) {
      if (isUserMediaCancelError(errRelaxed)) throw errRelaxed;
      try {
        return await navigator.mediaDevices.getDisplayMedia({ video: true, audio });
      } catch (err2) {
        if (!withAudio || isUserMediaCancelError(err2)) throw err2;
        return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      }
    }
  } finally {
    if (preferredSourceId && typeof window !== "undefined" && window.lokameet?.screen?.setPreferredSource) {
      await window.lokameet.screen.setPreferredSource(null).catch(() => undefined);
    }
  }
}

/**
 * Выбирает API захвата Electron по наличию источника и аудио, сохраняя совместимость с системным picker.
 * При sourceId=null источник выбирается системным или handler picker через getDisplayMedia.
 * Захват со звуком всегда идёт через getDisplayMedia с suppressLocalAudioPlayback, чтобы избежать эха.
 */
/** Держит исходный размер кадра. Подсказка motion не даёт энкодеру выбрасывать кадры ради резкости. */
export function configureScreenShareTrack(track: MediaStreamTrack) {
  try {
    track.contentHint = "motion";
  } catch {
    // contentHint может отсутствовать в старых Chromium
  }
  let base: MediaTrackConstraints = {};
  try {
    const current = track.getConstraints();
    const { advanced: _advanced, ...rest } = current;
    base = rest;
  } catch {
    base = {};
  }
  const next = {
    ...base,
    ...screenShareVideoConstraints()
  } as MediaTrackConstraints;
  void track.applyConstraints(next).catch(() => undefined);
}

/**
 * Захват выбранного окна/экрана всегда через getDisplayMedia.
 * getUserMedia(chromeMediaSource) без звука на Windows открывает камеру вместо окна.
 * Исходный трек уходит как есть: пересъёмка на холст выбрасывала кадры между тиками таймера.
 */
export async function captureDesktopMedia(sourceId: string | null, withAudio: boolean): Promise<MediaStream> {
  await prepareScreenShareCapture(sourceId);
  const stream = await captureDisplayMedia(withAudio, sourceId);
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) {
    configureScreenShareTrack(videoTrack);
    markScreenVideoTrack(videoTrack);
  }
  return stream;
}
