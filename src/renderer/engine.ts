import { Device, type types as MsTypes } from "mediasoup-client";
import { Muxer, ArrayBufferTarget } from "mp4-muxer";
import { api } from "./api";
import { duckShareAudio, openCameraTrack, openLocalMedia, watchLevel, type LocalMedia } from "./pipeline";
import { playCue } from "./sound";
import { dmChat, roomChat, type ChatMessage, type Settings, type SignalPayload } from "../shared/types";
import { callDirection, remoteVideoIsScreen, shouldLogCall } from "../shared/session";
import { canApplyAnswer, isPolitePeer, shouldIgnoreRemoteOffer } from "../shared/rtcOffer";

export interface Tile {
  id: string;
  peerId: string;
  name: string;
  source: "camera" | "screen" | "self";
  stream: MediaStream | null;
}

export interface EngineState {
  phase: "idle" | "calling" | "incoming" | "active";
  mode: "p2p" | "conf" | null;
  peerId: string;
  roomId: string;
  hostId: string;
  video: boolean;
  micOn: boolean;
  camOn: boolean;
  shareOn: boolean;
  started: number;
  incoming?: { peerId: string; name: string; video: boolean; callId: string };
  tiles: Tile[];
  stageId: string;
  pinnedId: string;
  levels: Record<string, number>;
  recording: boolean;
  recorders: string[];
  link: number;
  selfId: string;
  selfName: string;
  error: string;
  invite?: { roomId: string; name: string; password: string; hostId: string; from: string };
  controlAsk?: { peerId: string; name: string };
  controlling: boolean;
  controlled: boolean;
  controlPeerId: string;
  controlPending: boolean;
  controlSize: { w: number; h: number };
  controlGrant: string;
  controlledBy: string;
  recStarted: number;
  recTimes: Record<string, number>;
  mutedPeers: string[];
}

type Listener = () => void;

interface ConfConsumer {
  id: string;
  peerId: string;
  source: string;
  kind: string;
  consumer: MsTypes.Consumer;
  audio?: { stop: () => void; setVolume: (value: number) => void };
}

interface ShareMix {
  track: MediaStreamTrack;
  setCamera: (track: MediaStreamTrack | null) => void;
  stop: () => void;
}

class Engine {
  private listeners = new Set<Listener>();
  state: EngineState = emptyState();
  private settings: Settings | null = null;
  private local?: LocalMedia;
  private pc?: RTCPeerConnection;
  private dc?: RTCDataChannel;
  private desk?: RTCDataChannel;
  private dcWaiters: Array<(channel: RTCDataChannel) => void> = [];
  private screenWait = 0;
  private remoteStream = new MediaStream();
  private remoteAudio?: { stop: () => void; setVolume: (value: number) => void };
  private shareAudio?: { stop: () => void; setVolume: (value: number) => void };
  private callId = "";
  private device?: Device;
  private sendTransport?: MsTypes.Transport;
  private recvTransport?: MsTypes.Transport;
  private consumers = new Map<string, ConfConsumer>();
  private producers: MsTypes.Producer[] = [];
  private screenTrack?: MediaStreamTrack;
  private rawScreen?: MediaStreamTrack;
  private shareMix?: ShareMix;
  private screenSender?: RTCRtpSender;
  private screenAudioSender?: RTCRtpSender;
  private screenProducer?: MsTypes.Producer;
  private screenAudioProducer?: MsTypes.Producer;
  private screenAudioTrack?: MediaStreamTrack;
  private shareCleanup?: () => void;
  private shareDuck?: { stop: () => void; setSendGain: (value: number) => void };
  private shareSources: string[] = [];
  private deskSourceId = "";
  private deskPc?: RTCPeerConnection;
  private deskCapture?: { stop: () => void };
  private deskTrack?: MediaStreamTrack;
  private deskGen = 0;
  private cameraStop?: () => void;
  private cameraSender?: RTCRtpSender;
  private cameraProducer?: MsTypes.Producer;
  private micProducer?: MsTypes.Producer;
  private micHealAt = 0;
  private expectScreenId = "";
  private offerLock = false;
  private makingOffer = false;
  private wantOffer = false;
  private sdpQueue: Promise<void> = Promise.resolve();
  private lastDownAt = 0;
  private negotiateAfter = 0;
  private mediaReady = false;
  private lastControlAt = 0;
  private controlGrant = "";
  private ringTimer = 0;
  private recordTimer = 0;
  private recorder?: {
    muxer: Muxer<ArrayBufferTarget>;
    video: VideoEncoder;
    audio: AudioEncoder;
    canvas: HTMLCanvasElement;
    stop: () => void;
    audioTs: number;
    pcm: Float32Array;
  };
  private stageHold = "";
  private stageSince = 0;
  private remoteName = "";
  private placeName = "";
  private notedCall = false;
  private leaving = false;
  private callWay: "in" | "out" | undefined;
  private callLogged = false;
  private transfers = new Map<string, { got: number; size: number; chunks: Uint8Array[] }>();
  private fileLinks = new Map<string, { pc: RTCPeerConnection; dc?: RTCDataChannel; waiters: Array<(channel: RTCDataChannel) => void> }>();
  private fileOffering = new Set<string>();
  private recordVideo?: HTMLVideoElement;
  private recordAlive = false;
  private linkTimer = 0;

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setIdentity(id: string, name: string, settings: Settings): void {
    this.state.selfId = id;
    this.state.selfName = name;
    this.settings = settings;
    this.remoteAudio?.setVolume(settings.peerVolume);
    this.applyShareVolume(settings.shareVolume);
    this.local?.applyVoice({ vad: settings.vad, vadSensitivity: settings.vadSensitivity, micGain: settings.micGain ?? 1 });
    for (const item of this.consumers.values()) {
      if (item.source !== "screen") item.audio?.setVolume(settings.peerVolume);
    }
  }

  applyShareVolume(value: number): void {
    const volume = Math.min(1, Math.max(0, value));
    if (this.settings) this.settings = { ...this.settings, shareVolume: volume };
    this.shareAudio?.setVolume(volume);
    this.shareDuck?.setSendGain(volume);
    for (const item of this.consumers.values()) {
      if (item.source === "screen") item.audio?.setVolume(volume);
    }
  }

  start(): void {
    api.on((event) => this.onEvent(event));
  }

  private patch(partial: Partial<EngineState>): void {
    const nextPhase = partial.phase;
    this.state = { ...this.state, ...partial };
    this.listeners.forEach((listener) => listener());
    if (nextPhase === "active" || nextPhase === "calling") this.ensureLink();
    if (nextPhase === "idle" || nextPhase === "incoming") this.stopLink();
  }

  private ensureLink(): void {
    if (this.linkTimer) return;
    this.linkTimer = window.setInterval(() => { void this.sampleLink(); }, 900);
    void this.sampleLink();
  }

  private stopLink(): void {
    window.clearInterval(this.linkTimer);
    this.linkTimer = 0;
  }

  private async sampleLink(): Promise<void> {
    if (this.state.phase !== "active" && this.state.phase !== "calling") return;
    const reports: RTCStatsReport[] = [];
    try {
      if (this.pc) reports.push(await this.pc.getStats());
    } catch { /* stats are optional */ }
    for (const producer of this.producers) {
      try { reports.push(await producer.getStats()); } catch { /* a closed producer */ }
    }
    let rtt = Number.POSITIVE_INFINITY;
    for (const report of reports) {
      report.forEach((row) => {
        const stat = row as { type?: string; state?: string; currentRoundTripTime?: number; roundTripTime?: number };
        if (stat.type === "candidate-pair" && stat.state === "succeeded" && typeof stat.currentRoundTripTime === "number") rtt = Math.min(rtt, stat.currentRoundTripTime);
        if (stat.type === "remote-inbound-rtp" && typeof stat.roundTripTime === "number") rtt = Math.min(rtt, stat.roundTripTime);
      });
    }
    let bars = 0;
    if (Number.isFinite(rtt)) {
      if (rtt > 0.28) bars = 1;
      else if (rtt > 0.14) bars = 2;
      else if (rtt > 0.06) bars = 3;
      else bars = 4;
    }
    if (bars !== this.state.link) this.patch({ link: bars });
  }

  private onEvent(event: any): void {
    if (event.t === "signal") this.onSignal(event.peerId, event.payload as SignalPayload);
    if (event.t === "producer") void this.onProducer(event);
    if (event.t === "producer-closed") this.removeTile(event.producerId);
    if (event.t === "conf-end" && this.state.mode === "conf" && (!event.roomId || event.roomId === this.state.roomId)) void this.leaveConference(false);
    if (event.t === "room-closed" && event.roomId && event.roomId === this.state.roomId) void this.leaveConference(false);
    if (event.t === "conf-peer-left") this.dropPeer(String(event.peerId || ""));
    if (event.t === "conf-recording") {
      const ids = new Set(this.state.recorders);
      const times = { ...this.state.recTimes };
      const peerId = String(event.peerId);
      if (event.on) {
        ids.add(peerId);
        times[peerId] = Number(event.started) || Date.now();
      } else {
        ids.delete(peerId);
        delete times[peerId];
      }
      this.patch({ recorders: [...ids], recTimes: times });
    }
    if (event.t === "resend-file") void this.pumpFile(event.peerId, event.message as ChatMessage);
  }

  private onSignal(peerId: string, payload: SignalPayload): void {
    if (payload.t === "game") return;
    if (payload.t === "conf-invite") {
      this.patch({ invite: { roomId: payload.roomId, name: payload.name, password: payload.password, hostId: payload.hostId, from: payload.from } });
      playCue("join", this.settings);
      return;
    }
    if (payload.t === "call-invite") {
      this.callId = this.state.phase === "idle" ? payload.callId : this.callId;
      const incoming = { peerId, name: payload.name, video: payload.video, callId: payload.callId };
      if (this.state.phase === "idle") {
        this.callId = payload.callId;
        this.callWay = "in";
        this.callLogged = false;
        this.slog("call-in", { peerId, name: payload.name });
        this.patch({ phase: "incoming", mode: "p2p", peerId, video: payload.video, incoming });
      } else {
        this.patch({ incoming });
      }
      this.ring();
      return;
    }
    if (payload.t === "call-answer") {
      window.clearInterval(this.ringTimer);
      if (!payload.accept) {
        this.resetCall();
        return;
      }
      this.slog("call-answered", { peerId });
      void this.beginMedia();
      return;
    }
    if (payload.t === "call-end") {
      this.resetCall();
      return;
    }
    if (payload.t === "screen") {
      if (!payload.on) {
        this.expectScreenId = "";
        this.shareAudio?.stop();
        this.shareAudio = undefined;
        this.patch({ tiles: this.state.tiles.filter((tile) => tile.id !== `screen:${peerId}`) });
        this.slog("screen-off", { peerId });
        return;
      }
      this.expectScreenId = payload.streamId || "screen";
      this.slog("screen-on", { peerId, streamId: this.expectScreenId, videos: this.remoteStream.getVideoTracks().length });
      this.waitForScreen(peerId);
      return;
    }
    if (payload.t === "mute") {
      if (payload.target && payload.target !== this.state.selfId) return;
      if (peerId === this.state.selfId) return;
      this.local?.setMic(!payload.on);
      this.patch({ micOn: !payload.on });
      return;
    }
    if (payload.t === "mic") {
      const muted = new Set(this.state.mutedPeers);
      if (payload.on) muted.delete(peerId);
      else muted.add(peerId);
      this.patch({ mutedPeers: [...muted] });
      return;
    }
    if (payload.t === "control-ask") {
      const name = payload.name || this.peerName(peerId);
      this.patch({ controlAsk: { peerId, name } });
      return;
    }
    if (payload.t === "control-answer") {
      if (payload.accept && payload.grant) {
        this.controlGrant = payload.grant;
        this.patch({
          controlling: true,
          controlPending: false,
          controlPeerId: peerId,
          controlGrant: payload.grant,
          controlSize: { w: payload.width || 1920, h: payload.height || 1080 },
        });
        this.slog("control-granted", { peerId, grant: payload.grant.slice(0, 8), w: payload.width, h: payload.height });
        void this.deskOffer(peerId);
      } else {
        this.slog("control-denied", { peerId });
        this.finishControl(false);
      }
      return;
    }
    if (payload.t === "control-end") {
      this.finishControl(false);
      return;
    }
    if (payload.t === "control-input" && this.state.controlled) {
      if (!this.controlGrant || (payload.grant && payload.grant !== this.controlGrant)) return;
      void api.invoke("injectInput", {
        t: payload.kind,
        grant: this.controlGrant,
        x: payload.x,
        y: payload.y,
        nx: payload.nx,
        ny: payload.ny,
        w: payload.w || this.state.controlSize.w,
        h: payload.h || this.state.controlSize.h,
        button: payload.button,
        delta: payload.delta,
        key: payload.key,
        down: payload.down,
      });
      return;
    }
    if (payload.t === "recording") {
      const ids = new Set(this.state.recorders);
      const times = { ...this.state.recTimes };
      if (payload.on) {
        ids.add(peerId);
        times[peerId] = payload.started || Date.now();
      } else {
        ids.delete(peerId);
        delete times[peerId];
      }
      this.patch({ recorders: [...ids], recTimes: times });
      return;
    }
    if (payload.t === "offer" || payload.t === "answer" || payload.t === "ice" || payload.t === "please-offer") {
      if (payload.purpose === "file") void this.onFileRtc(peerId, payload);
      else if (payload.purpose === "desk") void this.onDeskRtc(peerId, payload);
      else void this.onRtc(peerId, payload);
    }
  }

  async call(peerId: string, _video = false, name = ""): Promise<void> {
    this.remoteName = name;
    if (this.state.phase !== "idle") return;
    this.callId = crypto.randomUUID();
    this.callWay = "out";
    this.callLogged = false;
    this.slog("call-out", { peerId, name });
    this.patch({ phase: "calling", mode: "p2p", peerId, video: false, micOn: !this.settings?.joinMuted, camOn: false, started: 0 });
    await api.invoke("setBusy", { inCall: true, mode: "call" });
    await api.invoke("signal", { peerId, payload: { t: "call-invite", callId: this.callId, video: false, name: this.state.selfName } });
    this.ring();
  }

  async accept(): Promise<void> {
    const incoming = this.state.incoming;
    if (!incoming) return;
    window.clearInterval(this.ringTimer);
    if (this.state.mode === "conf" && this.state.phase === "active") {
      await this.hangup();
      this.patch({ incoming, phase: "incoming", mode: "p2p", peerId: incoming.peerId });
    }
    this.callWay = "in";
    this.callLogged = false;
    this.slog("call-accept", { peerId: incoming.peerId });
    this.patch({ phase: "active", incoming: undefined, started: Date.now(), micOn: !this.settings?.joinMuted, camOn: false, video: false, mode: "p2p", peerId: incoming.peerId });
    await api.invoke("setBusy", { inCall: true, mode: "call" });
    await api.invoke("signal", { peerId: incoming.peerId, payload: { t: "call-answer", callId: incoming.callId, accept: true } });
    await this.beginMedia();
  }

  decline(): void {
    const incoming = this.state.incoming;
    if (!incoming) return;
    window.clearInterval(this.ringTimer);
    void api.invoke("signal", { peerId: incoming.peerId, payload: { t: "call-answer", callId: incoming.callId, accept: false } });
    if (this.state.phase === "incoming") this.resetCall();
    else this.patch({ incoming: undefined });
  }

  async hangup(): Promise<void> {
    const active = this.state.phase === "active";
    if (this.recorder) await this.stopRecord();
    if (this.state.mode === "conf") {
      const chatId = roomChat(this.state.roomId);
      const host = !this.state.hostId || this.state.hostId === this.state.selfId;
      if (active && !host) this.note(chatId, `sys:leave-conf\t${this.state.selfName}\t${this.placeName}`);
      if (!host) {
        await this.leaveConference(true);
        return;
      }
      try {
        await api.invoke("confEnd");
      } catch {
        /* host may already be gone; this client still leaves */
      }
      await this.leaveConference(false);
      return;
    }
    const peerId = this.state.peerId;
    if (active && peerId) this.note(dmChat(peerId), `sys:leave-call\t${this.state.selfName}`);
    if (peerId) {
      try {
        if (this.dc?.readyState === "open") this.dc.send(JSON.stringify({ t: "call-end", callId: this.callId }));
      } catch { /* channel already down */ }
      await api.invoke("signal", { peerId, payload: { t: "call-end", callId: this.callId } });
    }
    this.resetCall();
  }

  private ring(): void {
    window.clearInterval(this.ringTimer);
    if (!this.settings?.callSound) return;
    const settings = this.settings;
    const ring = () => playCue("call", settings);
    ring();
    this.ringTimer = window.setInterval(ring, 1800);
  }

  private async beginMedia(): Promise<void> {
    window.clearInterval(this.ringTimer);
    if (!this.settings) return;
    this.local = await openLocalMedia(this.settings, false);
    const pc = this.ensurePc(this.state.peerId);
    if (!this.state.micOn) this.local.setMic(false);
    for (const track of this.local.stream.getTracks()) {
      const sender = pc.addTrack(track, this.local.stream);
      if (track.kind === "audio") favorAudioSender(sender);
    }
    this.mediaReady = true;
    await this.renegotiate(this.state.peerId);
    this.patch({
      phase: "active",
      started: this.state.started || Date.now(),
      tiles: [this.selfTile(), { id: this.state.peerId, peerId: this.state.peerId, name: "", source: "camera", stream: this.remoteStream }],
      stageId: this.state.peerId,
    });
    this.localLevelLoop();
    this.tellMic(this.state.micOn);
    if (!this.notedCall && this.state.peerId) {
      this.notedCall = true;
      this.note(dmChat(this.state.peerId), `sys:join-call\t${this.state.selfName}`);
    }
  }

  private selfTile(): Tile {
    return {
      id: "self",
      peerId: this.state.selfId,
      name: this.state.selfName,
      source: "self",
      stream: this.local?.preview ?? null,
    };
  }

  private localLevelLoop(): void {
    window.setInterval(() => {
      if (!this.local || this.state.phase !== "active") return;
      const level = this.local.level();
      this.patch({ levels: { ...this.state.levels, [this.state.selfId]: level } });
      this.pickStage();
      if (this.state.micOn) void this.healMic();
    }, 120);
  }

  private farEndTalking(): number {
    const self = this.state.selfId;
    let peak = 0;
    for (const [id, value] of Object.entries(this.state.levels)) {
      if (id === self) continue;
      if (value > peak) peak = value;
    }
    return peak;
  }

  private async healMic(): Promise<void> {
    const local = this.local;
    if (!local || !this.state.micOn) return;
    const health = local.health();
    if (!health.running || health.muted) await local.resume();
    if (!health.ended) return;
    const now = performance.now();
    if (now - this.micHealAt < 2000) return;
    this.micHealAt = now;
    try {
      await local.recapture();
      await local.resume();
    } catch {
      /* the microphone is busy with the screen capture; the next pass tries again */
    }
  }

  private ensurePc(peerId: string): RTCPeerConnection {
    if (this.pc) return this.pc;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.pc = pc;
    const screen = pc.addTransceiver("video", { direction: "recvonly" });
    this.screenSender = screen.sender;
    const offerer = this.state.selfId < peerId;
    if (offerer) this.bindChannel(pc.createDataChannel("files"));
    pc.ondatachannel = (event) => this.bindChannel(event.channel);
    pc.onicecandidate = (event) => {
      void api.invoke("signal", { peerId, payload: { t: "ice", candidate: event.candidate ? event.candidate.toJSON() : null } });
    };
    pc.ontrack = (event) => {
      const track = event.track;
      const streamId = event.streams[0]?.id ?? "";
      const videos = this.remoteStream.getVideoTracks();
      const shareVideo = track.kind === "video" && remoteVideoIsScreen({
        expectScreen: Boolean(this.expectScreenId) && (this.expectScreenId === "screen" || streamId === this.expectScreenId || !streamId),
        controlling: this.state.controlling && this.state.controlPeerId === peerId,
        remoteVideoCount: videos.length,
        hasCameraTile: this.state.tiles.some((tile) => tile.peerId === peerId && tile.source === "camera" && Boolean(tile.stream)),
      });
      this.slog("ontrack", { peerId, kind: track.kind, streamId, shareVideo, expect: this.expectScreenId, controlling: this.state.controlling, videos: videos.length, muted: track.muted });
      if (track.kind === "video") {
        const useScreen = shareVideo || this.state.controlling || this.expectScreenId === "screen" || screen.receiver.track === track;
        track.addEventListener("unmute", () => {
          if (this.state.controlling || this.expectScreenId) this.showRemoteScreen(peerId, track);
        });
        if (useScreen) {
          this.showRemoteScreen(peerId, track);
          return;
        }
      }
      const shareAudio = track.kind === "audio" && (
        Boolean(this.expectScreenId)
        && (streamId === this.expectScreenId || this.expectScreenId === "screen" || Boolean(this.remoteAudio))
      );
      if (shareAudio) {
        this.shareAudio?.stop();
        this.shareAudio = watchLevel(track, () => undefined, this.settings?.shareVolume ?? 1, this.settings?.speakerId ?? "", () => this.state.levels[this.state.selfId] ?? 0);
        return;
      }
      this.remoteStream.addTrack(track);
      if (track.kind === "audio") {
        this.remoteAudio?.stop();
        this.remoteAudio = watchLevel(track, (level) => {
          this.patch({ levels: { ...this.state.levels, [peerId]: level } });
          this.pickStage();
        }, this.settings?.peerVolume ?? 1, this.settings?.speakerId ?? "");
      }
      this.patch({ tiles: this.withCameraTiles(peerId) });
    };
    pc.onnegotiationneeded = () => {
      if (!this.mediaReady || Date.now() < this.negotiateAfter) return;
      void this.renegotiate(peerId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
        window.setTimeout(() => {
          if (this.pc === pc && (pc.connectionState === "failed" || pc.connectionState === "disconnected") && this.state.mode === "p2p" && this.state.phase === "active") {
            void this.hangup();
          }
        }, 2500);
      }
    };
    return pc;
  }

  private runSdp(task: () => Promise<void>): Promise<void> {
    const next = this.sdpQueue.then(task, task);
    this.sdpQueue = next.catch(() => undefined);
    return next;
  }

  private async renegotiate(peerId: string): Promise<void> {
    if (!peerId || !this.pc) return;
    if (this.makingOffer || this.pc.signalingState !== "stable") {
      this.wantOffer = true;
      return;
    }
    this.wantOffer = false;
    await this.runSdp(() => this.offer(peerId));
  }

  private drainOffer(peerId: string): void {
    if (!this.wantOffer || this.makingOffer || this.pc?.signalingState !== "stable") return;
    const wait = this.negotiateAfter - Date.now();
    if (wait > 0) {
      window.setTimeout(() => this.drainOffer(peerId), wait + 30);
      return;
    }
    this.wantOffer = false;
    void this.runSdp(() => this.offer(peerId));
  }

  private async offer(peerId: string): Promise<void> {
    if (!this.pc || this.makingOffer) {
      this.wantOffer = true;
      return;
    }
    if (this.pc.signalingState !== "stable") {
      this.wantOffer = true;
      return;
    }
    this.makingOffer = true;
    this.offerLock = true;
    try {
      const description = await this.pc.createOffer();
      if (!this.pc || this.pc.signalingState !== "stable") {
        this.wantOffer = true;
        return;
      }
      await this.pc.setLocalDescription(description);
      this.negotiateAfter = Date.now() + 1500;
      await api.invoke("signal", { peerId, payload: { t: "offer", sdp: this.pc.localDescription?.sdp ?? description.sdp ?? "" } });
      this.slog("offer-sent", { state: this.pc.signalingState });
    } catch (error) {
      this.slog("offer-fail", { error: String(error), state: this.pc?.signalingState || "" });
      this.wantOffer = true;
    } finally {
      this.makingOffer = false;
      this.offerLock = false;
      this.drainOffer(peerId);
    }
  }

  private async onRtc(peerId: string, payload: SignalPayload): Promise<void> {
    if (payload.t === "ice") {
      const pc = this.ensurePc(peerId);
      if (payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate);
        } catch {
          /* candidate can arrive early */
        }
      }
      return;
    }
    if (payload.t === "please-offer" || payload.t === "offer" || payload.t === "answer") {
      await this.runSdp(() => this.applySdp(peerId, payload));
    }
  }

  private async applySdp(peerId: string, payload: SignalPayload): Promise<void> {
    const pc = this.ensurePc(peerId);
    if (payload.t === "please-offer") {
      this.wantOffer = true;
      this.drainOffer(peerId);
      return;
    }
    if (payload.t === "offer") {
      const polite = isPolitePeer(this.state.selfId, peerId);
      if (shouldIgnoreRemoteOffer({ makingOffer: this.makingOffer, signalingState: pc.signalingState, polite })) {
        this.slog("offer-ignore", { state: pc.signalingState, polite });
        return;
      }
      try {
        const rolled = pc.signalingState !== "stable";
        if (rolled) await pc.setLocalDescription({ type: "rollback" });
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        this.negotiateAfter = Date.now() + 1500;
        await api.invoke("signal", { peerId, payload: { t: "answer", sdp: pc.localDescription?.sdp ?? answer.sdp ?? "" } });
        this.slog("answer-sent", { state: pc.signalingState });
        if (rolled) this.wantOffer = true;
        this.drainOffer(peerId);
      } catch (error) {
        this.slog("answer-fail", { error: String(error), state: pc.signalingState });
        this.wantOffer = true;
      }
      return;
    }
    if (payload.t === "answer") {
      try {
        if (!canApplyAnswer(pc.signalingState)) {
          this.slog("answer-skip", { state: pc.signalingState });
          return;
        }
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        this.negotiateAfter = Date.now() + 1500;
        this.slog("answer-ok", { state: pc.signalingState });
        this.drainOffer(peerId);
      } catch (error) {
        this.slog("answer-fail", { error: String(error), state: pc.signalingState });
        try {
          if (pc.signalingState === "have-local-offer") await pc.setLocalDescription({ type: "rollback" });
        } catch {
          /* already closed */
        }
        this.wantOffer = true;
        this.drainOffer(peerId);
      }
    }
  }

  private bindChannel(channel: RTCDataChannel): void {
    this.dc = channel;
    channel.binaryType = "arraybuffer";
    channel.onopen = () => this.dcWaiters.splice(0).forEach((waiter) => waiter(channel));
    channel.onmessage = (event) => void this.onFileMessage(event);
  }

  private bindDesk(channel: RTCDataChannel): void {
    this.desk = channel;
    channel.binaryType = "arraybuffer";
    channel.onmessage = (event) => {
      if (typeof event.data !== "string") return;
      try {
        const body = JSON.parse(event.data) as SignalPayload;
        if (body.t === "control-input") this.onSignal(this.state.controlPeerId || this.state.peerId, body);
      } catch {
        /* ignore */
      }
    };
  }

  private fileLink(peerId: string): { pc: RTCPeerConnection; dc?: RTCDataChannel; waiters: Array<(channel: RTCDataChannel) => void> } {
    const existing = this.fileLinks.get(peerId);
    if (existing && existing.pc.connectionState !== "closed" && existing.pc.connectionState !== "failed") return existing;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    const link: { pc: RTCPeerConnection; dc?: RTCDataChannel; waiters: Array<(channel: RTCDataChannel) => void> } = { pc, waiters: [] };
    this.fileLinks.set(peerId, link);
    const bind = (channel: RTCDataChannel) => {
      link.dc = channel;
      channel.binaryType = "arraybuffer";
      channel.onopen = () => link.waiters.splice(0).forEach((waiter) => waiter(channel));
      channel.onmessage = (event) => void this.onFileMessage(event);
    };
    pc.onicecandidate = (event) => {
      void api.invoke("signal", { peerId, payload: { t: "ice", candidate: event.candidate ? event.candidate.toJSON() : null, purpose: "file" } });
    };
    pc.onnegotiationneeded = () => {
      if (this.state.selfId < peerId && pc.signalingState === "stable") void this.fileOffer(peerId);
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.fileLinks.delete(peerId);
    };
    if (this.state.selfId < peerId) bind(pc.createDataChannel("files"));
    pc.ondatachannel = (event) => bind(event.channel);
    return link;
  }

  private async fileOffer(peerId: string): Promise<void> {
    const link = this.fileLinks.get(peerId);
    if (!link || this.fileOffering.has(peerId)) return;
    this.fileOffering.add(peerId);
    try {
      const description = await link.pc.createOffer();
      await link.pc.setLocalDescription(description);
      await api.invoke("signal", { peerId, payload: { t: "offer", sdp: description.sdp ?? "", purpose: "file" } });
    } catch (error) {
      console.error(error);
    } finally {
      this.fileOffering.delete(peerId);
    }
  }

  private async onFileRtc(peerId: string, payload: SignalPayload): Promise<void> {
    const link = this.fileLink(peerId);
    if (payload.t === "please-offer") {
      await this.fileOffer(peerId);
      return;
    }
    if (payload.t === "offer") {
      await link.pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
      const answer = await link.pc.createAnswer();
      await link.pc.setLocalDescription(answer);
      await api.invoke("signal", { peerId, payload: { t: "answer", sdp: answer.sdp ?? "", purpose: "file" } });
      return;
    }
    if (payload.t === "answer") {
      await link.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
      return;
    }
    if (payload.t === "ice" && payload.candidate) {
      try {
        await link.pc.addIceCandidate(payload.candidate);
      } catch {
        /* candidate can arrive early */
      }
    }
  }

  private waitDc(peerId: string): Promise<RTCDataChannel> {
    const link = this.fileLink(peerId);
    if (link.dc && link.dc.readyState === "open") return Promise.resolve(link.dc);
    if (this.state.selfId > peerId) void api.invoke("signal", { peerId, payload: { t: "please-offer", purpose: "file" } });
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => reject(new Error("file channel")), 12000);
      link.waiters.push((channel) => {
        window.clearTimeout(timer);
        resolve(channel);
      });
    });
  }

  async transfer(peerId: string, message: ChatMessage): Promise<void> {
    if (!message.file?.sourcePath) return;
    const channel = await this.waitDc(peerId);
    const transferId = message.file.transferId;
    const size = message.file.size;
    channel.send(JSON.stringify({ t: "begin", transferId, size }));
    let offset = 0;
    while (offset < size) {
      const slice = await api.invoke<{ bytes: Uint8Array; eof: boolean }>("readSlice", { path: message.file.sourcePath, offset, length: 65536 });
      const bytes = slice.bytes instanceof Uint8Array ? slice.bytes : new Uint8Array(slice.bytes);
      if (!bytes.byteLength) break;
      while (channel.bufferedAmount > 1_000_000) await wait(30);
      const copy = new ArrayBuffer(bytes.byteLength);
      new Uint8Array(copy).set(bytes);
      channel.send(copy);
      offset += bytes.byteLength;
      if (slice.eof) break;
    }
    channel.send(JSON.stringify({ t: "end", transferId }));
  }

  private async pumpFile(peerId: string, message: ChatMessage): Promise<void> {
    try {
      await this.transfer(peerId, message);
    } catch (error) {
      console.error(error);
    }
  }

  private async onFileMessage(event: MessageEvent): Promise<void> {
    if (typeof event.data === "string") {
      const body = JSON.parse(event.data) as { t: string; transferId?: string; size?: number; kind?: string; x?: number; y?: number; nx?: number; ny?: number; w?: number; h?: number; button?: number; delta?: number; key?: string; down?: boolean; grant?: string };
      if (body.t === "control-input" && this.state.controlled) {
        if (this.controlGrant && body.grant && body.grant !== this.controlGrant) return;
        void api.invoke("injectInput", { t: body.kind, grant: this.controlGrant, x: body.x, y: body.y, nx: body.nx, ny: body.ny, w: body.w, h: body.h, button: body.button, delta: body.delta, key: body.key, down: body.down });
        return;
      }
      if (body.t === "call-end") {
        this.resetCall();
        return;
      }
      if (body.t === "begin" && body.transferId) this.transfers.set(body.transferId, { got: 0, size: body.size ?? 0, chunks: [] });
      if (body.t === "end" && body.transferId) await this.flushTransfer(body.transferId, true);
      if (body.t === "cancel") {
        if (body.transferId) {
          this.transfers.delete(body.transferId);
          await api.invoke("fileCancel", { transferId: body.transferId });
        }
      }
      return;
    }
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    const current = [...this.transfers.values()].at(-1);
    const id = [...this.transfers.keys()].at(-1);
    if (!current || !id) return;
    current.chunks.push(bytes);
    current.got += bytes.byteLength;
    if (current.chunks.reduce((sum, item) => sum + item.byteLength, 0) >= 262144) await this.flushTransfer(id, false);
  }

  private async flushTransfer(transferId: string, end: boolean): Promise<void> {
    const current = this.transfers.get(transferId);
    if (!current) return;
    const chunk = concat(current.chunks);
    current.chunks = [];
    await api.invoke("fileChunk", { transferId, chunk, end });
    if (end) this.transfers.delete(transferId);
  }

  async toggleMic(): Promise<void> {
    const micOn = !this.state.micOn;
    this.local?.setMic(micOn);
    this.patch({ micOn });
    this.tellMic(micOn);
    if (this.state.mode === "conf" && this.micProducer && !this.micProducer.closed) {
      if (micOn) await this.micProducer.resume().catch(() => undefined);
      else await this.micProducer.pause().catch(() => undefined);
    }
  }

  async mutePeer(peerId: string, on = true): Promise<void> {
    if (!peerId || peerId === this.state.selfId) return;
    const muted = new Set(this.state.mutedPeers);
    if (on) muted.add(peerId);
    else muted.delete(peerId);
    this.patch({ mutedPeers: [...muted] });
    if (this.state.mode === "conf") {
      const hostId = this.state.hostId === this.state.selfId ? undefined : this.state.hostId;
      await api.invoke("sfu", { op: "muteAudio", hostId, data: { peerId, on } }).catch(() => undefined);
    }
    await api.invoke("signal", { peerId, payload: { t: "mute", on, target: peerId } });
  }

  async askControl(peerId = ""): Promise<void> {
    const target = peerId || this.controlTarget();
    if (!target || target === this.state.selfId) return;
    this.patch({ controlPending: true, controlPeerId: target });
    this.slog("control-ask", { target });
    this.note(this.chatWith(target), `sys:control-ask\t${this.state.selfName}`);
    await api.invoke("signal", { peerId: target, payload: { t: "control-ask", name: this.state.selfName } });
  }

  async answerControl(accept: boolean, sourceId = ""): Promise<void> {
    const ask = this.state.controlAsk;
    if (!ask) return;
    const peerId = ask.peerId;
    const name = ask.name || this.peerName(peerId);
    if (!accept) {
      this.note(this.chatWith(peerId), `sys:control-no\t${name}`);
      this.slog("control-answer", { accept: false, peerId });
      await api.invoke("signal", { peerId, payload: { t: "control-answer", accept: false } });
      this.finishControl(true);
      return;
    }
    const sources = await api.invoke<Array<{ id: string; width: number; height: number; x?: number; y?: number; primary?: boolean }>>("screenSources");
    const screens = sources.filter((item) => item.id.startsWith("screen:"));
    const screen = screens.find((item) => item.id === sourceId) || this.pickDesk(screens);
    const opened = screen ? await this.openShareTracks([screen.id], false) : null;
    this.slog("control-sources", { count: screens.length, id: screen?.id || "", w: screen?.width, h: screen?.height, x: screen?.x, y: screen?.y, primary: Boolean(screen?.primary) });
    if (!screen || !opened) {
      this.note(this.chatWith(peerId), `sys:control-no\t${name}`);
      await api.invoke("signal", { peerId, payload: { t: "control-answer", accept: false } });
      this.finishControl(true);
      return;
    }
    const grant = crypto.randomUUID();
    const width = screen.width || 1920;
    const height = screen.height || 1080;
    this.stopDeskCapture();
    this.deskTrack = opened.video;
    this.deskCapture = { stop: opened.stop };
    this.deskSourceId = screen.id;
    this.controlGrant = grant;
    opened.video.onended = () => {
      if (this.deskTrack === opened.video) this.stopControl();
    };
    this.armDeskHost(peerId, opened.video);
    const id = `screen:${this.state.selfId}`;
    const tiles = this.state.tiles.filter((tile) => tile.id !== id);
    tiles.push({ id, peerId: this.state.selfId, name: this.state.selfName, source: "screen", stream: new MediaStream([opened.video]) });
    this.patch({
      controlAsk: undefined,
      controlled: true,
      controlPeerId: peerId,
      controlGrant: grant,
      controlledBy: name,
      controlSize: { w: width, h: height },
      tiles,
      stageId: id,
      shareOn: true,
    });
    this.note(this.chatWith(peerId), `sys:control-ok\t${name}`);
    this.slog("control-answer", { accept: true, peerId, grant: grant.slice(0, 8) });
    await api.invoke("injectInput", { t: "begin", grant, ox: screen.x || 0, oy: screen.y || 0, sw: width, sh: height });
    await api.invoke("signal", { peerId, payload: { t: "control-answer", accept: true, width, height, grant } });
    void api.invoke("setBusy", { sharing: true });
  }

  sendControl(payload: Extract<SignalPayload, { t: "control-input" }>): void {
    const peerId = this.state.controlPeerId || this.state.peerId;
    if (!this.state.controlling || !peerId || !this.controlGrant) return;
    if (payload.kind === "move") {
      if (Date.now() - this.lastControlAt < 16) return;
      this.lastControlAt = Date.now();
    }
    if (payload.kind === "down") {
      if (Date.now() - this.lastDownAt < 40) return;
      this.lastDownAt = Date.now();
    }
    const packed = {
      ...payload,
      grant: this.controlGrant,
      w: this.state.controlSize.w,
      h: this.state.controlSize.h,
    };
    if (this.desk?.readyState === "open") {
      try {
        this.desk.send(JSON.stringify(packed));
        return;
      } catch {
        /* signalling below */
      }
    }
    void api.invoke("signal", { peerId, payload: packed });
  }

  stopControl(): void {
    const peerId = this.state.controlPeerId || this.state.peerId;
    const who = this.state.controlledBy || this.state.selfName;
    this.finishControl(true);
    if (peerId) {
      this.note(this.chatWith(peerId), `sys:control-end\t${who}`);
      void api.invoke("signal", { peerId, payload: { t: "control-end" } });
    }
  }

  private finishControl(fromHere: boolean): void {
    const dropShare = this.state.shareOn || Boolean(this.deskTrack) || Boolean(this.deskPc);
    const callShare = Boolean(this.rawScreen || this.shareCleanup || this.screenTrack);
    const peerId = this.state.controlPeerId || this.state.peerId;
    this.dropDeskLink();
    this.controlGrant = "";
    this.deskSourceId = "";
    this.expectScreenId = "";
    const tiles = this.state.tiles.filter((tile) => tile.source !== "screen");
    const stageId = tiles.some((tile) => tile.id === this.state.stageId) ? this.state.stageId : (this.state.mode === "p2p" ? this.state.peerId : "self");
    this.patch({
      controlling: false,
      controlled: false,
      controlAsk: undefined,
      controlPending: false,
      controlPeerId: "",
      controlGrant: "",
      controlledBy: "",
      shareOn: false,
      tiles,
      stageId: stageId || "self",
      pinnedId: "",
    });
    void api.invoke("injectInput", { t: "end" });
    void api.invoke("setBusy", { sharing: false });
    if (peerId && dropShare) void api.invoke("signal", { peerId, payload: { t: "screen", on: false } });
    if (callShare) void this.stopShare();
    if (fromHere) this.slog("control-stop", { share: dropShare });
  }

  private dropDeskLink(): void {
    this.dropDeskPc();
    this.stopDeskCapture();
  }

  private dropDeskPc(): void {
    this.deskGen += 1;
    const pc = this.deskPc;
    this.deskPc = undefined;
    this.desk = undefined;
    try { pc?.close(); } catch { /* already closed */ }
  }

  private stopDeskCapture(): void {
    const track = this.deskTrack;
    const stop = this.deskCapture?.stop;
    this.deskTrack = undefined;
    this.deskCapture = undefined;
    if (track) track.onended = null;
    try { stop?.(); } catch { /* capture already stopped */ }
    try { track?.stop(); } catch { /* track already stopped */ }
  }

  private armDeskHost(peerId: string, track: MediaStreamTrack): void {
    this.dropDeskPc();
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.deskPc = pc;
    pc.onicecandidate = (event) => {
      void api.invoke("signal", { peerId, payload: { t: "ice", candidate: event.candidate ? event.candidate.toJSON() : null, purpose: "desk" } });
    };
    pc.ondatachannel = (event) => {
      if (event.channel.label === "desk") this.bindDesk(event.channel);
    };
    const sender = pc.addTrack(track, new MediaStream([track]));
    const slot = pc.getTransceivers().find((item) => item.sender === sender);
    if (slot) slot.direction = "sendonly";
  }

  private async deskOffer(peerId: string): Promise<void> {
    this.dropDeskPc();
    const gen = this.deskGen;
    const pc = new RTCPeerConnection({ iceServers: [], bundlePolicy: "max-bundle" });
    this.deskPc = pc;
    pc.onicecandidate = (event) => {
      void api.invoke("signal", { peerId, payload: { t: "ice", candidate: event.candidate ? event.candidate.toJSON() : null, purpose: "desk" } });
    };
    pc.ontrack = (event) => {
      if (this.deskGen !== gen || event.track.kind !== "video") return;
      this.showRemoteScreen(peerId, event.track);
      event.track.onunmute = () => {
        if (this.deskGen === gen) this.showRemoteScreen(peerId, event.track);
      };
    };
    this.bindDesk(pc.createDataChannel("desk"));
    pc.addTransceiver("video", { direction: "recvonly" });
    try {
      const description = await pc.createOffer();
      if (this.deskGen !== gen) return;
      await pc.setLocalDescription(description);
      await api.invoke("signal", { peerId, payload: { t: "offer", sdp: pc.localDescription?.sdp || description.sdp || "", purpose: "desk" } });
      this.slog("desk-offer", { state: pc.signalingState });
    } catch (error) {
      this.slog("desk-fail", { error: String(error) });
    }
  }

  private async onDeskRtc(peerId: string, payload: SignalPayload): Promise<void> {
    const pc = this.deskPc;
    if (!pc || pc.connectionState === "closed") return;
    if (payload.t === "ice") {
      if (!payload.candidate) return;
      try { await pc.addIceCandidate(payload.candidate); } catch { /* early candidate */ }
      return;
    }
    if (payload.t === "offer") {
      try {
        if (pc.signalingState !== "stable") return;
        await pc.setRemoteDescription({ type: "offer", sdp: payload.sdp });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await api.invoke("signal", { peerId, payload: { t: "answer", sdp: pc.localDescription?.sdp || answer.sdp || "", purpose: "desk" } });
        this.slog("desk-answer", { state: pc.signalingState });
      } catch (error) {
        this.slog("desk-fail", { error: String(error) });
      }
      return;
    }
    if (payload.t === "answer") {
      try {
        if (!canApplyAnswer(pc.signalingState)) return;
        await pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
        this.slog("desk-stable", { state: pc.signalingState });
      } catch (error) {
        this.slog("desk-fail", { error: String(error) });
      }
    }
  }

  private pickDesk<T extends { id: string; primary?: boolean; x?: number; y?: number }>(sources: T[]): T | undefined {
    const screens = sources.filter((item) => item.id.startsWith("screen:"));
    return screens.find((item) => item.primary)
      || screens.find((item) => (item.x || 0) === 0 && (item.y || 0) === 0)
      || screens[0]
      || sources[0];
  }

  private controlTarget(): string {
    if (this.state.mode === "p2p") return this.state.peerId;
    const stage = this.state.tiles.find((tile) => tile.id === this.state.stageId);
    if (stage && stage.source !== "self" && stage.peerId !== this.state.selfId) return stage.peerId;
    const other = this.state.tiles.find((tile) => tile.source !== "self" && tile.peerId !== this.state.selfId);
    return other?.peerId || "";
  }

  private peerName(peerId: string): string {
    const tile = this.state.tiles.find((item) => item.peerId === peerId);
    return tile?.name || this.remoteName || peerId.slice(0, 6);
  }

  async toggleCam(): Promise<void> {
    if (this.state.phase !== "active" || !this.local || !this.settings) return;
    if (this.state.camOn) {
      await this.disableCamera();
      this.patch({ camOn: false, tiles: this.refreshSelf(this.state.tiles) });
      return;
    }
    try {
      await this.enableCamera();
      this.patch({ camOn: true, video: true, tiles: this.refreshSelf(this.state.tiles) });
    } catch (error) {
      if (this.rawScreen && this.state.shareOn) this.rawScreen.onended = () => void this.stopShare();
      await this.disableCamera();
      this.patch({ camOn: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  private refreshSelf(tiles: Tile[]): Tile[] {
    return tiles.map((tile) => (tile.id === "self" ? this.selfTile() : tile));
  }

  private async enableCamera(): Promise<void> {
    if (!this.local || !this.settings) return;
    if (this.rawScreen) this.rawScreen.onended = null;
    const opened = await openCameraTrack(this.settings);
    this.cameraStop?.();
    this.cameraStop = opened.stop;
    this.local.addVideoTrack(opened.track);
    if (this.rawScreen && this.state.shareOn) this.rawScreen.onended = () => void this.stopShare();
    await this.publishCamera(opened.track);
  }

  private async publishCamera(track: MediaStreamTrack): Promise<void> {
    if (!this.local) return;
    if (this.state.mode === "p2p" && this.pc) {
      if (this.cameraSender) await this.cameraSender.replaceTrack(track);
      else this.cameraSender = this.pc.addTrack(track, this.local.stream);
    }
    if (this.state.mode === "conf" && this.sendTransport) {
      await this.closeProducer(this.cameraProducer);
      const appData = { peerId: this.state.selfId, name: this.state.selfName, source: "camera" };
      try {
        this.cameraProducer = await this.sendTransport.produce({
          track,
          encodings: [
            { scaleResolutionDownBy: 4, maxBitrate: 180_000 },
            { scaleResolutionDownBy: 2, maxBitrate: 500_000 },
            { scaleResolutionDownBy: 1, maxBitrate: 1_200_000 },
          ],
          appData,
        });
      } catch {
        this.cameraProducer = await this.sendTransport.produce({
          track,
          encodings: [{ maxBitrate: 1_200_000 }],
          appData,
        });
      }
      this.producers.push(this.cameraProducer);
    }
  }

  private async reviveCamera(): Promise<void> {
    const live = this.local?.stream.getVideoTracks().some((track) => track.readyState === "live");
    if (live) return;
    if (this.rawScreen) this.rawScreen.onended = null;
    await this.enableCamera();
    if (this.rawScreen?.readyState === "live") this.rawScreen.onended = () => void this.stopShare();
    else {
      const screen = await this.refreshScreenVideo();
      if (screen) this.screenTrack = screen;
    }
    this.patch({ camOn: true, video: true, tiles: this.refreshSelf(this.state.tiles) });
  }

  private async unpublishCamera(): Promise<void> {
    if (this.cameraSender) await this.cameraSender.replaceTrack(null);
    await this.closeProducer(this.cameraProducer);
    this.cameraProducer = undefined;
  }

  private async disableCamera(): Promise<void> {
    this.cameraStop?.();
    this.cameraStop = undefined;
    this.local?.clearVideo();
    await this.unpublishCamera();
  }

  async shareScreen(choice?: { sourceIds: string[]; withAudio: boolean }): Promise<boolean> {
    if (this.state.phase !== "active") return false;
    if (this.state.shareOn && !choice?.sourceIds.length) {
      await this.stopShare();
      return false;
    }
    if (this.state.shareOn) return true;
    if (!choice?.sourceIds.length) return false;
    const opened = await this.openShareTracks(choice.sourceIds, choice.withAudio);
    if (!opened) {
      this.patch({ error: "screen share failed" });
      return false;
    }
    this.shareSources = choice.sourceIds;
    this.shareCleanup = opened.stop;
    this.rawScreen = opened.video;
    opened.video.contentHint = "detail";
    opened.video.onended = () => void this.stopShare();
    this.shareDuck?.stop();
    this.shareDuck = undefined;
    if (opened.audio) {
      this.shareDuck = duckShareAudio(
        opened.audio,
        () => Math.max(this.farEndTalking(), this.state.levels[this.state.selfId] ?? 0),
        this.settings?.shareVolume ?? 1,
      );
      this.screenAudioTrack = this.shareDuck.track;
    } else {
      this.screenAudioTrack = undefined;
    }
    await this.local?.resume();
    if (this.local?.health().ended) await this.healMic();
    if (this.state.camOn) {
      try {
        await this.reviveCamera();
      } catch {
        /* the screen stays up; the camera can be opened again */
      }
    }
    const outgoing = this.rawScreen?.readyState === "live" ? this.rawScreen : opened.video;
    this.screenTrack = outgoing;
    const preview = new MediaStream([outgoing]);
    const id = `screen:${this.state.selfId}`;
    const tiles = this.state.tiles.filter((tile) => tile.id !== id);
    tiles.push({ id, peerId: this.state.selfId, name: this.state.selfName, source: "screen", stream: preview });
    this.patch({ shareOn: true, tiles, stageId: id, pinnedId: "" });
    void api.invoke("setBusy", { sharing: true });
    this.slog("share-start", { id, live: outgoing.readyState, mode: this.state.mode });
    if (this.state.mode === "p2p" && this.pc && this.state.peerId) {
      await this.publishScreenTrack(outgoing);
      if (this.screenAudioTrack) {
        if (this.screenAudioSender) await this.screenAudioSender.replaceTrack(this.screenAudioTrack);
        else {
          this.screenAudioSender = this.pc.addTrack(this.screenAudioTrack, new MediaStream([this.screenAudioTrack]));
          favorScreenAudioSender(this.screenAudioSender);
          await this.renegotiate(this.state.peerId);
        }
      }
      await api.invoke("signal", { peerId: this.state.peerId, payload: { t: "screen", on: true, streamId: "screen" } });
    }
    if (this.state.mode === "conf" && this.sendTransport) {
      try {
        this.screenProducer = await this.sendTransport.produce({
          track: outgoing,
          encodings: [{ maxBitrate: 8_000_000, maxFramerate: 60 }],
          codecOptions: { videoGoogleStartBitrate: 4000, videoGoogleMaxBitrate: 8000 },
          onRtpSender: yieldVideoSender,
          appData: { peerId: this.state.selfId, name: this.state.selfName, source: "screen" },
        });
        this.producers.push(this.screenProducer);
        if (this.screenAudioTrack) {
          this.screenAudioProducer = await this.sendTransport.produce({
            track: this.screenAudioTrack,
            encodings: [{ maxBitrate: 96_000 }],
            codecOptions: { opusStereo: true, opusDtx: false, opusFec: true, opusMaxAverageBitrate: 64000 },
            onRtpSender: favorScreenAudioSender,
            appData: { peerId: this.state.selfId, name: this.state.selfName, source: "screen" },
          });
          this.producers.push(this.screenAudioProducer);
        }
      } catch (error) {
        console.error("share produce", error);
        this.patch({ error: "screen share failed" });
        return false;
      }
    }
    return true;
  }

  private async refreshScreenVideo(): Promise<MediaStreamTrack | null> {
    const current = this.rawScreen;
    if (current && current.readyState === "live") return current;
    if (!this.shareSources.length) return null;
    const opened = await this.openShareTracks(this.shareSources, false);
    if (!opened) return current && current.readyState === "live" ? current : null;
    const keepAudio = this.screenAudioTrack;
    if (current) {
      current.onended = null;
      current.stop();
    }
    this.rawScreen = opened.video;
    opened.video.contentHint = "detail";
    opened.video.onended = () => void this.stopShare();
    this.shareCleanup = () => {
      opened.stop();
      if (keepAudio && keepAudio.readyState === "live") keepAudio.stop();
    };
    return opened.video;
  }

  private async useShareCamera(cam: MediaStreamTrack | null): Promise<void> {
    if (!this.rawScreen) return;
    if (cam) {
      if (!this.shareMix) this.shareMix = mixShare(this.rawScreen);
      this.shareMix.setCamera(cam);
      await this.replaceShareVideo(this.shareMix.track);
      return;
    }
    const raw = this.rawScreen;
    this.shareMix?.stop();
    this.shareMix = undefined;
    await this.replaceShareVideo(raw);
  }

  private async replaceShareVideo(track: MediaStreamTrack): Promise<void> {
    track.contentHint = "detail";
    this.screenTrack = track;
    const id = `screen:${this.state.selfId}`;
    const preview = new MediaStream([track]);
    this.patch({ tiles: this.state.tiles.map((tile) => (tile.id === id ? { ...tile, stream: preview } : tile)) });
    if (this.screenSender) await this.screenSender.replaceTrack(track);
    if (this.screenProducer && !this.screenProducer.closed) await this.screenProducer.replaceTrack({ track });
  }

  private async openShareTracks(sourceIds: string[], withAudio: boolean): Promise<{ video: MediaStreamTrack; audio?: MediaStreamTrack; stop: () => void } | null> {
    const streams: MediaStream[] = [];
    for (const sourceId of sourceIds) {
      const media = await this.captureDesktopVideo(sourceId);
      if (media) streams.push(media);
    }
    if (!streams.length && sourceIds.length === 1) {
      const fallback = await this.captureDisplay(sourceIds[0], false);
      if (fallback) streams.push(fallback);
    }
    if (!streams.length) return null;
    const audioGrab = withAudio ? await this.captureDesktopAudio(sourceIds[0]) : null;
    const videoTracks = streams.map((stream) => stream.getVideoTracks()[0]).filter((track): track is MediaStreamTrack => Boolean(track));
    if (!videoTracks.length) {
      audioGrab?.stop();
      streams.forEach((stream) => stream.getTracks().forEach((track) => track.stop()));
      return null;
    }
    if (videoTracks.length === 1) {
      const video = videoTracks[0];
      return {
        video,
        audio: audioGrab?.track,
        stop: () => {
          video.stop();
          audioGrab?.stop();
        },
      };
    }
    const mixed = compositeScreens(streams);
    return {
      video: mixed.track,
      audio: audioGrab?.track,
      stop: () => {
        mixed.stop();
        audioGrab?.stop();
      },
    };
  }

  private async captureDesktopVideo(sourceId: string): Promise<MediaStream | null> {
    const video = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: 2560,
        maxHeight: 1440,
        minFrameRate: 60,
        maxFrameRate: 60,
      },
    };
    const open = async (constraints: MediaTrackConstraints) => navigator.mediaDevices.getUserMedia({ audio: false, video: constraints } as MediaStreamConstraints);
    try {
      const stream = await open(video as unknown as MediaTrackConstraints);
      await lockShareRate(stream);
      return stream;
    } catch {
      const relaxed = {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: sourceId,
          maxWidth: 2560,
          maxHeight: 1440,
          maxFrameRate: 60,
        },
      };
      try {
        const stream = await open(relaxed as unknown as MediaTrackConstraints);
        await lockShareRate(stream);
        return stream;
      } catch {
        return null;
      }
    }
  }

  // Video and system audio are captured separately. One getUserMedia that asks for both
  // ties the picture clock to the audio clock, so the shared image runs fast and the sound breaks up.
  private async captureDesktopAudio(sourceId: string): Promise<{ track: MediaStreamTrack; stop: () => void } | null> {
    const video = {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: sourceId,
        maxWidth: 320,
        maxHeight: 180,
        maxFrameRate: 1,
      },
    };
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          mandatory: { chromeMediaSource: "desktop", chromeMediaSourceId: sourceId },
          optional: [{ echoCancellation: true }, { googEchoCancellation: true }, { noiseSuppression: true }],
        },
        video,
      } as MediaStreamConstraints);
      const track = stream.getAudioTracks()[0];
      if (!track) {
        stream.getTracks().forEach((item) => item.stop());
        return null;
      }
      track.enabled = true;
      for (const extra of stream.getVideoTracks()) extra.enabled = false;
      return {
        track,
        stop: () => stream.getTracks().forEach((item) => item.stop()),
      };
    } catch {
      return null;
    }
  }

  private async captureDisplay(sourceId: string, withAudio: boolean): Promise<MediaStream | null> {
    try {
      await api.invoke("armDisplayMedia", { sourceId, withAudio });
      return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: withAudio });
    } catch {
      try {
        await api.invoke("armDisplayMedia", { sourceId, withAudio: false });
        return await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      } catch (error) {
        this.patch({ error: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }
  }

  async stopShare(): Promise<void> {
    if (this.deskPc || this.deskTrack) {
      this.stopControl();
      return;
    }
    if (this.rawScreen) this.rawScreen.onended = null;
    const id = `screen:${this.state.selfId}`;
    const cam = this.state.camOn ? this.local?.stream.getVideoTracks().find((track) => track.readyState === "live") : undefined;
    this.shareMix?.stop();
    this.shareMix = undefined;
    this.shareDuck?.stop();
    this.shareDuck = undefined;
    this.shareCleanup?.();
    this.shareCleanup = undefined;
    this.shareSources = [];
    this.rawScreen = undefined;
    this.screenTrack = undefined;
    this.screenAudioTrack = undefined;
    if (this.screenSender && this.pc) {
      try {
        await this.screenSender.replaceTrack(null);
        const slot = this.pc.getTransceivers().find((item) => item.sender === this.screenSender);
        if (slot) slot.direction = "recvonly";
        await this.renegotiate(this.state.peerId);
      } catch {
        this.pc.removeTrack(this.screenSender);
        this.screenSender = undefined;
      }
    }
    if (this.screenAudioSender && this.pc) {
      this.pc.removeTrack(this.screenAudioSender);
      this.screenAudioSender = undefined;
    }
    await this.closeProducer(this.screenProducer);
    this.screenProducer = undefined;
    await this.closeProducer(this.screenAudioProducer);
    this.screenAudioProducer = undefined;
    if (this.state.mode === "p2p" && this.state.peerId) {
      await api.invoke("signal", { peerId: this.state.peerId, payload: { t: "screen", on: false } });
    }
    const nextStage = this.state.stageId === id ? (this.state.mode === "p2p" ? this.state.peerId : "self") : this.state.stageId;
    this.patch({ shareOn: false, tiles: this.state.tiles.filter((tile) => tile.id !== id), stageId: nextStage });
    void api.invoke("setBusy", { sharing: false });
    if (cam) await this.publishCamera(cam);
  }

  private async closeProducer(producer?: MsTypes.Producer): Promise<void> {
    if (!producer) return;
    const producerId = producer.id;
    producer.close();
    this.producers = this.producers.filter((item) => item.id !== producerId);
    const hostId = this.state.hostId === this.state.selfId ? undefined : this.state.hostId;
    await api.invoke("sfu", { op: "closeProducer", hostId, data: { peerId: this.state.selfId, producerId } }).catch(() => undefined);
  }

  private showRemoteScreen(peerId: string, track: MediaStreamTrack): void {
    const id = `screen:${peerId}`;
    const stream = new MediaStream([track]);
    const tiles = this.state.tiles.filter((tile) => tile.id !== id);
    tiles.push({ id, peerId, name: this.remoteName || this.peerName(peerId), source: "screen", stream });
    const pin = this.state.controlling && (this.state.controlPeerId === peerId || !this.state.controlPeerId);
    this.patch({ tiles, stageId: id, pinnedId: pin ? id : this.state.pinnedId || id });
    this.slog("screen-tile", { peerId, id, pin, ready: track.readyState });
    track.onended = () => this.patch({ tiles: this.state.tiles.filter((tile) => tile.id !== id) });
  }

  private attachPendingScreen(peerId: string): void {
    if (this.state.tiles.some((tile) => tile.id === `screen:${peerId}` && tile.stream)) return;
    const live = (this.pc?.getReceivers() ?? [])
      .map((item) => item.track)
      .filter((track): track is MediaStreamTrack => Boolean(track && track.kind === "video" && track.readyState !== "ended"));
    const cam = this.remoteStream.getVideoTracks()[0];
    const pick = live.find((track) => track !== cam) || (this.state.controlling || this.expectScreenId ? live[0] : undefined) || this.remoteStream.getVideoTracks()[1];
    this.slog("screen-harvest", { peerId, live: live.length, cam: Boolean(cam), pick: Boolean(pick), muted: pick?.muted ?? true });
    if (pick) this.showRemoteScreen(peerId, pick);
  }

  private waitForScreen(peerId: string): void {
    window.clearTimeout(this.screenWait);
    let tries = 0;
    const tick = () => {
      if (this.state.tiles.some((tile) => tile.id === `screen:${peerId}` && tile.stream)) return;
      this.attachPendingScreen(peerId);
      if (this.state.tiles.some((tile) => tile.id === `screen:${peerId}` && tile.stream)) return;
      tries += 1;
      if (tries < 48) this.screenWait = window.setTimeout(tick, 250);
      else this.slog("screen-timeout", { peerId, receivers: this.pc?.getReceivers().length || 0, signal: this.pc?.signalingState });
    };
    tick();
  }

  private async ensureDeskShare(): Promise<boolean> {
    const sources = await api.invoke<Array<{ id: string; width: number; height: number; x?: number; y?: number; primary?: boolean }>>("screenSources");
    const screens = sources.filter((item) => item.id.startsWith("screen:"));
    const screen = screens.find((item) => item.id === this.deskSourceId) || this.pickDesk(screens);
    if (!screen) {
      this.slog("share-none", {});
      return false;
    }
    this.deskSourceId = screen.id;
    const same = this.state.shareOn && this.shareSources.length === 1 && this.shareSources[0] === screen.id && this.screenTrack?.readyState === "live";
    if (same) return true;
    if (this.state.shareOn) await this.stopShare();
    const ok = await this.shareScreen({ sourceIds: [screen.id], withAudio: false });
    if (ok) return true;
    this.slog("share-retry", { id: screen.id });
    return this.shareScreen({ sourceIds: [screen.id], withAudio: false });
  }

  private async publishScreenTrack(track: MediaStreamTrack): Promise<void> {
    if (!this.pc) return;
    const already = this.screenSender?.track === track;
    if (this.screenSender) {
      if (!already) await this.screenSender.replaceTrack(track);
    } else {
      this.screenSender = this.pc.addTrack(track, new MediaStream([track]));
    }
    const slot = this.pc.getTransceivers().find((item) => item.sender === this.screenSender);
    const needOffer = !already || (slot && slot.direction !== "sendrecv");
    if (slot && slot.direction !== "sendrecv") slot.direction = "sendrecv";
    yieldVideoSender(this.screenSender);
    if (needOffer) await this.renegotiate(this.state.peerId);
  }

  private async pulseScreen(peerId: string): Promise<void> {
    if (this.state.mode !== "p2p" || !this.pc) return;
    const track = this.screenTrack;
    if (!track || track.readyState !== "live") {
      this.slog("pulse-skip", { ready: track?.readyState || "none" });
      return;
    }
    try {
      if (this.screenSender?.track !== track) await this.publishScreenTrack(track);
      await api.invoke("signal", { peerId, payload: { t: "screen", on: true, streamId: "screen" } });
      this.slog("pulse-ok", { peerId });
    } catch (error) {
      this.slog("pulse-fail", { error: String(error) });
    }
  }

  private withCameraTiles(peerId: string): Tile[] {
    const screens = this.state.tiles.filter((tile) => tile.source === "screen");
    return [
      this.selfTile(),
      { id: peerId, peerId, name: this.remoteName, source: "camera", stream: this.remoteStream },
      ...screens,
    ];
  }

  async startConference(roomId: string, roomName = ""): Promise<void> {
    if (this.state.phase !== "idle") await this.hangup();
    this.placeName = roomName;
    const joined = await api.invoke<any>("confStart", { roomId });
    this.callWay = "out";
    this.callLogged = false;
    this.slog("conf-host", { roomId, roomName });
    this.patch({ phase: "active", mode: "conf", roomId, hostId: this.state.selfId, video: false, micOn: !this.settings?.joinMuted, camOn: false, started: Date.now() });
    await api.invoke("setBusy", { inCall: true, mode: "conf" });
    await this.attachConference(joined, undefined);
    this.note(roomChat(roomId), `sys:start-conf\t${this.state.selfName}\t${roomName}`);
  }

  async joinConference(roomId: string, hostId: string, roomName = ""): Promise<void> {
    if (this.state.phase !== "idle") await this.hangup();
    this.placeName = roomName;
    this.callWay = "in";
    this.callLogged = false;
    this.slog("conf-join", { roomId, hostId, roomName });
    const joined = await api.invoke<any>("sfu", { op: "join", hostId, data: { peerId: this.state.selfId, roomId } });
    this.patch({ phase: "active", mode: "conf", roomId, hostId, video: false, micOn: !this.settings?.joinMuted, camOn: false, started: Date.now() });
    await api.invoke("setBusy", { inCall: true, mode: "conf" });
    await this.attachConference(joined, hostId);
    this.note(roomChat(roomId), `sys:join-conf\t${this.state.selfName}\t${roomName}`);
  }

  private async attachConference(joined: any, hostId: string | undefined): Promise<void> {
    if (!this.settings) return;
    this.local = await openLocalMedia(this.settings, false);
    this.device = new Device();
    await this.device.load({ routerRtpCapabilities: joined.routerRtpCapabilities });
    this.sendTransport = this.device.createSendTransport(joined.send);
    this.recvTransport = this.device.createRecvTransport(joined.recv);
    this.wireTransport(this.sendTransport, hostId);
    this.wireTransport(this.recvTransport, hostId);
    if (!this.state.micOn) this.local.setMic(false);
    const audio = this.local.stream.getAudioTracks()[0];
    if (audio) {
      this.micProducer = await this.sendTransport.produce({
        track: audio,
        encodings: [{ maxBitrate: 128_000 }],
        codecOptions: micCodec,
        onRtpSender: favorAudioSender,
        appData: { peerId: this.state.selfId, name: this.state.selfName, source: "mic" },
      });
      this.producers.push(this.micProducer);
    }
    this.patch({ tiles: [this.selfTile()], camOn: false });
    this.localLevelLoop();
    for (const producer of joined.producers ?? []) await this.onProducer(producer);
    this.tellMic(this.state.micOn);
  }

  private tellMic(on: boolean): void {
    const ids = new Set<string>();
    if (this.state.peerId && this.state.peerId !== this.state.selfId) ids.add(this.state.peerId);
    for (const tile of this.state.tiles) {
      if (tile.peerId && tile.peerId !== this.state.selfId) ids.add(tile.peerId);
    }
    for (const peerId of ids) void api.invoke("signal", { peerId, payload: { t: "mic", on } });
  }

  private wireTransport(transport: MsTypes.Transport, hostId: string | undefined): void {
    transport.on("connect", ({ dtlsParameters }, callback, errback) => {
      api
        .invoke("sfu", { op: "connect", hostId, data: { peerId: this.state.selfId, transportId: transport.id, dtlsParameters } })
        .then(() => callback())
        .catch(errback);
    });
    transport.on("produce", ({ kind, rtpParameters, appData }, callback, errback) => {
      api
        .invoke("sfu", { op: "produce", hostId, data: { peerId: this.state.selfId, transportId: transport.id, kind, rtpParameters, appData } })
        .then((result: { id: string }) => callback({ id: result.id }))
        .catch(errback);
    });
  }

  private async onProducer(event: any): Promise<void> {
    if (!this.recvTransport || !this.device || event.peerId === this.state.selfId) return;
    const hostId = this.state.hostId === this.state.selfId ? undefined : this.state.hostId;
    const consumed = await api.invoke<any>("sfu", {
      op: "consume",
      hostId,
      data: {
        peerId: this.state.selfId,
        transportId: this.recvTransport.id,
        producerId: event.producerId,
        rtpCapabilities: this.device.rtpCapabilities,
      },
    });
    const consumer = await this.recvTransport.consume({
      id: consumed.id,
      producerId: consumed.producerId,
      kind: consumed.kind,
      rtpParameters: consumed.rtpParameters,
    });
    const source = String(event.appData?.source || (consumer.kind === "audio" ? "mic" : "camera"));
    const peerId = String(event.peerId);
    const name = String(event.appData?.name || "");
    let audio: ConfConsumer["audio"];
    if (consumer.kind === "audio") {
      audio = watchLevel(consumer.track, (level) => {
        if (source === "screen") return;
        this.patch({ levels: { ...this.state.levels, [peerId]: level } });
        this.pickStage();
      }, source === "screen" ? (this.settings?.shareVolume ?? 1) : (this.settings?.peerVolume ?? 1), this.settings?.speakerId ?? "", source === "screen" ? () => this.state.levels[this.state.selfId] ?? 0 : undefined);
    }
    this.consumers.set(consumer.id, { id: consumer.id, peerId, source, kind: consumer.kind, consumer, audio });
    await api.invoke("sfu", { op: "resume", hostId, data: { consumerId: consumer.id } });
    if (consumer.kind === "audio" && source !== "screen" && !this.state.tiles.some((tile) => tile.id === peerId)) {
      this.patch({ tiles: [...this.state.tiles, { id: peerId, peerId, name, source: "camera", stream: null }] });
    }
    if (consumer.kind === "video") {
      const id = source === "screen" ? `screen:${peerId}` : peerId;
      const stream = new MediaStream([consumer.track]);
      const tiles = this.state.tiles.filter((tile) => tile.id !== id);
      tiles.push({ id, peerId, name, source: source === "screen" ? "screen" : "camera", stream });
      this.patch({ tiles });
      if (source === "screen") {
        const pin = this.state.controlling && this.state.controlPeerId === peerId;
        this.patch({ stageId: id, pinnedId: pin ? id : this.state.pinnedId });
      }
      await this.applyLayers();
    }
    this.tellMic(this.state.micOn);
  }

  private removeTile(producerId: string): void {
    const found = [...this.consumers.values()].find((item) => item.consumer.producerId === producerId);
    if (!found) return;
    found.audio?.stop();
    found.consumer.close();
    this.consumers.delete(found.id);
    const still = [...this.consumers.values()].some((item) => item.peerId === found.peerId);
    if (!still) {
      this.dropPeer(found.peerId);
      return;
    }
    if (found.kind === "video") {
      const id = found.source === "screen" ? `screen:${found.peerId}` : found.peerId;
      if (found.source === "screen") this.patch({ tiles: this.state.tiles.filter((tile) => tile.id !== id) });
      else this.patch({ tiles: this.state.tiles.map((tile) => (tile.id === id ? { ...tile, stream: null } : tile)) });
    }
  }

  private dropPeer(peerId: string): void {
    if (!peerId || peerId === this.state.selfId) return;
    for (const item of [...this.consumers.values()]) {
      if (item.peerId !== peerId) continue;
      item.audio?.stop();
      item.consumer.close();
      this.consumers.delete(item.id);
    }
    const tiles = this.state.tiles.filter((tile) => tile.peerId !== peerId);
    const stageId = tiles.some((tile) => tile.id === this.state.stageId) ? this.state.stageId : (tiles[0]?.id || "self");
    this.patch({ tiles, stageId, levels: { ...this.state.levels, [peerId]: 0 } });
  }

  async setVisible(ids: string[]): Promise<void> {
    const visible = new Set(ids);
    if (this.state.stageId) visible.add(this.state.stageId);
    const hostId = this.state.hostId === this.state.selfId ? undefined : this.state.hostId;
    for (const item of this.consumers.values()) {
      if (item.kind !== "video") continue;
      const id = item.source === "screen" ? `screen:${item.peerId}` : item.peerId;
      const show = visible.has(id);
      await api.invoke("sfu", { op: show ? "resume" : "pause", hostId, data: { consumerId: item.id } });
      if (show) {
        const spatialLayer = id === this.state.stageId ? 2 : 1;
        await api.invoke("sfu", { op: "layers", hostId, data: { consumerId: item.id, spatialLayer } });
      }
    }
  }

  pin(id: string): void {
    this.stageHold = id;
    this.patch({ pinnedId: id, stageId: id });
  }

  private pickStage(): void {
    if (this.state.pinnedId) return;
    const screen = this.state.tiles.find((tile) => tile.source === "screen");
    if (screen) {
      if (this.state.stageId !== screen.id) this.patch({ stageId: screen.id });
      return;
    }
    let loudest = "";
    let loud = 0.08;
    for (const [id, level] of Object.entries(this.state.levels)) {
      if (level > loud) {
        loud = level;
        loudest = id;
      }
    }
    if (!loudest) return;
    if (this.state.controlling || this.state.pinnedId.startsWith("screen:")) return;
    if (loudest === this.stageHold) return;
    const now = performance.now();
    if (this.stageSince === 0) this.stageSince = now;
    if (now - this.stageSince < 700 && this.state.stageId) return;
    this.stageHold = loudest;
    this.stageSince = now;
    const tile = loudest === this.state.selfId ? "self" : loudest;
    this.patch({ stageId: tile });
  }

  private async applyLayers(): Promise<void> {
    await this.setVisible(this.state.tiles.map((tile) => tile.id));
  }

  async acceptInvite(): Promise<void> {
    const invite = this.state.invite;
    if (!invite || this.state.phase !== "idle") return;
    this.patch({ invite: undefined });
    await api.invoke("joinRoom", { roomId: invite.roomId, password: invite.password });
    await this.joinConference(invite.roomId, invite.hostId, invite.name);
  }

  declineInvite(): void {
    this.patch({ invite: undefined });
  }

  async toggleRecord(drawFrom: HTMLVideoElement | null): Promise<void> {
    if (this.recorder) {
      await this.stopRecord();
      return;
    }
    await this.local?.resume();
    if (this.local?.health().ended) await this.healMic();
    const picture = this.recordPicture(drawFrom);
    const sharing = this.state.tiles.some((tile) => tile.source === "screen");
    const width = sharing ? 1920 : 1280;
    const height = sharing ? 1080 : 720;
    const target = new ArrayBufferTarget();
    const muxer = new Muxer({
      target,
      video: { codec: "avc", width, height },
      audio: { codec: "aac", numberOfChannels: 1, sampleRate: 48000 },
      fastStart: "in-memory",
      firstTimestampBehavior: "cross-track-offset",
    });
    const video = new VideoEncoder({
      output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
      error: (error) => this.patch({ error: String(error) }),
    });
    let configured = false;
    for (const item of ["avc1.640028", "avc1.4d0028", "avc1.42001f"]) {
      try {
        video.configure({ codec: item, width, height, bitrate: 2_500_000, framerate: 24 });
        configured = true;
        break;
      } catch {
        /* try a more compatible profile */
      }
    }
    if (!configured) {
      this.patch({ error: "recorder" });
      return;
    }
    const audio = new AudioEncoder({
      output: (chunk, meta) => muxer.addAudioChunk(chunk, meta),
      error: (error) => this.patch({ error: String(error) }),
    });
    audio.configure({ codec: "mp4a.40.2", sampleRate: 48000, numberOfChannels: 1, bitrate: 128000 });
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" })!;
    const origin = performance.now();
    let lastVideoTs = -1;
    this.recordAlive = true;
    const tick = () => {
      if (!this.recordAlive || video.state !== "configured" || video.encodeQueueSize > 3) return;
      const videoTs = Math.round((performance.now() - origin) * 1000);
      if (videoTs <= lastVideoTs) return;
      lastVideoTs = videoTs;
      ctx.fillStyle = "#0c1018";
      ctx.fillRect(0, 0, width, height);
      const source = picture;
      if (source && source.readyState >= 2 && source.videoWidth > 0 && source.videoHeight > 0) {
        const scale = Math.min(width / source.videoWidth, height / source.videoHeight);
        const dw = source.videoWidth * scale;
        const dh = source.videoHeight * scale;
        ctx.drawImage(source, (width - dw) / 2, (height - dh) / 2, dw, dh);
      }
      const camera = document.querySelector(".stage-float video");
      if (camera instanceof HTMLVideoElement && camera.readyState >= 2 && camera.videoWidth > 0) {
        const size = Math.round(Math.min(width, height) * 0.24);
        const pad = Math.round(size * 0.14);
        const x = width - size - pad;
        const y = height - size - pad;
        const cover = Math.max(size / camera.videoWidth, size / camera.videoHeight);
        const dw = camera.videoWidth * cover;
        const dh = camera.videoHeight * cover;
        ctx.save();
        roundRect(ctx, x, y, size, size, Math.round(size * 0.16));
        ctx.clip();
        ctx.drawImage(camera, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
        ctx.restore();
      }
      const frame = new VideoFrame(canvas, { timestamp: videoTs });
      video.encode(frame, { keyFrame: videoTs % 2_000_000 < 42_000 });
      frame.close();
    };
    this.recordTimer = window.setInterval(tick, 1000 / 24);
    const stopAudio = this.attachRecordAudio(audio);
    this.recorder = { muxer, video, audio, canvas, audioTs: 0, pcm: new Float32Array(), stop: stopAudio };
    this.patch({ recording: true, recStarted: Date.now() });
    void api.invoke("setBusy", { recording: true });
    if (this.state.mode === "p2p") await api.invoke("signal", { peerId: this.state.peerId, payload: { t: "recording", on: true, started: this.state.recStarted } });
    if (this.state.mode === "conf") await api.invoke("confNotify", { roomId: this.state.roomId, hostId: this.state.hostId, on: true, started: this.state.recStarted });
    this.note(this.chatOf(), `sys:rec-on\t${this.state.selfName}`);
  }

  private recordPicture(drawFrom: HTMLVideoElement | null): HTMLVideoElement | null {
    const screen = this.state.tiles.find((tile) => tile.source === "screen" && tile.stream?.getVideoTracks().length);
    const stream = screen?.stream || (drawFrom?.srcObject instanceof MediaStream ? drawFrom.srcObject : null);
    if (drawFrom && (!screen || drawFrom.srcObject === screen.stream) && (drawFrom.videoWidth || 0) > 0) return drawFrom;
    if (!stream) return drawFrom;
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = stream;
    video.style.cssText = "position:fixed;width:2px;height:2px;opacity:0;pointer-events:none";
    document.body.append(video);
    void video.play().catch(() => undefined);
    this.recordVideo = video;
    return video;
  }

  private attachRecordAudio(audio: AudioEncoder): () => void {
    const audioCtx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });
    const mix = audioCtx.createGain();
    mix.channelCount = 1;
    mix.channelCountMode = "explicit";
    const dest = audioCtx.createMediaStreamDestination();
    try {
      dest.channelCount = 1;
      dest.channelCountMode = "explicit";
    } catch {
      /* keep the default layout */
    }
    mix.connect(dest);
    const add = (track: MediaStreamTrack | undefined, gainValue: number) => {
      if (!track || track.readyState !== "live") return;
      const gain = audioCtx.createGain();
      gain.gain.value = gainValue;
      audioCtx.createMediaStreamSource(new MediaStream([track])).connect(gain);
      gain.connect(mix);
    };
    add(this.local?.stream.getAudioTracks()[0], 1);
    if (this.screenAudioTrack) add(this.screenAudioTrack, 0.35);
    if (this.remoteStream.getAudioTracks().length) {
      for (const track of this.remoteStream.getAudioTracks()) add(track, 1);
    }
    for (const item of this.consumers.values()) {
      if (item.kind === "audio") add(item.consumer.track, 1);
    }
    let audioTs = 0;
    let closed = false;
    const encodePcm = (samples: Float32Array, timestamp = audioTs) => {
      const step = Math.round((samples.length / 48000) * 1_000_000);
      if (closed || audio.state !== "configured" || audio.encodeQueueSize > 48) {
        if (timestamp === audioTs) audioTs += step;
        return;
      }
      const data = new Float32Array(samples);
      const audioData = new AudioData({
        format: "f32",
        sampleRate: 48000,
        numberOfFrames: data.length,
        numberOfChannels: 1,
        timestamp,
        data,
      });
      audio.encode(audioData);
      audioData.close();
      if (timestamp === audioTs) audioTs += step;
    };
    const Processor = (globalThis as { MediaStreamTrackProcessor?: new (init: { track: MediaStreamTrack }) => { readable: ReadableStream<AudioData> } }).MediaStreamTrackProcessor;
    const track = dest.stream.getAudioTracks()[0];
    let reader: ReadableStreamDefaultReader<AudioData> | undefined;
    if (Processor && track) {
      const processor = new Processor({ track });
      reader = processor.readable.getReader();
      let audioOrigin = -1;
      const pump = async () => {
        while (!closed && reader) {
          const next = await reader.read();
          if (next.done || !next.value) break;
          const chunk = next.value;
          if (audioOrigin < 0) audioOrigin = Number(chunk.timestamp);
          const timestamp = Math.max(0, Number(chunk.timestamp) - audioOrigin);
          if (chunk.numberOfFrames > 0 && audio.encodeQueueSize <= 48) {
            const frames = chunk.numberOfFrames;
            const channels = Math.max(1, chunk.numberOfChannels);
            const data = new Float32Array(frames * channels);
            try {
              chunk.copyTo(data, { planeIndex: 0, format: "f32" });
              if (channels === 1) encodePcm(data, timestamp);
              else {
                const mono = new Float32Array(frames);
                for (let i = 0; i < frames; i += 1) {
                  let sum = 0;
                  for (let channel = 0; channel < channels; channel += 1) sum += data[i * channels + channel] || 0;
                  mono[i] = sum / channels;
                }
                encodePcm(mono, timestamp);
              }
            } catch {
              /* skip a chunk the encoder cannot read */
            }
          }
          chunk.close();
        }
      };
      void pump().catch((error) => this.patch({ error: String(error) }));
    } else {
      const script = audioCtx.createScriptProcessor(1024, 1, 1);
      const silent = audioCtx.createGain();
      silent.gain.value = 0;
      mix.connect(script);
      script.connect(silent);
      silent.connect(audioCtx.destination);
      script.onaudioprocess = (event) => encodePcm(event.inputBuffer.getChannelData(0));
    }
    return () => {
      closed = true;
      void reader?.cancel().catch(() => undefined);
      void audioCtx.close();
    };
  }

  private async stopRecord(): Promise<void> {
    const recorder = this.recorder;
    const mode = this.state.mode;
    const peerId = this.state.peerId;
    const roomId = this.state.roomId;
    const hostId = this.state.hostId;
    const chatId = this.chatOf();
    const who = this.state.selfName;
    this.recordAlive = false;
    this.recorder = undefined;
    window.clearInterval(this.recordTimer);
    this.recordVideo?.remove();
    this.recordVideo = undefined;
    if (!recorder) return;
    recorder.stop();
    try {
      if (recorder.video.state === "configured") await recorder.video.flush();
      if (recorder.audio.state === "configured") await recorder.audio.flush();
      recorder.muxer.finalize();
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : String(error) });
    }
    if (recorder.video.state !== "closed") recorder.video.close();
    if (recorder.audio.state !== "closed") recorder.audio.close();
    const bytes = new Uint8Array(recorder.muxer.target.buffer);
    const name = `LokaMeet-${new Date().toISOString().replace(/[:.]/g, "-")}.mp4`;
    let saved = "";
    try {
      if (bytes.byteLength > 32) saved = await api.invoke<string>("saveRecording", { name, bytes });
    } catch (error) {
      this.patch({ error: error instanceof Error ? error.message : String(error) });
    }
    this.patch({ recording: false, recStarted: 0 });
    void api.invoke("setBusy", { recording: false });
    if (mode === "p2p") await api.invoke("signal", { peerId, payload: { t: "recording", on: false } });
    if (mode === "conf") await api.invoke("confNotify", { roomId, hostId, on: false });
    this.note(chatId, `sys:rec-off\t${who}`);
    const folder = saved || this.settings?.recordDir || "";
    if (folder) this.note(chatId, `sys:rec-saved\t${who}\t${folder}`, true);
  }

  private async leaveConference(notify: boolean): Promise<void> {
    if (this.leaving || this.state.phase === "idle" || this.state.mode !== "conf") return;
    this.leaving = true;
    try {
      if (notify && this.state.hostId && this.state.hostId !== this.state.selfId) {
        await api.invoke("sfu", { op: "leave", hostId: this.state.hostId, data: { peerId: this.state.selfId } });
      }
      this.sendTransport?.close();
      this.recvTransport?.close();
      this.producers = [];
      for (const item of this.consumers.values()) item.audio?.stop();
      this.consumers.clear();
      this.device = undefined;
      this.resetCall();
    } finally {
      this.leaving = false;
    }
  }

  private resetCall(): void {
    this.stopLink();
    const previous = this.state;
    if (!this.callLogged && shouldLogCall(previous.phase, this.callWay)) {
      this.callLogged = true;
      const direction = callDirection({ way: this.callWay, phase: previous.phase, started: previous.started });
      const record = {
        id: this.callId || crypto.randomUUID(),
        title: this.remoteName || this.placeName || previous.roomId || previous.peerId || "LokaMeet",
        peerId: previous.peerId || undefined,
        roomId: previous.roomId || undefined,
        direction,
        video: previous.video || previous.shareOn || previous.controlling,
        ts: previous.started || Date.now(),
        duration: previous.started ? Date.now() - previous.started : 0,
      };
      this.slog("call-log", record as unknown as Record<string, unknown>);
      void api.invoke("logCall", record);
    }
    window.clearInterval(this.ringTimer);
    if (this.recorder) void this.stopRecord();
    this.shareMix?.stop();
    this.shareMix = undefined;
    this.shareDuck?.stop();
    this.shareDuck = undefined;
    this.rawScreen = undefined;
    this.shareCleanup?.();
    this.shareCleanup = undefined;
    this.shareSources = [];
    this.deskSourceId = "";
    this.dropDeskLink();
    this.cameraStop?.();
    this.cameraStop = undefined;
    this.cameraSender = undefined;
    this.cameraProducer = undefined;
    this.screenSender = undefined;
    this.screenAudioSender = undefined;
    this.screenProducer = undefined;
    this.screenAudioProducer = undefined;
    this.screenAudioTrack = undefined;
    this.micProducer = undefined;
    this.local?.stop();
    this.local = undefined;
    this.remoteAudio?.stop();
    this.shareAudio?.stop();
    this.remoteAudio = undefined;
    this.shareAudio = undefined;
    window.clearTimeout(this.screenWait);
    this.pc?.close();
    this.pc = undefined;
    this.dc = undefined;
    this.desk = undefined;
    this.screenSender = undefined;
    this.remoteStream = new MediaStream();
    this.screenTrack = undefined;
    void api.invoke("setBusy", { inCall: false });
    this.notedCall = false;
    this.mediaReady = false;
    this.makingOffer = false;
    this.wantOffer = false;
    this.negotiateAfter = 0;
    this.expectScreenId = "";
    this.placeName = "";
    this.controlGrant = "";
    this.callWay = undefined;
    this.callLogged = false;
    this.expectScreenId = "";
    void api.invoke("injectInput", { t: "end" });
    const invite = previous.invite;
    this.state = { ...emptyState(), selfId: this.state.selfId, selfName: this.state.selfName, invite };
    this.listeners.forEach((listener) => listener());
  }

  private chatOf(): string {
    if (this.state.mode === "conf" && this.state.roomId) return roomChat(this.state.roomId);
    if (this.state.peerId) return dmChat(this.state.peerId);
    return "";
  }

  private chatWith(peerId: string): string {
    if (this.state.mode === "conf" && this.state.roomId) return roomChat(this.state.roomId);
    if (peerId) return dmChat(peerId);
    return this.chatOf();
  }

  private note(chatId: string, text: string, local = false): void {
    if (!chatId || !text) return;
    void api.invoke("systemChat", { chatId, text, local });
  }

  private slog(event: string, data: Record<string, unknown> = {}): void {
    void api.invoke("sessionLog", { event, ...data, self: this.state.selfId.slice(0, 6), phase: this.state.phase, mode: this.state.mode });
  }
}

function emptyState(): EngineState {
  return {
    phase: "idle",
    mode: null,
    peerId: "",
    roomId: "",
    hostId: "",
    video: false,
    micOn: true,
    camOn: false,
    shareOn: false,
    started: 0,
    tiles: [],
    stageId: "",
    pinnedId: "",
    levels: {},
    recording: false,
    recorders: [],
    link: 0,
    selfId: "",
    selfName: "",
    error: "",
    invite: undefined,
    controlling: false,
    controlled: false,
    controlPeerId: "",
    controlPending: false,
    controlSize: { w: 1920, h: 1080 },
    controlGrant: "",
    controlledBy: "",
    recStarted: 0,
    recTimes: {},
    mutedPeers: [],
  };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, item) => sum + item.byteLength, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.byteLength;
  }
  return out;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mixShare(screenTrack: MediaStreamTrack): ShareMix {
  const settings = screenTrack.getSettings();
  const srcW = settings.width && settings.width > 16 ? settings.width : 1920;
  const srcH = settings.height && settings.height > 16 ? settings.height : 1080;
  const scale = Math.min(1, 1920 / srcW, 1080 / srcH);
  const width = Math.max(2, Math.round((srcW * scale) / 2) * 2);
  const height = Math.max(2, Math.round((srcH * scale) / 2) * 2);
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;left:0;top:0;width:640px;height:360px;opacity:0.01;pointer-events:none;z-index:-1";
  const video = document.createElement("video");
  const camVideo = document.createElement("video");
  for (const node of [video, camVideo]) {
    node.muted = true;
    node.playsInline = true;
    node.autoplay = true;
    node.style.cssText = "width:640px;height:360px";
    holder.append(node);
  }
  video.srcObject = new MediaStream([screenTrack]);
  document.body.append(holder);
  void video.play().catch(() => undefined);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { alpha: false });
  let camera: MediaStreamTrack | null = null;
  let stopped = false;
  const out = canvas.captureStream(30).getVideoTracks()[0];
  out.enabled = true;
  const draw = () => {
    if (!ctx || stopped) return;
    if (video.paused) void video.play().catch(() => undefined);
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, width, height);
    if (video.readyState >= 2 && video.videoWidth > 0) {
      const fit = Math.min(width / video.videoWidth, height / video.videoHeight);
      const dw = video.videoWidth * fit;
      const dh = video.videoHeight * fit;
      ctx.drawImage(video, (width - dw) / 2, (height - dh) / 2, dw, dh);
    }
    if (camera && camVideo.readyState >= 2 && camVideo.videoWidth > 0) {
      const size = Math.round(Math.min(width, height) * 0.28);
      const pad = Math.round(size * 0.14);
      const x = width - size - pad;
      const y = height - size - pad;
      const radius = Math.round(size * 0.18);
      const cover = Math.max(size / camVideo.videoWidth, size / camVideo.videoHeight);
      const dw = camVideo.videoWidth * cover;
      const dh = camVideo.videoHeight * cover;
      ctx.save();
      roundRect(ctx, x, y, size, size, radius);
      ctx.clip();
      ctx.drawImage(camVideo, x + (size - dw) / 2, y + (size - dh) / 2, dw, dh);
      ctx.restore();
    }
  };
  draw();
  const timer = window.setInterval(draw, 1000 / 30);
  return {
    track: out,
    setCamera: (track) => {
      camera = track;
      if (!track) {
        camVideo.pause();
        camVideo.srcObject = null;
        return;
      }
      camVideo.srcObject = new MediaStream([track]);
      void camVideo.play().catch(() => undefined);
    },
    stop: () => {
      stopped = true;
      window.clearInterval(timer);
      out.stop();
      video.pause();
      camVideo.pause();
      video.srcObject = null;
      camVideo.srcObject = null;
      holder.remove();
    },
  };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + width, y, x + width, y + height, radius);
  ctx.arcTo(x + width, y + height, x, y + height, radius);
  ctx.arcTo(x, y + height, x, y, radius);
  ctx.arcTo(x, y, x + width, y, radius);
  ctx.closePath();
}

function compositeScreens(streams: MediaStream[]): { track: MediaStreamTrack; stop: () => void } {
  const holder = document.createElement("div");
  holder.setAttribute("aria-hidden", "true");
  holder.style.cssText = "position:fixed;width:2px;height:2px;left:-9999px;opacity:0;pointer-events:none;overflow:hidden";
  const videos = streams.map((stream) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = new MediaStream(stream.getVideoTracks());
    holder.append(video);
    void video.play().catch(() => undefined);
    return video;
  });
  document.body.append(holder);
  const cols = Math.ceil(Math.sqrt(videos.length));
  const rows = Math.ceil(videos.length / cols);
  const canvas = document.createElement("canvas");
  canvas.width = 2560;
  canvas.height = 1440;
  const ctx = canvas.getContext("2d");
  let frame = 0;
  const draw = () => {
    frame = requestAnimationFrame(draw);
    if (!ctx) return;
    ctx.fillStyle = "#05070c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    const cellW = canvas.width / cols;
    const cellH = canvas.height / rows;
    videos.forEach((video, index) => {
      if (video.readyState < 2) return;
      ctx.drawImage(video, (index % cols) * cellW, Math.floor(index / cols) * cellH, cellW, cellH);
    });
  };
  frame = requestAnimationFrame(draw);
  const track = canvas.captureStream(60).getVideoTracks()[0];
  return {
    track,
    stop: () => {
      cancelAnimationFrame(frame);
      streams.forEach((stream) => stream.getTracks().forEach((item) => item.stop()));
      track.stop();
      holder.remove();
    },
  };
}

const micCodec = {
  opusStereo: false,
  opusFec: true,
  opusDtx: false,
  opusMaxPlaybackRate: 48000,
  opusMaxAverageBitrate: 128000,
  opusPtime: 20,
  opusNack: true,
};

function favorAudioSender(sender: RTCRtpSender): void {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = 128_000;
  params.encodings[0].priority = "high";
  params.encodings[0].networkPriority = "high";
  void sender.setParameters(params).catch(() => undefined);
}

function favorScreenAudioSender(sender: RTCRtpSender): void {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = 96_000;
  params.encodings[0].priority = "medium";
  params.encodings[0].networkPriority = "medium";
  void sender.setParameters(params).catch(() => undefined);
}

function yieldVideoSender(sender: RTCRtpSender): void {
  const params = sender.getParameters();
  if (!params.encodings?.length) params.encodings = [{}];
  params.encodings[0].maxBitrate = 12_000_000;
  params.encodings[0].maxFramerate = 60;
  params.encodings[0].priority = "high";
  params.encodings[0].networkPriority = "high";
  params.degradationPreference = "maintain-framerate";
  void sender.setParameters(params).catch(() => undefined);
}

async function lockShareRate(stream: MediaStream): Promise<void> {
  const track = stream.getVideoTracks()[0];
  if (!track) return;
  const rate = track.getSettings().frameRate ?? 0;
  if (rate >= 59) return;
  try {
    await track.applyConstraints({ frameRate: { ideal: 60, max: 60 }, width: { max: 2560 }, height: { max: 1440 } });
  } catch {
    /* this display will not lock 60 */
  }
}

export const engine = new Engine();
