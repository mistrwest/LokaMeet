export type LocalMediaConfig = {
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoQuality: "low" | "medium" | "high";
};

export function getVideoConstraints(quality: LocalMediaConfig["videoQuality"]): MediaTrackConstraints {
  if (quality === "low") return { width: 320, height: 240, frameRate: 15 };
  if (quality === "medium") return { width: 640, height: 480, frameRate: 30 };
  return { width: 1280, height: 720, frameRate: 30 };
}

/** LAN-only mesh: без публичных STUN/TURN — достаточно host-кандидатов. */
export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle"
  });
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
      return false;
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
    void sender.replaceTrack(newTrack).catch(() => {
      // replaceTrack падает при закрытом PC — игнорируем
    });
    return needsRenegotiate;
  }

  if (newTrack && localStream) {
    try {
      pc.addTrack(newTrack, localStream);
      return true;
    } catch (err) {
      console.error("Failed to add video track to peer connection:", err);
    }
  }
  return false;
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
  let micSender = senders.find((s) => s.track?.kind === "audio" && !isScreenAudio(s.track));
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
