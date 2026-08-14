export type VideoQuality = "low" | "medium" | "high" | "fullhd" | "qhd" | "uhd";

export type LocalMediaConfig = {
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoQuality: VideoQuality;
};

const VIDEO_QUALITY_CONSTRAINTS: Record<VideoQuality, MediaTrackConstraints> = {
  low: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
  medium: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  high: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  fullhd: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  qhd: { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
  uhd: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }
};

export function getVideoConstraints(quality: LocalMediaConfig["videoQuality"]): MediaTrackConstraints {
  return { ...(VIDEO_QUALITY_CONSTRAINTS[quality] ?? VIDEO_QUALITY_CONSTRAINTS.high) };
}

/** LAN-only mesh: без публичных STUN/TURN — достаточно host-кандидатов. */
export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle"
  });
}

function replaceVideoTrackInternal(
  pc: RTCPeerConnection,
  newTrack: MediaStreamTrack | null,
  localStream: MediaStream | undefined,
  wait: boolean
): boolean | Promise<boolean> {
  const senders = pc.getSenders();
  // 1) Живой исходящий video sender
  let sender = senders.find((s) => s.track?.kind === "video");
  let transceiver = sender ? pc.getTransceivers().find((t) => t.sender === sender) : undefined;

  // 2) Наш исходящий слот после replaceTrack(null) — НЕ трогаем recvonly (чужой экран/камера)
  if (!sender) {
    transceiver = pc.getTransceivers().find((t) => {
      const kind = t.receiver.track?.kind ?? t.sender.track?.kind;
      if (kind !== "video") return false;
      if (t.sender.track) return false;
      if (t.direction === "recvonly" || t.currentDirection === "recvonly") return false;
      return t.direction === "sendrecv" || t.direction === "sendonly" || t.direction === "inactive";
    });
    sender = transceiver?.sender;
  }

  if (sender) {
    if (sender.track?.id === newTrack?.id) {
      return wait ? Promise.resolve(false) : false;
    }
    let needsRenegotiate = false;
    if (newTrack && transceiver && transceiver.direction === "inactive") {
      try {
        transceiver.direction = "sendrecv";
        needsRenegotiate = true;
      } catch {
        // direction может быть заблокирован в текущем состоянии PC
      }
    }
    const done = sender.replaceTrack(newTrack).catch(() => {
      // replaceTrack падает при закрытом PC — игнорируем
    });
    return wait ? done.then(() => needsRenegotiate) : needsRenegotiate;
  }

  if (newTrack && localStream) {
    try {
      pc.addTrack(newTrack, localStream);
      return wait ? Promise.resolve(true) : true;
    } catch (err) {
      console.error("Failed to add video track to peer connection:", err);
    }
  }
  return wait ? Promise.resolve(false) : false;
}

/**
 * Подменяет исходящий video track (камера ↔ экран).
 * Не трогает recvonly-трансиверы (чужое видео).
 * @returns true если нужен renegotiate (addTrack или смена direction).
 */
export function replaceVideoTrack(
  pc: RTCPeerConnection,
  newTrack: MediaStreamTrack | null,
  localStream?: MediaStream
): boolean {
  return replaceVideoTrackInternal(pc, newTrack, localStream, false) as boolean;
}

/** Как replaceVideoTrack, но ждёт replaceTrack — нужно до добавления вебкамеры поверх экрана. */
export function replaceVideoTrackAsync(
  pc: RTCPeerConnection,
  newTrack: MediaStreamTrack | null,
  localStream?: MediaStream
): Promise<boolean> {
  return replaceVideoTrackInternal(pc, newTrack, localStream, true) as Promise<boolean>;
}

function videoSenders(pc: RTCPeerConnection) {
  return pc.getSenders().filter((s) => {
    const transceiver = pc.getTransceivers().find((t) => t.sender === s);
    if (transceiver?.direction === "recvonly" || transceiver?.currentDirection === "recvonly") return false;
    if (s.track?.kind === "video") return true;
    const kind = transceiver?.receiver.track?.kind ?? transceiver?.sender.track?.kind;
    return kind === "video";
  });
}

/** Второй исходящий video (вебкамера поверх демонстрации). Не трогает sender экрана. */
export function addSecondaryVideoTrack(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  localStream: MediaStream,
  primaryTrackId: string
): boolean {
  const senders = videoSenders(pc);
  const primary = senders.find((s) => s.track?.id === primaryTrackId);
  const already = senders.find((s) => s.track?.id === track.id);
  if (already && already !== primary) return false;
  const secondary = senders.find((s) => s !== primary && s.track?.id !== track.id);
  if (secondary) {
    if (secondary.track?.id === track.id) return false;
    void secondary.replaceTrack(track).catch(() => undefined);
    return false;
  }
  try {
    pc.addTrack(track, localStream);
    return true;
  } catch {
    return false;
  }
}

export function tuneScreenShareSender(pc: RTCPeerConnection, track: MediaStreamTrack) {
  const sender = pc.getSenders().find((s) => s.track?.id === track.id);
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    for (const enc of params.encodings) {
      enc.maxFramerate = 30;
      enc.maxBitrate = 8_000_000;
      enc.scaleResolutionDownBy = 1;
    }
    const withPref = params as RTCRtpSendParameters & { degradationPreference?: string };
    withPref.degradationPreference = "maintain-resolution";
    void sender.setParameters(withPref).catch(() => undefined);
  } catch {
    // setParameters может быть недоступен до первого offer
  }
}

export function requestScreenShareKeyframe(pc: RTCPeerConnection, track: MediaStreamTrack) {
  const sender = pc.getSenders().find((s) => s.track?.id === track.id) as
    | (RTCRtpSender & { generateKeyFrame?: () => Promise<void> })
    | undefined;
  if (!sender) return;
  if (typeof sender.generateKeyFrame === "function") {
    void sender.generateKeyFrame().catch(() => undefined);
  }
}

export function detachSecondaryVideoTrack(pc: RTCPeerConnection, primaryTrackId: string): boolean {
  const secondary = videoSenders(pc).find((s) => s.track && s.track.id !== primaryTrackId);
  if (!secondary) return false;
  void secondary.replaceTrack(null).catch(() => undefined);
  return true;
}

/** После остановки экрана камера снова идёт в основной video-слот. */
export function restoreCameraAfterScreenShare(
  pc: RTCPeerConnection,
  cameraTrack: MediaStreamTrack | null,
  screenTrackId: string,
  localStream?: MediaStream
): boolean {
  const senders = videoSenders(pc);
  const screenSender = senders.find((s) => s.track?.id === screenTrackId);
  const cameraSender = cameraTrack ? senders.find((s) => s.track?.id === cameraTrack.id) : undefined;
  if (cameraSender && cameraSender !== screenSender) {
    void cameraSender.replaceTrack(null).catch(() => undefined);
  }
  if (screenSender) {
    void screenSender.replaceTrack(cameraTrack).catch(() => undefined);
    return false;
  }
  return replaceVideoTrack(pc, cameraTrack, localStream);
}

export function replaceAudioTrack(pc: RTCPeerConnection, newTrack: MediaStreamTrack | null): Promise<void> {
  const sender = pc.getSenders().find((s) => s.track?.kind === "audio");
  if (!sender) return Promise.resolve();
  if (sender.track?.id === newTrack?.id) return Promise.resolve();
  return sender.replaceTrack(newTrack) ?? Promise.resolve();
}

/**
 * Подменяет только mic-трек, не трогая screen-audio sender.
 * После replaceTrack(null) sender остаётся с track=null — восстанавливаем через transceiver.
 */
export function replaceMicAudioTrack(
  pc: RTCPeerConnection,
  micTrack: MediaStreamTrack | null,
  isScreenAudio: (track: MediaStreamTrack) => boolean,
  localStream?: MediaStream
) {
  const senders = pc.getSenders();
  let micSender = senders.find((s) => s.track?.kind === "audio" && s.track.readyState === "live" && !isScreenAudio(s.track));
  if (!micSender) {
    micSender = senders.find((s) => s.track?.kind === "audio" && !isScreenAudio(s.track));
  }
  if (!micSender) {
    const audioTransceiver = pc.getTransceivers().find((t) => {
      const kind = t.receiver.track?.kind ?? t.sender.track?.kind;
      if (kind !== "audio") return false;
      if (t.sender.track && isScreenAudio(t.sender.track)) return false;
      return true;
    });
    micSender = audioTransceiver?.sender;
  }
  // Последний шанс: любой sender без track (не привязанный к screen audio)
  if (!micSender) {
    micSender = senders.find((s) => !s.track);
  }
  if (micSender) {
    if (micSender.track?.id === micTrack?.id) return;
    void micSender.replaceTrack(micTrack);
    return;
  }
  if (micTrack && localStream) {
    try {
      pc.addTrack(micTrack, localStream);
      return;
    } catch {
      // addTrack не удался — ниже просто выходим
    }
  }
}

/** Добавляет отдельный audio track демонстрации экрана (параллельно с миком). */
export function addScreenAudioTrack(pc: RTCPeerConnection, track: MediaStreamTrack, localStream: MediaStream): boolean {
  if (track.kind !== "audio") return false;
  const existing = pc.getSenders().some((s) => s.track?.id === track.id);
  if (existing) return false;
  try {
    pc.addTrack(track, localStream);
    return true;
  } catch {
    return false;
  }
}

/** Отключает screen-audio sender без удаления transceiver (replaceTrack(null)). */
export function detachScreenAudioTrack(pc: RTCPeerConnection, track: MediaStreamTrack | null): boolean {
  if (!track) return false;
  const sender = pc.getSenders().find((s) => s.track?.id === track.id);
  if (!sender) return false;
  void sender.replaceTrack(null);
  return true;
}
