import { createPeerConnection, requestScreenShareKeyframe, tuneScreenShareSender } from "./webrtc";

function preferScreenCodec(pc: RTCPeerConnection, track: MediaStreamTrack) {
  const transceiver = pc.getTransceivers().find((item) => item.sender?.track?.id === track.id);
  if (!transceiver || typeof transceiver.setCodecPreferences !== "function" || typeof RTCRtpSender.getCapabilities !== "function") return;
  const caps = RTCRtpSender.getCapabilities("video");
  if (!caps?.codecs?.length) return;
  const rank = (mime: string) => {
    const name = mime.toLowerCase();
    if (name.includes("h264")) return 0;
    if (name.includes("vp9")) return 1;
    if (name.includes("av1")) return 2;
    if (name.includes("vp8")) return 3;
    return 4;
  };
  const codecs = [...caps.codecs].sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
  try {
    transceiver.setCodecPreferences(codecs);
  } catch {
    // Набор кодеков может быть уже зафиксирован предыдущим offer.
  }
}

/** Отдельный PC только для экрана: звонок (mic+камера) его не видит. */
export function createScreenSharePeerConnection(): RTCPeerConnection {
  return createPeerConnection();
}

export function attachOutgoingScreenTracks(
  pc: RTCPeerConnection,
  video: MediaStreamTrack,
  audio?: MediaStreamTrack | null
) {
  const stream = new MediaStream();
  stream.addTrack(video);
  pc.addTrack(video, stream);
  preferScreenCodec(pc, video);
  tuneScreenShareSender(pc, video);
  if (audio && audio.readyState === "live") {
    stream.addTrack(audio);
    pc.addTrack(audio, stream);
  }
}

export function retuneScreenSharePeer(pc: RTCPeerConnection, video: MediaStreamTrack) {
  tuneScreenShareSender(pc, video);
  requestScreenShareKeyframe(pc, video);
}

export function closeRtcPeer(pc: RTCPeerConnection | null | undefined) {
  if (!pc) return;
  try {
    pc.close();
  } catch {
    // уже закрыт
  }
}
