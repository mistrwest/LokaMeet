export type ScreenSourceItem = {
  id: string;
  name: string;
  thumbnail: string;
};

export type ScreenShareTab = "screen" | "window" | "app";

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

const SCREEN_AUDIO_LABEL_RE = /screen|desktop|display|loopback|share|system/i;
const SCREEN_VIDEO_LABEL_RE = /screen|window|desktop|web-contents-media-stream|primary monitor/i;

export function isScreenBroadcastAudioTrack(track: MediaStreamTrack, stream: MediaStream, knownTrackId?: string) {
  if (track.kind !== "audio") return false;
  if (knownTrackId && track.id === knownTrackId) return true;
  if (SCREEN_AUDIO_LABEL_RE.test(track.label)) return true;
  const audioTracks = stream.getAudioTracks();
  return audioTracks.length >= 2 && track.id === audioTracks[audioTracks.length - 1]?.id;
}

export function findScreenBroadcastAudioTrack(stream: MediaStream, knownTrackId?: string) {
  return stream.getAudioTracks().find((track) => isScreenBroadcastAudioTrack(track, stream, knownTrackId)) ?? null;
}

export function getMicAudioTrack(stream: MediaStream, knownScreenAudioTrackId?: string) {
  return stream.getAudioTracks().find((track) => !isScreenBroadcastAudioTrack(track, stream, knownScreenAudioTrackId));
}

/** Формирует поток плитки без звука трансляции, чтобы громкость микрофона не меняла громкость показа экрана. */
export function createPeerTileStream(stream: MediaStream, knownScreenAudioTrackId?: string) {
  const out = new MediaStream();
  for (const track of stream.getVideoTracks()) out.addTrack(track);
  for (const track of stream.getAudioTracks()) {
    if (!isScreenBroadcastAudioTrack(track, stream, knownScreenAudioTrackId)) {
      out.addTrack(track);
    }
  }
  return out;
}

export function isScreenVideoTrack(track: MediaStreamTrack, knownScreenVideoTrackId?: string) {
  if (track.kind !== "video") return false;
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

type ElectronDesktopVideoConstraints = MediaTrackConstraints & {
  chromeMediaSource?: string;
  chromeMediaSourceId?: string;
  maxFrameRate?: number;
  minFrameRate?: number;
  mandatory?: {
    chromeMediaSource: string;
    chromeMediaSourceId?: string;
    maxFrameRate?: number;
    minFrameRate?: number;
  };
};

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

/** Захватывает только видео через источник desktopCapturer, чтобы системный loopback не создавал эхо. */
async function captureDesktopSourceVideoOnly(sourceId: string): Promise<MediaStream> {
  const videoConstraints: ElectronDesktopVideoConstraints = {
    chromeMediaSource: "desktop",
    chromeMediaSourceId: sourceId,
    maxFrameRate: 30,
    minFrameRate: 5
  };

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: videoConstraints
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          minFrameRate: 5,
          maxFrameRate: 30
        }
      } as ElectronDesktopVideoConstraints
    });
  }
}

/**
 * Использует getDisplayMedia и suppressLocalAudioPlayback, чтобы не воспроизводить локально захваченный системный звук.
 * Это предотвращает эхо, которое появляется при loopback через getUserMedia с chromeMediaSource: desktop.
 */
async function captureDisplayMedia(withAudio: boolean, preferredSourceId?: string | null): Promise<MediaStream> {
  const video = {
    width: { ideal: 1920 },
    height: { ideal: 1080 },
    frameRate: { ideal: 30, max: 30 }
  } as MediaTrackConstraints;
  const audio: boolean | MediaTrackConstraints = withAudio
    ? ({ suppressLocalAudioPlayback: true } as MediaTrackConstraints)
    : false;

  if (preferredSourceId && typeof window !== "undefined" && window.lokameet?.screen?.setPreferredSource) {
    await window.lokameet.screen.setPreferredSource(preferredSourceId).catch(() => undefined);
  }

  try {
    return await navigator.mediaDevices.getDisplayMedia({ video, audio });
  } catch (err) {
    if (isUserMediaCancelError(err)) throw err;
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio });
    } catch (err2) {
      if (!withAudio || isUserMediaCancelError(err2)) throw err2;
      return navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
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
/** Помечает захват экрана как детальный контент и держит ненулевой FPS, чтобы кадры не замирали. */
export function configureScreenShareTrack(track: MediaStreamTrack) {
  try {
    track.contentHint = "detail";
  } catch {
    // contentHint может отсутствовать в старых Chromium
  }
  void track
    .applyConstraints({
      frameRate: { ideal: 30, max: 30 }
    })
    .catch(() => undefined);
}

export async function captureDesktopMedia(sourceId: string | null, withAudio: boolean): Promise<MediaStream> {
  const stream = withAudio
    ? await captureDisplayMedia(true, sourceId)
    : sourceId
      ? await (async () => {
          try {
            return await captureDesktopSourceVideoOnly(sourceId);
          } catch (err) {
            if (isUserMediaCancelError(err)) throw err;
            return captureDisplayMedia(false, sourceId);
          }
        })()
      : await captureDisplayMedia(false, null);
  const videoTrack = stream.getVideoTracks()[0];
  if (videoTrack) configureScreenShareTrack(videoTrack);
  return stream;
}
