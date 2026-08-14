import { bufferToBase64 } from "./bytes";
import { muxMp4, type Mp4Sample } from "./mp4Writer";

export type RecordSource = {
  id: string;
  label: string;
  stream: MediaStream;
  role: "camera" | "screen";
};

export type RecordingFormat = "mp4" | "avi";
export type RecordingQuality = "480p" | "720p" | "1080p" | "1440p";
export type RecordingFps = 15 | 24 | 30;
export type RecordingBitrate = "low" | "medium" | "high" | "max";

export type RecordingSettings = {
  format: RecordingFormat;
  quality: RecordingQuality;
  fps: RecordingFps;
  bitrate: RecordingBitrate;
};

export const RECORDING_SIZE: Record<RecordingQuality, { width: number; height: number }> = {
  "480p": { width: 854, height: 480 },
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 }
};

export const RECORDING_BITRATE: Record<RecordingBitrate, number> = {
  low: 1_500_000,
  medium: 3_500_000,
  high: 6_000_000,
  max: 12_000_000
};

const JPEG_QUALITY: Record<RecordingBitrate, number> = {
  low: 0.55,
  medium: 0.72,
  high: 0.85,
  max: 0.92
};

const WEBM_MIME_CANDIDATES = ["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"];
const AVC_CODECS = ["avc1.4D401F", "avc1.42001E", "avc1.640028"];

export function normalizeRecordingSettings(raw?: Partial<RecordingSettings> | null): RecordingSettings {
  const format = raw?.format === "avi" ? "avi" : "mp4";
  const quality =
    raw?.quality === "480p" || raw?.quality === "720p" || raw?.quality === "1440p" || raw?.quality === "1080p"
      ? raw.quality
      : "1080p";
  const fps = raw?.fps === 15 || raw?.fps === 24 || raw?.fps === 30 ? raw.fps : 30;
  const bitrate =
    raw?.bitrate === "low" || raw?.bitrate === "medium" || raw?.bitrate === "max" || raw?.bitrate === "high"
      ? raw.bitrate
      : "high";
  return { format, quality, fps, bitrate };
}

function pickWebmMime(): string {
  for (const type of WEBM_MIME_CANDIDATES) {
    if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(type)) return type;
  }
  return "video/webm";
}

function gridColumns(count: number) {
  if (count <= 1) return 1;
  if (count === 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  return 4;
}

function drawCover(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number
) {
  drawFitted(ctx, video, x, y, w, h, "cover");
}

function drawContain(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number
) {
  drawFitted(ctx, video, x, y, w, h, "contain");
}

function drawFitted(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  x: number,
  y: number,
  w: number,
  h: number,
  fit: "cover" | "contain"
) {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) {
    ctx.fillStyle = "#111827";
    ctx.fillRect(x, y, w, h);
    return;
  }
  const ir = vw / vh;
  const cr = w / Math.max(1, h);
  let dw: number;
  let dh: number;
  if (fit === "cover" ? ir > cr : ir < cr) {
    dh = h;
    dw = h * ir;
  } else {
    dw = w;
    dh = w / ir;
  }
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(video, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
  ctx.restore();
}

function drawPipCamera(
  ctx: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  label: string,
  canvasW: number,
  canvasH: number,
  index: number,
  total: number
) {
  const pipW = Math.round(Math.min(canvasW * 0.2, 360));
  const pipH = Math.round(pipW * 9 / 16);
  const margin = Math.max(12, Math.round(canvasW * 0.014));
  const gap = 10;
  const x = margin;
  const y = canvasH - margin - (total - index) * pipH - (total - 1 - index) * gap;
  ctx.save();
  ctx.beginPath();
  const r = 10;
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + pipW, y, x + pipW, y + pipH, r);
  ctx.arcTo(x + pipW, y + pipH, x, y + pipH, r);
  ctx.arcTo(x, y + pipH, x, y, r);
  ctx.arcTo(x, y, x + pipW, y, r);
  ctx.closePath();
  ctx.clip();
  ctx.fillStyle = "#0b0f16";
  ctx.fillRect(x, y, pipW, pipH);
  drawCover(ctx, video, x, y, pipW, pipH);
  ctx.restore();
  ctx.save();
  ctx.strokeStyle = "rgba(248, 250, 252, 0.85)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + pipW, y, x + pipW, y + pipH, r);
  ctx.arcTo(x + pipW, y + pipH, x, y + pipH, r);
  ctx.arcTo(x, y + pipH, x, y, r);
  ctx.arcTo(x, y, x + pipW, y, r);
  ctx.closePath();
  ctx.stroke();
  ctx.restore();
  drawLabel(ctx, label, x, y, pipW, pipH);
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  w: number,
  h: number,
  align: "bottom" | "top" = "bottom"
) {
  ctx.save();
  ctx.font = "600 18px Segoe UI, sans-serif";
  const padX = 10;
  const padY = 6;
  const tw = Math.min(w - 16, ctx.measureText(text).width + padX * 2);
  const th = 28;
  const lx = x + 10;
  const ly = align === "top" ? y + 10 : y + h - th - 10;
  ctx.fillStyle = "rgba(0,0,0,0.55)";
  ctx.fillRect(lx, ly, tw, th);
  ctx.fillStyle = "#f8fafc";
  ctx.fillText(text, lx + padX, ly + th - padY - 2, tw - padX * 2);
  ctx.restore();
}

function stitchSampleDurations(samples: Mp4Sample[]) {
  samples.sort((a, b) => a.timestamp - b.timestamp);
  for (let i = 0; i < samples.length; i++) {
    const next = samples[i + 1];
    if (next) samples[i].duration = Math.max(1, next.timestamp - samples[i].timestamp);
  }
}

function copyConfigDescription(raw: unknown): Uint8Array {
  if (raw instanceof Uint8Array) return raw.slice();
  if (raw instanceof ArrayBuffer) return new Uint8Array(raw).slice();
  if (ArrayBuffer.isView(raw)) {
    const view = raw as ArrayBufferView;
    const out = new Uint8Array(view.byteLength);
    const src = new Uint8Array(view.buffer as unknown as ArrayBuffer, view.byteOffset, view.byteLength);
    out.set(src);
    return out;
  }
  return new Uint8Array();
}

export type RecorderLog = (level: "INFO" | "WARN" | "ERROR", msg: string, data?: unknown) => void;

export type RecordingSink = {
  writeBytes: (base64: string) => Promise<boolean>;
  writeJpeg?: (base64: string) => Promise<boolean>;
  writePcm?: (base64: string) => Promise<boolean>;
};

export class CallRecorder {
  private readonly canvas = document.createElement("canvas");
  private readonly ctx: CanvasRenderingContext2D;
  private readonly host = document.createElement("div");
  private readonly videos = new Map<string, HTMLVideoElement>();
  private sources: RecordSource[] = [];
  private audioStreams: MediaStream[] = [];
  private recorder: MediaRecorder | null = null;
  private raf = 0;
  private drawTimer = 0;
  private running = false;
  private audioCtx: AudioContext | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private mixed: AudioNode[] = [];
  private silent: OscillatorNode | null = null;
  private processor: ScriptProcessorNode | null = null;
  private sink: RecordingSink | null = null;
  private log: RecorderLog | null = null;
  private format: RecordingFormat = "mp4";
  private fps = 30;
  private jpegQuality = 0.85;
  private videoBitsPerSecond = 6_000_000;
  private lastJpegAt = 0;
  private jpegBusy = false;
  private jpegCount = 0;
  private bytesWritten = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private mode: "webcodecs" | "webm" | "avi" = "webm";
  private videoEncoder: VideoEncoder | null = null;
  private audioEncoder: AudioEncoder | null = null;
  private avcC: Uint8Array | null = null;
  private audioDesc: Uint8Array | null = null;
  private videoSamples: Mp4Sample[] = [];
  private audioSamples: Mp4Sample[] = [];
  private frameIndex = 0;
  private lastEncodeAt = 0;
  private encodeStartAt = 0;
  private lastVideoTsUs = -1;
  private hadVideoFrame = false;
  private audioTimestampUs = 0;
  private sampleRate = 48000;

  constructor() {
    this.canvas.width = 1920;
    this.canvas.height = 1080;
    this.ctx = this.canvas.getContext("2d", { alpha: false })!;
    this.host.setAttribute("data-call-recorder", "true");
    // Кадры экрана не декодируются, если video полностью за экраном — оставляем крошечный on-screen хост.
    this.host.style.cssText =
      "position:fixed;left:0;top:0;width:160px;height:90px;opacity:0.02;pointer-events:none;overflow:hidden;z-index:0";
    this.canvas.style.cssText = "width:160px;height:90px;display:block";
    this.host.appendChild(this.canvas);
  }

  setInputs(sources: RecordSource[], audioStreams: MediaStream[]) {
    this.sources = sources;
    this.audioStreams = audioStreams;
    const keep = new Set(sources.map((s) => s.id));
    for (const [id, video] of this.videos) {
      if (keep.has(id)) continue;
      video.srcObject = null;
      video.remove();
      this.videos.delete(id);
    }
    for (const source of sources) this.ensureVideo(source);
    if (this.running) this.rebuildAudio();
  }

  async start(sink: RecordingSink, settings: RecordingSettings, log?: RecorderLog) {
    if (this.running) return;
    this.sink = sink;
    this.log = log ?? null;
    this.format = settings.format;
    this.fps = settings.fps;
    this.jpegQuality = JPEG_QUALITY[settings.bitrate];
    this.videoBitsPerSecond = RECORDING_BITRATE[settings.bitrate];
    const size = RECORDING_SIZE[settings.quality];
    this.canvas.width = size.width;
    this.canvas.height = size.height;
    if (!this.host.isConnected) document.body.appendChild(this.host);
    this.rebuildAudio();
    this.jpegCount = 0;
    this.bytesWritten = 0;
    this.frameIndex = 0;
    this.lastEncodeAt = 0;
    this.lastVideoTsUs = -1;
    this.hadVideoFrame = false;
    this.audioTimestampUs = 0;
    this.videoSamples = [];
    this.audioSamples = [];
    this.avcC = null;
    this.audioDesc = null;
    await this.waitForVideoFrames();
    this.draw();
    this.running = true;
    this.encodeStartAt = performance.now();
    this.startDrawLoop();
    if (this.format === "avi") {
      this.mode = "avi";
      this.log?.("INFO", "Recording started", { format: "avi", ...size, fps: this.fps, sources: this.sources.length });
      if (!this.sources.length) this.log?.("WARN", "Recording started without video sources");
      return;
    }
    const webcodecs = await this.tryStartWebCodecs();
    if (webcodecs) {
      this.mode = "webcodecs";
      this.log?.("INFO", "Recording started", {
        format: "mp4",
        encoder: "webcodecs",
        ...size,
        fps: this.fps,
        bitrate: this.videoBitsPerSecond,
        sources: this.sources.length
      });
      if (!this.sources.length) this.log?.("WARN", "Recording started without video sources");
      window.setTimeout(() => {
        if (!this.running || this.mode !== "webcodecs") return;
        if (this.videoSamples.length > 0) return;
        this.log?.("WARN", "WebCodecs produced no samples, switching to WebM");
        try {
          this.videoEncoder?.close();
        } catch {
          // игнор
        }
        this.videoEncoder = null;
        try {
          this.audioEncoder?.close();
        } catch {
          // игнор
        }
        this.audioEncoder = null;
        this.mode = "webm";
        void this.startWebmRecorder();
      }, 1500);
      return;
    }
    this.mode = "webm";
    await this.startWebmRecorder();
    this.log?.("INFO", "Recording started", {
      format: "mp4",
      encoder: "webm-fallback",
      mime: pickWebmMime(),
      ...size,
      fps: this.fps,
      sources: this.sources.length
    });
    if (!this.sources.length) this.log?.("WARN", "Recording started without video sources");
  }

  async stop() {
    this.running = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    if (this.drawTimer) {
      window.clearInterval(this.drawTimer);
      this.drawTimer = 0;
    }
    const recorder = this.recorder;
    this.recorder = null;
    if (recorder && recorder.state !== "inactive") {
      await new Promise<void>((resolve) => {
        const finish = () => resolve();
        recorder.addEventListener("stop", finish, { once: true });
        recorder.addEventListener("error", finish, { once: true });
        try {
          recorder.requestData();
        } catch {
          // финальный кусок может быть недоступен
        }
        try {
          recorder.stop();
        } catch {
          resolve();
        }
        window.setTimeout(finish, 4000);
      });
    }
    if (this.videoEncoder) {
      try {
        await this.videoEncoder.flush();
      } catch {
        // энкодер мог быть уже закрыт
      }
      try {
        this.videoEncoder.close();
      } catch {
        // игнор
      }
      this.videoEncoder = null;
    }
    if (this.audioEncoder) {
      try {
        await this.audioEncoder.flush();
      } catch {
        // игнор
      }
      try {
        this.audioEncoder.close();
      } catch {
        // игнор
      }
      this.audioEncoder = null;
    }
    await this.writeQueue;
    let wrote = this.bytesWritten > 64 || this.jpegCount > 0;
    if (this.mode === "webcodecs" && this.videoSamples.length && this.avcC) {
      try {
        stitchSampleDurations(this.videoSamples);
        const mp4 = muxMp4(
          {
            width: this.canvas.width,
            height: this.canvas.height,
            timescale: 1_000_000,
            avcC: this.avcC,
            samples: this.videoSamples
          },
          this.audioSamples.length && this.audioDesc
            ? {
                sampleRate: this.sampleRate,
                channelCount: 1,
                timescale: this.sampleRate,
                decSpecific: this.audioDesc,
                samples: this.audioSamples
              }
            : null
        );
        await this.writeBytesChunked(mp4);
        this.bytesWritten += mp4.byteLength;
        wrote = mp4.byteLength > 64;
        this.log?.("INFO", "Recording muxed", {
          bytes: mp4.byteLength,
          videoSamples: this.videoSamples.length,
          audioSamples: this.audioSamples.length
        });
      } catch (err) {
        this.log?.("ERROR", "Recording mux failed", { error: String(err) });
        wrote = false;
      }
    }
    this.teardownAudio();
    for (const video of this.videos.values()) {
      video.srcObject = null;
      video.remove();
    }
    this.videos.clear();
    this.sources = [];
    this.audioStreams = [];
    this.videoSamples = [];
    this.audioSamples = [];
    this.sink = null;
    this.host.remove();
    this.log?.("INFO", "Recording stopped", {
      wrote,
      bytesWritten: this.bytesWritten,
      mode: this.mode,
      jpegCount: this.jpegCount,
      hadVideo: this.hadVideoFrame
    });
    this.log = null;
    return wrote;
  }

  private async tryStartWebCodecs() {
    if (typeof VideoEncoder === "undefined" || typeof VideoFrame === "undefined") return false;
    const width = this.canvas.width;
    const height = this.canvas.height;
    let chosen: string | null = null;
    for (const codec of AVC_CODECS) {
      const cfg: VideoEncoderConfig = {
        codec,
        width,
        height,
        bitrate: this.videoBitsPerSecond,
        framerate: this.fps,
        avc: { format: "avc" },
        latencyMode: "realtime"
      };
      try {
        const support = await VideoEncoder.isConfigSupported(cfg);
        if (support.supported) {
          chosen = codec;
          break;
        }
      } catch {
        // кодек недоступен
      }
    }
    if (!chosen) {
      this.log?.("WARN", "WebCodecs H264 not supported, using WebM fallback", { width, height });
      return false;
    }
    try {
      const encoder = new VideoEncoder({
        output: (chunk, meta) => {
          if (meta?.decoderConfig?.description && !this.avcC) {
            this.avcC = copyConfigDescription(meta.decoderConfig.description);
          }
          const data = new Uint8Array(chunk.byteLength);
          chunk.copyTo(data);
          const duration = Math.max(1, chunk.duration || Math.round(1_000_000 / this.fps));
          this.videoSamples.push({ data, timestamp: chunk.timestamp, duration, keyframe: chunk.type === "key" });
        },
        error: (err) => this.log?.("ERROR", "VideoEncoder error", { error: String(err) })
      });
      encoder.configure({
        codec: chosen,
        width,
        height,
        bitrate: this.videoBitsPerSecond,
        framerate: this.fps,
        avc: { format: "avc" },
        latencyMode: "realtime"
      });
      this.videoEncoder = encoder;
    } catch (err) {
      this.log?.("WARN", "VideoEncoder configure failed", { error: String(err) });
      return false;
    }
    if (typeof AudioEncoder !== "undefined" && typeof AudioData !== "undefined") {
      try {
        const acfg: AudioEncoderConfig = {
          codec: "mp4a.40.2",
          numberOfChannels: 1,
          sampleRate: this.sampleRate,
          bitrate: 128_000
        };
        const support = await AudioEncoder.isConfigSupported(acfg);
        if (support.supported) {
          const audioEnc = new AudioEncoder({
            output: (chunk, meta) => {
              if (meta?.decoderConfig?.description && !this.audioDesc) {
                this.audioDesc = copyConfigDescription(meta.decoderConfig.description);
              }
              const data = new Uint8Array(chunk.byteLength);
              chunk.copyTo(data);
              const duration = Math.max(1, Math.round(((chunk.duration || 0) * this.sampleRate) / 1_000_000) || 1024);
              this.audioSamples.push({
                data,
                timestamp: chunk.timestamp,
                duration,
                keyframe: true
              });
            },
            error: (err) => this.log?.("WARN", "AudioEncoder error", { error: String(err) })
          });
          audioEnc.configure(acfg);
          this.audioEncoder = audioEnc;
        }
      } catch (err) {
        this.log?.("WARN", "AudioEncoder unavailable", { error: String(err) });
      }
    }
    return true;
  }

  private async startWebmRecorder() {
    const videoTrack = this.canvas.captureStream(this.fps).getVideoTracks()[0];
    const audioTrack = this.dest?.stream.getAudioTracks()[0];
    const mixed = new MediaStream();
    if (videoTrack) mixed.addTrack(videoTrack);
    if (audioTrack) mixed.addTrack(audioTrack);
    const mimeType = pickWebmMime();
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(mixed, {
        mimeType,
        videoBitsPerSecond: this.videoBitsPerSecond,
        audioBitsPerSecond: 128_000
      });
    } catch {
      recorder = new MediaRecorder(mixed);
    }
    recorder.ondataavailable = (ev) => {
      if (!ev.data || ev.data.size < 1) return;
      this.bytesWritten += ev.data.size;
      this.writeQueue = this.writeQueue
        .then(async () => {
          const buf = await ev.data.arrayBuffer();
          await this.writeBytesChunked(buf);
        })
        .catch((err) => {
          this.log?.("ERROR", "Recording chunk write failed", { error: String(err), size: ev.data.size });
        });
    };
    recorder.onerror = () => this.log?.("ERROR", "MediaRecorder error", { state: recorder.state });
    this.recorder = recorder;
    recorder.start(400);
  }

  private encodeCanvasFrame() {
    if (this.mode !== "webcodecs" || !this.videoEncoder || this.videoEncoder.state !== "configured") return;
    if (this.videoEncoder.encodeQueueSize > 4) return;
    const now = performance.now();
    if (now - this.lastEncodeAt < Math.max(8, 1000 / this.fps) - 2) return;
    this.lastEncodeAt = now;
    const timestamp = Math.max(0, Math.round((now - this.encodeStartAt) * 1000));
    const duration =
      this.lastVideoTsUs < 0 ? Math.round(1_000_000 / this.fps) : Math.max(1, timestamp - this.lastVideoTsUs);
    this.lastVideoTsUs = timestamp;
    try {
      const frame = new VideoFrame(this.canvas, { timestamp, duration });
      this.videoEncoder.encode(frame, { keyFrame: this.frameIndex % (this.fps * 2) === 0 });
      frame.close();
      this.frameIndex += 1;
    } catch (err) {
      this.log?.("WARN", "VideoFrame encode failed", { error: String(err) });
    }
  }

  private async writeBytesChunked(data: ArrayBuffer | Uint8Array) {
    const sink = this.sink;
    if (!sink) throw new Error("recording-sink-missing");
    const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const chunk = 256 * 1024;
    for (let i = 0; i < u8.length; i += chunk) {
      const slice = u8.subarray(i, i + chunk).slice();
      const ok = await sink.writeBytes(bufferToBase64(slice));
      if (!ok) throw new Error("recording-append-failed");
    }
  }

  private startDrawLoop() {
    const interval = Math.max(16, Math.round(1000 / this.fps));
    const tick = () => {
      if (!this.running) return;
      this.draw();
      if (this.format === "avi") this.maybeCaptureJpeg();
      else this.encodeCanvasFrame();
    };
    this.drawTimer = window.setInterval(tick, interval);
  }

  private maybeCaptureJpeg() {
    if (this.format !== "avi" || this.jpegBusy || !this.running) return;
    const now = performance.now();
    if (now - this.lastJpegAt < Math.max(20, 1000 / this.fps) - 4) return;
    this.lastJpegAt = now;
    this.jpegBusy = true;
    this.canvas.toBlob(
      (blob) => {
        if (!blob || !this.running || !this.sink?.writeJpeg) {
          this.jpegBusy = false;
          return;
        }
        void blob
          .arrayBuffer()
          .then((buf) => {
            this.jpegCount += 1;
            this.bytesWritten += buf.byteLength;
            const b64 = bufferToBase64(buf);
            this.writeQueue = this.writeQueue
              .then(() => this.sink?.writeJpeg?.(b64))
              .then(() => undefined)
              .catch((err) => {
                this.log?.("ERROR", "AVI jpeg write failed", { error: String(err) });
              });
          })
          .finally(() => {
            this.jpegBusy = false;
          });
      },
      "image/jpeg",
      this.jpegQuality
    );
  }

  private waitForVideoFrames(): Promise<void> {
    const deadline = Date.now() + 2000;
    return new Promise((resolve) => {
      const check = () => {
        const ready = [...this.videos.values()].some((v) => v.videoWidth > 0 && v.readyState >= 2);
        if (ready || Date.now() >= deadline) {
          resolve();
          return;
        }
        window.setTimeout(check, 50);
      };
      check();
    });
  }

  private ensureVideo(source: RecordSource) {
    const existing = this.videos.get(source.id);
    const video = existing ?? this.createVideoElement();
    if (!existing) this.videos.set(source.id, video);
    if (video.srcObject !== source.stream) {
      video.srcObject = source.stream;
      void video.play().catch(() => undefined);
    }
    return video;
  }

  private createVideoElement() {
    const node = document.createElement("video");
    node.muted = true;
    node.playsInline = true;
    node.autoplay = true;
    node.setAttribute("playsinline", "true");
    node.setAttribute("autoplay", "true");
    node.setAttribute("muted", "true");
    node.style.cssText = "width:160px;height:90px;object-fit:cover;display:block";
    node.addEventListener("loadedmetadata", () => {
      void node.play().catch(() => undefined);
    });
    this.host.appendChild(node);
    return node;
  }

  private rebuildAudio() {
    this.teardownAudio(false);
    const ctx = this.audioCtx ?? new AudioContext({ sampleRate: 48000 });
    this.audioCtx = ctx;
    this.sampleRate = ctx.sampleRate || 48000;
    void ctx.resume().catch(() => undefined);
    this.dest = ctx.createMediaStreamDestination();
    const mix = ctx.createGain();
    mix.connect(this.dest);
    this.mixed.push(mix);
    const seen = new Set<string>();
    const connect = (stream: MediaStream) => {
      for (const track of stream.getAudioTracks()) {
        if (track.readyState !== "live" || seen.has(track.id)) continue;
        seen.add(track.id);
        try {
          const src = ctx.createMediaStreamSource(new MediaStream([track]));
          src.connect(mix);
          this.mixed.push(src);
        } catch {
          // дорожка могла быть уже привязана к другому AudioContext
        }
      }
    };
    for (const source of this.sources) connect(source.stream);
    for (const stream of this.audioStreams) connect(stream);
    if (seen.size === 0) {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      osc.connect(gain);
      gain.connect(mix);
      osc.start();
      this.silent = osc;
      this.mixed.push(gain, osc);
    }
    const needPcm = this.format === "avi" || this.mode === "webcodecs" || this.format === "mp4";
    if (needPcm) {
      const proc = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      mix.connect(proc);
      proc.connect(mute);
      mute.connect(ctx.destination);
      proc.onaudioprocess = (ev) => {
        if (!this.running) return;
        const input = ev.inputBuffer.getChannelData(0);
        if (this.format === "avi" && this.sink?.writePcm) {
          const pcm = new Int16Array(input.length);
          for (let i = 0; i < input.length; i++) {
            const s = Math.max(-1, Math.min(1, input[i]));
            pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
          }
          const b64 = bufferToBase64(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
          this.writeQueue = this.writeQueue.then(() => this.sink?.writePcm?.(b64)).then(() => undefined);
        }
        if (this.audioEncoder && this.audioEncoder.state === "configured" && typeof AudioData !== "undefined") {
          try {
            const copy = Float32Array.from(input);
            const data = new AudioData({
              format: "f32-planar",
              sampleRate: this.sampleRate,
              numberOfFrames: copy.length,
              numberOfChannels: 1,
              timestamp: this.audioTimestampUs,
              data: copy
            });
            this.audioTimestampUs += Math.round((copy.length / this.sampleRate) * 1_000_000);
            this.audioEncoder.encode(data);
            data.close();
          } catch {
            // кадр звука можно пропустить
          }
        }
      };
      this.processor = proc;
      this.mixed.push(proc, mute);
    }
  }

  private teardownAudio(closeCtx = true) {
    if (this.processor) {
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    for (const node of this.mixed) {
      try {
        node.disconnect();
      } catch {
        // узел уже отключён
      }
    }
    this.mixed = [];
    if (this.silent) {
      try {
        this.silent.stop();
      } catch {
        // осциллятор мог быть уже остановлен
      }
      this.silent = null;
    }
    this.dest = null;
    if (closeCtx && this.audioCtx) {
      void this.audioCtx.close().catch(() => undefined);
      this.audioCtx = null;
    }
  }

  private draw() {
    const ctx = this.ctx;
    const w = this.canvas.width;
    const h = this.canvas.height;
    ctx.fillStyle = "#0b0f16";
    const live = this.sources
      .map((source) => ({ source, video: this.videos.get(source.id) }))
      .filter((item): item is { source: RecordSource; video: HTMLVideoElement } => Boolean(item.video));
    const hasFrame = (video: HTMLVideoElement) => video.videoWidth > 0 && video.readyState >= 2;
    const screens = live.filter((item) => item.source.role === "screen" && hasFrame(item.video));
    const cams = live.filter((item) => item.source.role === "camera" && hasFrame(item.video));
    if (!screens.length && !cams.length) {
      if (this.hadVideoFrame) return;
      ctx.fillRect(0, 0, w, h);
      return;
    }
    this.hadVideoFrame = true;
    ctx.fillRect(0, 0, w, h);
    if (screens.length) {
      const main = screens[0];
      drawContain(ctx, main.video, 0, 0, w, h);
      drawLabel(ctx, main.source.label, 0, 0, w, h, cams.length ? "top" : "bottom");
      cams.forEach((item, i) => {
        drawPipCamera(ctx, item.video, item.source.label, w, h, i, cams.length);
      });
      return;
    }
    const count = Math.max(1, cams.length);
    const cols = gridColumns(count);
    const rows = Math.ceil(count / cols);
    const cellW = w / cols;
    const cellH = h / rows;
    if (!cams.length) return;
    cams.forEach((item, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = Math.round(col * cellW);
      const y = Math.round(row * cellH);
      const cw = Math.round(cellW);
      const ch = Math.round(cellH);
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, cw, ch);
      ctx.clip();
      drawCover(ctx, item.video, x, y, cw, ch);
      ctx.restore();
      drawLabel(ctx, item.source.label, x, y, cw, ch);
    });
  }
}

export function recordingFileName(date = new Date(), format: RecordingFormat = "mp4") {
  const pad = (n: number) => String(n).padStart(2, "0");
  const ext = format === "avi" ? "avi" : "mp4";
  return `LokaMeet-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}.${ext}`;
}
