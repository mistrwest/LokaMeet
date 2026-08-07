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

/** Формирует поток просмотра без микрофона, чтобы зритель слышал только звук демонстрации. */
export function createScreenShareViewStream(stream: MediaStream, knownScreenAudioTrackId?: string) {
  const out = new MediaStream();
  for (const track of stream.getVideoTracks()) out.addTrack(track);
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

  const liveVideo = stream.getVideoTracks().filter((track) => track.readyState === "live" && !track.muted);
  if (liveVideo.length > 1) {
    for (let i = 0; i < liveVideo.length - 1; i++) {
      try {
        stream.removeTrack(liveVideo[i]);
      } catch {
        // Неудача удаления дубликата не должна мешать воспроизведению оставшегося трека.
      }
    }
  }
}

type ElectronDesktopVideoConstraints = MediaTrackConstraints & {
  chromeMediaSource?: string;
  chromeMediaSourceId?: string;
  maxFrameRate?: number;
  mandatory?: {
    chromeMediaSource: string;
    chromeMediaSourceId?: string;
    maxFrameRate?: number;
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
    maxFrameRate: 30
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
    frameRate: { ideal: 30 }
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
    if (!withAudio || isUserMediaCancelError(err)) throw err;
    return navigator.mediaDevices.getDisplayMedia({ video, audio: false });
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
export async function captureDesktopMedia(sourceId: string | null, withAudio: boolean): Promise<MediaStream> {
  if (withAudio) {
    return captureDisplayMedia(true, sourceId);
  }

  if (sourceId) {
    try {
      return await captureDesktopSourceVideoOnly(sourceId);
    } catch (err) {
      if (isUserMediaCancelError(err)) throw err;
      return captureDisplayMedia(false, sourceId);
    }
  }

  return captureDisplayMedia(false, null);
}
