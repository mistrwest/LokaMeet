import { bitrateForScreenTrack, getScreenShareFps } from "./screenShare";

export type VideoQuality = "auto" | "low" | "medium" | "high" | "fullhd" | "qhd" | "uhd";

export type LocalMediaConfig = {
  videoEnabled: boolean;
  audioEnabled: boolean;
  videoQuality: VideoQuality;
};

const VIDEO_QUALITIES: VideoQuality[] = ["auto", "low", "medium", "high", "fullhd", "qhd", "uhd"];

const VIDEO_QUALITY_CONSTRAINTS: Record<VideoQuality, MediaTrackConstraints> = {
  auto: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  low: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 24 } },
  medium: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30 } },
  high: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  fullhd: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  qhd: { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
  uhd: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } }
};

export function isVideoQuality(value: unknown): value is VideoQuality {
  return typeof value === "string" && VIDEO_QUALITIES.includes(value as VideoQuality);
}

export function getVideoConstraints(quality: LocalMediaConfig["videoQuality"]): MediaTrackConstraints {
  return { ...(VIDEO_QUALITY_CONSTRAINTS[quality] ?? VIDEO_QUALITY_CONSTRAINTS.auto) };
}

export function getAutoLanConstraints(outgoing?: { width: number; height: number } | null): MediaTrackConstraints {
  const width = outgoing?.width && outgoing.width >= 320 ? outgoing.width : 1280;
  const height = outgoing?.height && outgoing.height >= 180 ? outgoing.height : 720;
  return {
    width: { ideal: Math.min(1920, Math.max(640, width)) },
    height: { ideal: Math.min(1080, Math.max(360, height)) },
    frameRate: { ideal: 30 }
  };
}

/** Фактический размер исходящего видео в LAN (то, что сейчас уходит по WebRTC). */
export async function getOutboundVideoSize(pc: RTCPeerConnection): Promise<{ width: number; height: number } | null> {
  try {
    const stats = await pc.getStats();
    let best: { width: number; height: number } | null = null;
    stats.forEach((report) => {
      if (report.type !== "outbound-rtp") return;
      const kind = (report as RTCOutboundRtpStreamStats).kind;
      if (kind && kind !== "video") return;
      const width = Number((report as { frameWidth?: number }).frameWidth);
      const height = Number((report as { frameHeight?: number }).frameHeight);
      if (!width || !height) return;
      if (!best || width * height > best.width * best.height) best = { width, height };
    });
    return best;
  } catch {
    return null;
  }
}

function trackConstraintBase(track: MediaStreamTrack): MediaTrackConstraints {
  try {
    const current = typeof track.getConstraints === "function" ? track.getConstraints() : {};
    const { advanced: _advanced, ...rest } = current;
    return rest;
  } catch {
    return {};
  }
}

export async function applyTrackResolution(track: MediaStreamTrack, constraints: MediaTrackConstraints): Promise<void> {
  if (track.kind !== "video" || typeof track.applyConstraints !== "function") return;
  const base = trackConstraintBase(track) as MediaTrackConstraints & { focusDistance?: number; focusMode?: string };
  delete base.focusDistance;
  // Смена разрешения пересобирает ограничения и роняет advanced, где живёт автофокус.
  const manual = base.focusMode === "manual";
  const withSize = (extra: MediaTrackConstraints): MediaTrackConstraints =>
    manual
      ? { ...base, ...extra }
      : { ...base, ...extra, advanced: [{ focusMode: "continuous" } as MediaTrackConstraintSet] };
  try {
    await track.applyConstraints(withSize(constraints));
  } catch {
    const width = (constraints.width as ConstrainULongRange | undefined)?.ideal;
    const height = (constraints.height as ConstrainULongRange | undefined)?.ideal;
    if (!width || !height) return;
    try {
      await track.applyConstraints(withSize({ width: { ideal: width }, height: { ideal: height } }));
    } catch {
      // оставляем текущее разрешение трека
    }
  }
}

/** LAN-only mesh: без публичных STUN/TURN — достаточно host-кандидатов. */
export function createPeerConnection(): RTCPeerConnection {
  return new RTCPeerConnection({
    iceServers: [],
    bundlePolicy: "max-bundle"
  });
}

/** Sender звука демонстрации — его нельзя повторно использовать для микрофона. */
const screenAudioSenders = new WeakMap<RTCPeerConnection, RTCRtpSender>();
/** Исходящий mic-слот. После replaceTrack(null) на video Chrome может пометить currentDirection как recvonly. */
const micSenders = new WeakMap<RTCPeerConnection, RTCRtpSender>();

function rememberScreenAudioSender(pc: RTCPeerConnection, sender: RTCRtpSender | undefined) {
  if (sender) screenAudioSenders.set(pc, sender);
}

function isScreenAudioSender(pc: RTCPeerConnection, sender: RTCRtpSender) {
  return screenAudioSenders.get(pc) === sender;
}

function rememberMicSender(pc: RTCPeerConnection, sender: RTCRtpSender | undefined) {
  if (sender) micSenders.set(pc, sender);
}

function transceiverKind(t: RTCRtpTransceiver): "audio" | "video" | undefined {
  const recv = t.receiver?.track?.kind;
  if (recv === "audio" || recv === "video") return recv;
  const send = t.sender?.track?.kind;
  if (send === "audio" || send === "video") return send;
  return undefined;
}

function senderKind(pc: RTCPeerConnection, sender: RTCRtpSender): "audio" | "video" | undefined {
  const t = pc.getTransceivers().find((x) => x.sender === sender);
  if (t) {
    const kind = transceiverKind(t);
    if (kind) return kind;
  }
  const k = sender.track?.kind;
  if (k === "audio" || k === "video") return k;
  return undefined;
}

function isAudioSenderSlot(pc: RTCPeerConnection, sender: RTCRtpSender) {
  if (micSenders.get(pc) === sender || isScreenAudioSender(pc, sender)) return true;
  return senderKind(pc, sender) === "audio";
}

let silentAudioTrack: MediaStreamTrack | null = null;

function getSilentAudioTrack(): MediaStreamTrack | null {
  if (silentAudioTrack && silentAudioTrack.readyState === "live") return silentAudioTrack;
  try {
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    const osc = ctx.createOscillator();
    osc.connect(gain);
    gain.connect(dest);
    osc.start();
    void ctx.resume().catch(() => undefined);
    silentAudioTrack = dest.stream.getAudioTracks()[0] ?? null;
    return silentAudioTrack;
  } catch {
    return null;
  }
}

/** Нельзя replaceTrack(null) на extra-audio: Chromium BUNDLE глушит mic. */
async function parkAudioSender(sender: RTCRtpSender) {
  const silent = getSilentAudioTrack();
  if (silent && sender.track?.id !== silent.id) {
    try {
      await sender.replaceTrack(silent);
      return;
    } catch {
      // PC мог закрыться
    }
  }
  if (sender.track) sender.track.enabled = false;
}

function isParkedSilentTrack(track: MediaStreamTrack | null | undefined) {
  return Boolean(track && silentAudioTrack && track.id === silentAudioTrack.id);
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

  if (sender && isAudioSenderSlot(pc, sender)) {
    sender = undefined;
    transceiver = undefined;
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

let cameraOffTrack: MediaStreamTrack | null = null;

/** Живой, но выключенный кадр: replaceTrack(null) на видео в max-bundle глушит микрофон. */
function cameraOffPlaceholder(): MediaStreamTrack | null {
  if (cameraOffTrack && cameraOffTrack.readyState === "live") {
    cameraOffTrack.enabled = true;
    return cameraOffTrack;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, 2, 2);
    const track = canvas.captureStream(1).getVideoTracks()[0] ?? null;
    if (!track) return null;
    // enabled=false на видео в max-bundle глушит микрофон у собеседника, пока камеру не включат снова.
    track.enabled = true;
    cameraOffTrack = track;
    return track;
  } catch {
    return null;
  }
}

/** Снимает камеру с исходящего video-слота, не обнуляя sender и не трогая микрофон. */
export async function parkOutgoingCamera(pc: RTCPeerConnection): Promise<void> {
  const parked = cameraOffPlaceholder();
  if (!parked) return;
  const sender = pc.getSenders().find((s) => {
    if (s.track?.kind !== "video" || s.track.id === parked.id) return false;
    if (isAudioSenderSlot(pc, s)) return false;
    const tx = pc.getTransceivers().find((t) => t.sender === s);
    if (tx && (tx.direction === "recvonly" || tx.currentDirection === "recvonly")) return false;
    return true;
  });
  if (!sender || sender.track?.id === parked.id) return;
  await replaceSenderTrack(sender, parked);
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
  // Без найденного экрана нельзя брать «первый попавшийся» sender — это затрёт демонстрацию или audio.
  if (primary) {
    const secondary = senders.find((s) => s !== primary);
    if (secondary) {
      if (secondary.track?.id === track.id) return false;
      void secondary.replaceTrack(track).catch(() => undefined);
      return false;
    }
  }
  try {
    pc.addTransceiver(track, { direction: "sendrecv", streams: [localStream] });
    return true;
  } catch {
    try {
      pc.addTrack(track, localStream);
      return true;
    } catch {
      return false;
    }
  }
}

const MIC_MAX_BITRATE = 128_000;

/** Держит речь на 128 кбит/с: стандартный Opus в WebRTC заметно глуше на LAN. */
function tuneMicrophoneSender(sender: RTCRtpSender) {
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    let changed = false;
    for (const enc of params.encodings) {
      if ((enc.maxBitrate ?? 0) >= MIC_MAX_BITRATE) continue;
      enc.maxBitrate = MIC_MAX_BITRATE;
      changed = true;
    }
    if (changed) void sender.setParameters(params).catch(() => undefined);
  } catch {
    // setParameters может быть недоступен до первого offer
  }
}

export function screenShareBitrateForTrack(track: MediaStreamTrack): number {
  return bitrateForScreenTrack(track);
}

/** Поднимает потолок битрейта в SDP, иначе энкодер режет кадры ещё до setParameters. */
export function boostScreenShareSdp(sdp: string, maxBitrate: number): string {
  if (!sdp) return sdp;
  const kbps = Math.max(4000, Math.round(maxBitrate / 1000));
  const nl = sdp.includes("\r\n") ? "\r\n" : "\n";
  const lines = sdp.split(/\r?\n/);
  const out: string[] = [];
  let inVideo = false;
  let budgeted = false;
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("m=")) {
      inVideo = line.startsWith("m=video");
      budgeted = false;
      out.push(line);
      continue;
    }
    if (inVideo && line.startsWith("b=")) continue;
    if (inVideo && !budgeted && (line.startsWith("c=") || line.startsWith("a="))) {
      out.push(`b=AS:${kbps}`);
      budgeted = true;
    }
    if (inVideo && line.startsWith("a=fmtp:") && !line.includes("x-google-max-bitrate")) {
      out.push(
        `${line};x-google-max-bitrate=${kbps};x-google-min-bitrate=${Math.round(kbps * 0.6)};x-google-start-bitrate=${kbps}`
      );
      continue;
    }
    out.push(line);
  }
  return `${out.join(nl)}${nl}`;
}

export function tuneScreenShareSender(pc: RTCPeerConnection, track: MediaStreamTrack) {
  const sender = pc.getSenders().find((s) => s.track?.id === track.id);
  if (!sender) return;
  try {
    const params = sender.getParameters();
    if (!params.encodings?.length) params.encodings = [{}];
    const settings = typeof track.getSettings === "function" ? track.getSettings() : {};
    const reported = Math.round(Number(settings.frameRate) || 0);
    const fps = Math.max(getScreenShareFps(), reported);
    const bitrate = screenShareBitrateForTrack(track);
    for (const enc of params.encodings) {
      enc.maxFramerate = fps;
      enc.maxBitrate = bitrate;
      enc.scaleResolutionDownBy = 1;
      enc.priority = "high";
    }
    const withPref = params as RTCRtpSendParameters & { degradationPreference?: string };
    withPref.degradationPreference = "maintain-framerate";
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

async function replaceSenderTrack(sender: RTCRtpSender, track: MediaStreamTrack | null) {
  try {
    await sender.replaceTrack(track);
  } catch {
    // PC мог закрыться во время смены трека
  }
}

/** После replaceTrack(null) на видео тот же mic-трек Chromium не перезапускает — слот нужно снять и вернуть. */
async function assignMicTrack(sender: RTCRtpSender, micTrack: MediaStreamTrack | null, tx?: RTCRtpTransceiver) {
  const stalled =
    !sender.track ||
    tx?.direction === "inactive" ||
    tx?.direction === "recvonly" ||
    tx?.currentDirection === "inactive" ||
    tx?.currentDirection === "recvonly";
  if (micTrack && stalled && sender.track) await replaceSenderTrack(sender, null);
  await replaceSenderTrack(sender, micTrack);
}

/** После остановки экрана камера снова идёт в основной video-слот. */
export async function restoreCameraAfterScreenShare(
  pc: RTCPeerConnection,
  cameraTrack: MediaStreamTrack | null,
  screenTrackId: string,
  localStream?: MediaStream
): Promise<boolean> {
  const senders = videoSenders(pc);
  const screenSender =
    senders.find((s) => s.track?.id === screenTrackId) ??
    senders.find((s) => s.track?.readyState === "ended") ??
    senders.find((s) => !s.track);
  const cameraSender = cameraTrack ? senders.find((s) => s.track?.id === cameraTrack.id) : undefined;

  if (cameraSender && (!screenSender || cameraSender === screenSender)) {
    if (screenSender && screenSender !== cameraSender) await replaceSenderTrack(screenSender, null);
    return false;
  }

  const primary = screenSender ?? senders.find((s) => s !== cameraSender) ?? senders[0];
  if (primary) {
    await replaceSenderTrack(primary, cameraTrack);
    if (cameraSender && cameraSender !== primary) await replaceSenderTrack(cameraSender, null);
    return false;
  }
  return replaceVideoTrackAsync(pc, cameraTrack, localStream);
}

/**
 * Вешает локальный трек на уже существующий transceiver.
 * addTrack только до первого remote description — иначе ломается порядок m-line в SDP.
 * @returns true, если трек некуда повесить и нужна поздняя renegotiation.
 */
export function bindLocalTrack(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  stream: MediaStream,
  canAddTrack: boolean
): boolean {
  if (track.readyState !== "live") return false;
  if (pc.getSenders().some((s) => s.track?.id === track.id)) return false;

  const matching =
    pc.getTransceivers().find((t) => {
      if (transceiverKind(t) !== track.kind) return false;
      if (t.direction === "recvonly" || t.currentDirection === "recvonly") return !t.sender.track;
      return !t.sender.track || t.sender.track.readyState === "ended";
    }) ?? pc.getTransceivers().find((t) => transceiverKind(t) === track.kind && !t.sender.track);

  if (matching) {
    void matching.sender.replaceTrack(track).catch(() => undefined);
    if (matching.direction === "recvonly" || matching.direction === "inactive") {
      try {
        matching.direction = "sendrecv";
      } catch {
        // direction может быть заблокирован в текущем signalingState
      }
    }
    if (track.kind === "audio" && !isScreenAudioSender(pc, matching.sender) && !micSenders.has(pc)) {
      rememberMicSender(pc, matching.sender);
      tuneMicrophoneSender(matching.sender);
    }
    return false;
  }

  if (!canAddTrack || pc.remoteDescription) {
    return true;
  }
  try {
    const sender = pc.addTrack(track, stream);
    if (track.kind === "audio" && !micSenders.has(pc)) {
      rememberMicSender(pc, sender);
      tuneMicrophoneSender(sender);
    }
  } catch {
    return false;
  }
  return false;
}

export function bindLocalTracks(
  pc: RTCPeerConnection,
  stream: MediaStream,
  shouldSend: (track: MediaStreamTrack) => boolean,
  canAddTrack: boolean
): boolean {
  let needsRenegotiate = false;
  for (const track of stream.getTracks()) {
    if (!shouldSend(track)) continue;
    if (bindLocalTrack(pc, track, stream, canAddTrack)) needsRenegotiate = true;
  }
  return needsRenegotiate;
}

export function isSdpOrderError(err: unknown): boolean {
  const msg = String(err);
  return msg.includes("m-line") || msg.includes("m-lines") || msg.includes("order of m-lines");
}

function outgoingAudioTransceivers(pc: RTCPeerConnection) {
  return pc.getTransceivers().filter((t) => {
    if (transceiverKind(t) !== "audio") return false;
    // Только direction=recvonly — чужой extra-audio. currentDirection=recvonly не фильтруем:
    // Chrome так помечает наш mic-слот после replaceTrack(null) на video.
    if (t.direction === "recvonly") return false;
    return true;
  });
}

/** После replaceTrack(null) на видео Chromium ставит mic-слот в recvonly и RTP молчит, пока не пересоздать direction. */
function reviveMicTransceiver(tx: RTCRtpTransceiver | undefined) {
  if (!tx) return false;
  const stalled =
    !tx.sender.track ||
    tx.direction === "inactive" ||
    tx.direction === "recvonly" ||
    tx.currentDirection === "inactive" ||
    tx.currentDirection === "recvonly";
  if (!stalled) return false;
  try {
    if (tx.direction === "sendrecv") tx.direction = "inactive";
    tx.direction = "sendrecv";
    return true;
  } catch {
    return false;
  }
}

/**
 * Подменяет только mic-трек, не трогая screen-audio и video-sender.
 * Всегда делает replaceTrack (даже тем же треком): после снятия камеры/экрана Chromium глохнет RTP.
 * @returns true если добавлен новый audio sender или сменён direction — нужна renegotiation.
 */
export async function replaceMicAudioTrack(
  pc: RTCPeerConnection,
  micTrack: MediaStreamTrack | null,
  isScreenAudio: (track: MediaStreamTrack) => boolean,
  localStream?: MediaStream
): Promise<boolean> {
  if (micTrack) {
    const already = pc.getSenders().find((s) => s.track?.id === micTrack.id);
    if (already && isScreenAudioSender(pc, already)) {
      await parkAudioSender(already);
    } else if (already && senderKind(pc, already) === "video") {
      await replaceSenderTrack(already, null);
    }
  }

  const remembered = micSenders.get(pc);
  if (remembered && !isScreenAudioSender(pc, remembered)) {
    const tx = pc.getTransceivers().find((t) => t.sender === remembered);
    const needsRenegotiate = reviveMicTransceiver(tx);
    await assignMicTrack(remembered, micTrack, tx);
    if (micTrack) {
      rememberMicSender(pc, remembered);
      tuneMicrophoneSender(remembered);
    }
    return needsRenegotiate;
  }

  const audioTx = outgoingAudioTransceivers(pc).filter(
    (t) => !isScreenAudioSender(pc, t.sender) && !isParkedSilentTrack(t.sender.track)
  );
  const notScreen = (t: RTCRtpTransceiver) =>
    !t.sender.track || (!isScreenAudio(t.sender.track) && !isParkedSilentTrack(t.sender.track));
  const micTx =
    audioTx.find((t) => t.sender.track && t.sender.track.readyState === "live" && notScreen(t)) ??
    audioTx.find((t) => t.sender.track && notScreen(t)) ??
    audioTx.find((t) => !t.sender.track);

  if (micTx) {
    const needsRenegotiate = reviveMicTransceiver(micTx);
    await assignMicTrack(micTx.sender, micTrack, micTx);
    if (micTrack) {
      rememberMicSender(pc, micTx.sender);
      tuneMicrophoneSender(micTx.sender);
    }
    return needsRenegotiate;
  }

  if (micTrack && localStream && !pc.remoteDescription) {
    try {
      const sender = pc.addTrack(micTrack, localStream);
      rememberMicSender(pc, sender);
      tuneMicrophoneSender(sender);
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

/** Добавляет отдельный audio track демонстрации экрана (параллельно с миком). */
export async function addScreenAudioTrack(
  pc: RTCPeerConnection,
  track: MediaStreamTrack,
  localStream: MediaStream
): Promise<boolean> {
  if (track.kind !== "audio") return false;
  if (!micSenders.has(pc)) {
    const liveMic = pc.getSenders().find((s) => s.track?.kind === "audio" && s.track.readyState === "live");
    if (liveMic) rememberMicSender(pc, liveMic);
  }
  const existing = pc.getSenders().find((s) => s.track?.id === track.id);
  if (existing) {
    rememberScreenAudioSender(pc, existing);
    return false;
  }
  const parked = screenAudioSenders.get(pc);
  if (parked && parked !== micSenders.get(pc)) {
    await replaceSenderTrack(parked, track);
    rememberScreenAudioSender(pc, parked);
    return false;
  }
  try {
    // addTransceiver не переиспользует пустой mic-sender (addTrack мог бы украсть слот микрофона).
    const sender = pc.addTransceiver(track, { direction: "sendrecv", streams: [localStream] }).sender;
    rememberScreenAudioSender(pc, sender);
    return true;
  } catch {
    try {
      const sender = pc.addTrack(track, localStream);
      rememberScreenAudioSender(pc, sender);
      return true;
    } catch {
      return false;
    }
  }
}

/** Отключает screen-audio sender без replaceTrack(null) — null на extra-audio в bundle глушит mic. */
export async function detachScreenAudioTrack(pc: RTCPeerConnection, track: MediaStreamTrack | null): Promise<boolean> {
  const sender =
    (track ? pc.getSenders().find((s) => s.track?.id === track.id) : undefined) ?? screenAudioSenders.get(pc);
  if (!sender || sender === micSenders.get(pc)) return false;
  rememberScreenAudioSender(pc, sender);
  await parkAudioSender(sender);
  return true;
}
