import { FilesetResolver, ImageSegmenter } from "@mediapipe/tasks-vision";

export type CameraPresetId =
  | "room"
  | "office"
  | "beach"
  | "nature"
  | "mountain"
  | "loft"
  | "cafe"
  | "bookshelf"
  | "studio"
  | "conference"
  | "brick";
export type CameraBackgroundMode = "none" | "blur" | "preset" | "custom";

export type CameraFxOptions = {
  cropZoom: number;
  cropPanX: number;
  cropPanY: number;
  backgroundMode: CameraBackgroundMode;
  presetId: CameraPresetId;
  blurAmount: number;
  customId: string | null;
  customDataUrl: string | null;
};

export const CAMERA_PRESETS: Array<{ id: CameraPresetId; file: string }> = [
  { id: "room", file: "room.png" },
  { id: "office", file: "office.png" },
  { id: "beach", file: "beach.png" },
  { id: "nature", file: "nature.png" },
  { id: "mountain", file: "mountain.png" },
  { id: "loft", file: "loft.png" },
  { id: "cafe", file: "cafe.png" },
  { id: "bookshelf", file: "bookshelf.png" },
  { id: "studio", file: "studio.png" },
  { id: "conference", file: "conference.png" },
  { id: "brick", file: "brick.png" }
];

export const defaultCameraFxOptions: CameraFxOptions = {
  cropZoom: 1,
  cropPanX: 0,
  cropPanY: 0,
  backgroundMode: "none",
  presetId: "room",
  blurAmount: 55,
  customId: null,
  customDataUrl: null
};

export function cameraBgAssetUrl(file: string): string {
  return assetUrl(`camera-bg/${file}`);
}

function clampUnit(value: unknown, fallback = 0) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(-1, Math.min(1, n));
}

function smoothstep(edge0: number, edge1: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - edge0) / Math.max(1e-6, edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function normalizeCameraFxOptions(raw?: Partial<CameraFxOptions> | null): CameraFxOptions {
  const preset = CAMERA_PRESETS.some((p) => p.id === raw?.presetId) ? (raw!.presetId as CameraPresetId) : "room";
  const mode = raw?.backgroundMode;
  return {
    cropZoom: Math.max(1, Math.min(2.5, Number(raw?.cropZoom ?? 1) || 1)),
    cropPanX: clampUnit(raw?.cropPanX),
    cropPanY: clampUnit(raw?.cropPanY),
    backgroundMode: mode === "blur" || mode === "preset" || mode === "custom" ? mode : "none",
    presetId: preset,
    blurAmount: Math.max(0, Math.min(100, Number(raw?.blurAmount ?? 55) || 0)),
    customId: typeof raw?.customId === "string" && raw.customId ? raw.customId : null,
    customDataUrl: typeof raw?.customDataUrl === "string" && raw.customDataUrl ? raw.customDataUrl : null
  };
}

export function cameraFxNeedsProcessing(_options?: CameraFxOptions): boolean {
  // Исходящий поток всегда зеркалится, чтобы собеседники видели кадр так же, как локальное превью.
  return true;
}

const rawCameraTracks = new WeakSet<MediaStreamTrack>();

export function markRawCameraTrack(track: MediaStreamTrack | null | undefined) {
  if (track && track.kind === "video") rawCameraTracks.add(track);
}

export function isRawCameraTrack(track: MediaStreamTrack | null | undefined): boolean {
  return Boolean(track && rawCameraTracks.has(track));
}

function assetUrl(rel: string): string {
  const resolved = new URL(rel, document.baseURI).href;
  return resolved.replace("/app.asar/", "/app.asar.unpacked/").replace("\\app.asar\\", "\\app.asar.unpacked\\");
}

function createCanvas(): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = 640;
  c.height = 480;
  return c;
}

function drawCover(ctx: CanvasRenderingContext2D, img: CanvasImageSource, w: number, h: number) {
  const iw = "naturalWidth" in img && typeof img.naturalWidth === "number" && img.naturalWidth ? img.naturalWidth : w;
  const ih = "naturalHeight" in img && typeof img.naturalHeight === "number" && img.naturalHeight ? img.naturalHeight : h;
  const ir = iw / Math.max(1, ih);
  const cr = w / Math.max(1, h);
  let dw: number;
  let dh: number;
  if (ir > cr) {
    dh = h;
    dw = h * ir;
  } else {
    dw = w;
    dh = w / ir;
  }
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("background image failed"));
    img.src = src;
  });
}

class CameraFxEngine {
  private readonly video = document.createElement("video");
  private readonly canvas = createCanvas();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly personCanvas = createCanvas();
  private readonly personCtx: CanvasRenderingContext2D;
  private readonly maskCanvas = createCanvas();
  private readonly maskCtx: CanvasRenderingContext2D;
  private readonly blurCanvas = createCanvas();
  private readonly blurCtx: CanvasRenderingContext2D;
  private readonly blur2Canvas = createCanvas();
  private readonly blur2Ctx: CanvasRenderingContext2D;
  private readonly softMaskCanvas = createCanvas();
  private readonly softMaskCtx: CanvasRenderingContext2D;
  private readonly bgCanvas = createCanvas();
  private readonly bgCtx: CanvasRenderingContext2D;
  private readonly overlayCanvas = createCanvas();
  private readonly overlayCtx: CanvasRenderingContext2D;
  private readonly smallCanvas = document.createElement("canvas");
  private readonly smallCtx: CanvasRenderingContext2D;
  private output: MediaStream | null = null;
  private raf = 0;
  private options: CameraFxOptions = { ...defaultCameraFxOptions };
  private bgCache = new Map<string, HTMLImageElement>();
  private customImage: HTMLImageElement | null = null;
  private segmenter: ImageSegmenter | null = null;
  private segmenterLoading: Promise<ImageSegmenter | null> | null = null;
  private invertMask = false;
  private invertChecked = false;
  private invertVotes = 0;
  private maskReady = false;
  private prevMaskAlpha: Float32Array | null = null;
  private frameIndex = 0;
  private running = false;
  private boundRaw: MediaStream | null = null;

  constructor() {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "true");
    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    this.personCtx = this.personCanvas.getContext("2d", { alpha: true, desynchronized: true })!;
    this.maskCtx = this.maskCanvas.getContext("2d", { alpha: true })!;
    this.blurCtx = this.blurCanvas.getContext("2d", { alpha: false, desynchronized: true })!;
    this.blur2Ctx = this.blur2Canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    this.softMaskCtx = this.softMaskCanvas.getContext("2d", { alpha: true })!;
    this.bgCtx = this.bgCanvas.getContext("2d", { alpha: true, desynchronized: true })!;
    this.overlayCtx = this.overlayCanvas.getContext("2d", { alpha: true, desynchronized: true })!;
    this.smallCanvas.width = 480;
    this.smallCanvas.height = 270;
    this.smallCtx = this.smallCanvas.getContext("2d", { alpha: false })!;
  }

  getOutputStream(): MediaStream {
    if (!this.output) this.output = this.canvas.captureStream(30);
    return this.output;
  }

  getOutputTrack(): MediaStreamTrack | null {
    return this.getOutputStream().getVideoTracks()[0] ?? null;
  }

  setOptions(patch: Partial<CameraFxOptions>) {
    const prevMode = this.options.backgroundMode;
    const prevPreset = this.options.presetId;
    this.options = normalizeCameraFxOptions({ ...this.options, ...patch });
    if (this.options.backgroundMode !== prevMode || this.options.presetId !== prevPreset) {
      this.resetMaskState();
    }
    if (this.options.backgroundMode === "preset") void this.ensurePreset(this.options.presetId);
    if (this.options.backgroundMode === "custom") void this.ensureCustom(this.options.customDataUrl);
    if (this.needsSegmenter()) void this.ensureSegmenter();
  }

  getOptions(): CameraFxOptions {
    return this.options;
  }

  async bind(raw: MediaStream) {
    this.boundRaw = raw;
    this.resetMaskState();
    this.video.srcObject = raw;
    await this.video.play().catch(() => undefined);
    await this.waitForFrame();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw && vh) this.resize(vw, vh);
    this.ensureLoop();
    if (this.needsSegmenter()) void this.ensureSegmenter();
  }

  stop(opts?: { stopOutput?: boolean }) {
    this.running = false;
    if (this.raf) {
      cancelAnimationFrame(this.raf);
      this.raf = 0;
    }
    this.video.srcObject = null;
    this.boundRaw = null;
    if (opts?.stopOutput && this.output) {
      for (const t of this.output.getTracks()) {
        try {
          t.stop();
        } catch {
          // холст мог быть уже остановлен
        }
      }
      this.output = null;
    }
  }

  private needsSegmenter() {
    return this.options.backgroundMode === "blur" || this.options.backgroundMode === "preset" || this.options.backgroundMode === "custom";
  }

  private replacesBackground() {
    return this.options.backgroundMode === "preset" || this.options.backgroundMode === "custom";
  }

  private resetMaskState() {
    this.invertChecked = false;
    this.invertMask = false;
    this.invertVotes = 0;
    this.maskReady = false;
    this.prevMaskAlpha = null;
  }

  private waitForFrame(): Promise<void> {
    const video = this.video;
    if (video.videoWidth > 0 && video.readyState >= 2) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        video.removeEventListener("loadeddata", finish);
        video.removeEventListener("loadedmetadata", finish);
        window.clearTimeout(timer);
        resolve();
      };
      video.addEventListener("loadeddata", finish);
      video.addEventListener("loadedmetadata", finish);
      const timer = window.setTimeout(finish, 1000);
    });
  }

  private ensureLoop() {
    if (this.running) return;
    this.running = true;
    const tick = () => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(tick);
      try {
        this.draw();
      } catch {
        // кадр FX можно пропустить, чтобы превью не останавливалось
      }
    };
    this.raf = requestAnimationFrame(tick);
  }

  private resize(w: number, h: number) {
    const maxW = this.needsSegmenter() ? 1920 : 2560;
    if (w > maxW) {
      h = Math.max(1, Math.round((h * maxW) / w));
      w = maxW;
    }
    if (this.canvas.width === w && this.canvas.height === h) return;
    // captureStream чернеет, если менять размер холста после старта потока
    if (this.output) return;
    this.canvas.width = w;
    this.canvas.height = h;
    this.personCanvas.width = w;
    this.personCanvas.height = h;
  }

  private async ensurePreset(id: CameraPresetId) {
    if (this.bgCache.has(id)) return;
    const spec = CAMERA_PRESETS.find((p) => p.id === id);
    if (!spec) return;
    try {
      const img = await loadImage(cameraBgAssetUrl(spec.file));
      this.bgCache.set(id, img);
    } catch {
      // пресет подставится, когда файл станет доступен
    }
  }

  private async ensureCustom(url: string | null) {
    if (!url) {
      this.customImage = null;
      return;
    }
    if (this.customImage && this.customImage.src === url) return;
    try {
      this.customImage = await loadImage(url);
    } catch {
      this.customImage = null;
    }
  }

  private async ensureSegmenter() {
    if (this.segmenter) return this.segmenter;
    if (this.segmenterLoading) return this.segmenterLoading;
    this.segmenterLoading = (async () => {
      try {
        const wasmPath = assetUrl("mediapipe/wasm");
        const fileset = await FilesetResolver.forVisionTasks(wasmPath);
        const options = {
          runningMode: "VIDEO" as const,
          outputCategoryMask: false,
          outputConfidenceMasks: true
        };
        try {
          this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
            ...options,
            baseOptions: {
              modelAssetPath: assetUrl("mediapipe/selfie_segmenter_landscape.tflite"),
              delegate: "GPU"
            }
          });
        } catch {
          this.segmenter = await ImageSegmenter.createFromOptions(fileset, {
            ...options,
            baseOptions: {
              modelAssetPath: assetUrl("mediapipe/selfie_segmenter_landscape.tflite"),
              delegate: "CPU"
            }
          });
        }
        return this.segmenter;
      } catch {
        this.segmenter = null;
        return null;
      }
    })();
    return this.segmenterLoading;
  }

  private ingestMask(result: { confidenceMasks?: Array<{ getAsFloat32Array?: () => Float32Array; getAsUint8Array?: () => Uint8Array; width?: number; height?: number; close?: () => void }>; categoryMask?: { getAsUint8Array?: () => Uint8Array; width?: number; height?: number } }) {
    const conf = result.confidenceMasks?.[0];
    const cat = result.categoryMask;
    let width = this.smallCanvas.width;
    let height = this.smallCanvas.height;
    let alpha: Float32Array | Uint8Array | null = null;
    let asFloat = false;
    if (conf && typeof conf.getAsFloat32Array === "function") {
      try {
        alpha = conf.getAsFloat32Array();
        asFloat = true;
      } catch {
        alpha = typeof conf.getAsUint8Array === "function" ? conf.getAsUint8Array() : null;
      }
      width = conf.width ?? width;
      height = conf.height ?? height;
    } else if (cat && typeof cat.getAsUint8Array === "function") {
      alpha = cat.getAsUint8Array();
      width = cat.width ?? width;
      height = cat.height ?? height;
    }
    if (!alpha) return;
    if (this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
    }
    const img = this.maskCtx.createImageData(width, height);
    const px = width * height;
    const replaceBg = this.replacesBackground();
    const mix = replaceBg ? 0.78 : 0.62;
    const lo = replaceBg ? 0.46 : 0.38;
    const hi = replaceBg ? 0.7 : 0.64;
    const fresh = !this.prevMaskAlpha || this.prevMaskAlpha.length !== px;
    if (fresh) this.prevMaskAlpha = new Float32Array(px);
    const prev = this.prevMaskAlpha!;
    this.updateInvertFromMask(alpha, width, height, asFloat);
    for (let i = 0; i < px; i++) {
      let a = asFloat ? Number(alpha[i]) : Number(alpha[i]) > 0 ? 1 : 0;
      if (this.invertMask) a = 1 - a;
      if (!fresh) a = prev[i] * (1 - mix) + a * mix;
      prev[i] = a;
      // Неуверенный ореол вокруг рук (~0.3–0.5) иначе рисует тёмную комнату поверх пресета.
      a = smoothstep(lo, hi, a);
      if (replaceBg) a = a * a * (3 - 2 * a);
      const byte = Math.max(0, Math.min(255, Math.round(a * 255)));
      const o = i * 4;
      img.data[o] = 255;
      img.data[o + 1] = 255;
      img.data[o + 2] = 255;
      img.data[o + 3] = byte;
    }
    this.maskCtx.putImageData(img, 0, 0);
    if (this.softMaskCanvas.width !== width || this.softMaskCanvas.height !== height) {
      this.softMaskCanvas.width = width;
      this.softMaskCanvas.height = height;
    }
    this.softMaskCtx.clearRect(0, 0, width, height);
    this.softMaskCtx.filter = replaceBg ? "none" : "blur(0.8px)";
    this.softMaskCtx.drawImage(this.maskCanvas, 0, 0);
    this.softMaskCtx.filter = "none";
    this.maskReady = true;
    try {
      result.confidenceMasks?.forEach((m) => m.close?.());
    } catch {
      // маска могла быть одноразовой
    }
  }

  private sampleMaskAvg(
    alpha: Float32Array | Uint8Array,
    width: number,
    asFloat: boolean,
    x0: number,
    y0: number,
    x1: number,
    y1: number
  ) {
    let sum = 0;
    let n = 0;
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const v = alpha[y * width + x];
        sum += asFloat ? Number(v) : Number(v) > 0 ? 1 : 0;
        n++;
      }
    }
    return n ? sum / n : 0;
  }

  private updateInvertFromMask(alpha: Float32Array | Uint8Array, width: number, height: number, asFloat: boolean) {
    if (this.invertChecked || width < 8 || height < 8) return;
    const cx0 = Math.floor(width * 0.32);
    const cx1 = Math.floor(width * 0.68);
    const cy0 = Math.floor(height * 0.22);
    const cy1 = Math.floor(height * 0.82);
    const band = Math.max(2, Math.floor(Math.min(width, height) * 0.12));
    const center = this.sampleMaskAvg(alpha, width, asFloat, cx0, cy0, cx1, cy1);
    const corners =
      (this.sampleMaskAvg(alpha, width, asFloat, 0, 0, band, band) +
        this.sampleMaskAvg(alpha, width, asFloat, width - band, 0, width, band) +
        this.sampleMaskAvg(alpha, width, asFloat, 0, height - band, band, height) +
        this.sampleMaskAvg(alpha, width, asFloat, width - band, height - band, width, height)) /
      4;
    // selfie_segmenter: человек = высокие значения. Инвертируем только если углы явно «человек», а центр — фон.
    if (corners - center > 0.28 && corners > 0.45) this.invertVotes += 1;
    else if (center - corners > 0.12) this.invertVotes -= 1;
    if (this.invertVotes >= 4) {
      if (!this.invertMask) this.prevMaskAlpha = null;
      this.invertMask = true;
      this.invertChecked = true;
    } else if (this.invertVotes <= -2 || this.frameIndex > 24) {
      if (this.invertMask) this.prevMaskAlpha = null;
      this.invertMask = false;
      this.invertChecked = true;
    }
  }

  private drawBackgroundBlur(source: HTMLCanvasElement, w: number, h: number) {
    if (this.bgCanvas.width !== w || this.bgCanvas.height !== h) {
      this.bgCanvas.width = w;
      this.bgCanvas.height = h;
    }
    this.bgCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.bgCtx.globalCompositeOperation = "source-over";
    this.bgCtx.filter = "none";
    this.bgCtx.drawImage(source, 0, 0, w, h);
    if (this.maskReady) {
      this.bgCtx.save();
      this.bgCtx.globalCompositeOperation = "destination-out";
      this.bgCtx.filter = "blur(8px)";
      this.bgCtx.drawImage(this.softMaskCanvas, 0, 0, w, h);
      this.bgCtx.filter = "none";
      this.bgCtx.restore();
      const tw = Math.max(16, Math.round(w / 28));
      const th = Math.max(9, Math.round(h / 28));
      if (this.blurCanvas.width !== tw || this.blurCanvas.height !== th) {
        this.blurCanvas.width = tw;
        this.blurCanvas.height = th;
      }
      this.blurCtx.filter = "none";
      this.blurCtx.imageSmoothingEnabled = true;
      this.blurCtx.imageSmoothingQuality = "low";
      this.blurCtx.drawImage(source, 0, 0, tw, th);
      this.bgCtx.save();
      this.bgCtx.globalCompositeOperation = "destination-over";
      this.bgCtx.imageSmoothingEnabled = true;
      this.bgCtx.imageSmoothingQuality = "low";
      this.bgCtx.drawImage(this.blurCanvas, 0, 0, w, h);
      this.bgCtx.restore();
    }
    const amount = Math.max(0, Math.min(1, this.options.blurAmount / 100));
    const d1 = 3.6 + amount * 5.2;
    let w1 = Math.max(48, Math.round(w / d1));
    let h1 = Math.max(28, Math.round(h / d1));
    w1 += w1 % 2;
    h1 += h1 % 2;
    if (this.blurCanvas.width !== w1 || this.blurCanvas.height !== h1) {
      this.blurCanvas.width = w1;
      this.blurCanvas.height = h1;
    }
    this.blurCtx.filter = "none";
    this.blurCtx.imageSmoothingEnabled = true;
    this.blurCtx.imageSmoothingQuality = "low";
    this.blurCtx.drawImage(this.bgCanvas, 0, 0, w1, h1);

    const d2 = 1.45 + amount * 1.7;
    let w2 = Math.max(18, Math.round(w1 / d2));
    let h2 = Math.max(10, Math.round(h1 / d2));
    w2 += w2 % 2;
    h2 += h2 % 2;
    if (this.blur2Canvas.width !== w2 || this.blur2Canvas.height !== h2) {
      this.blur2Canvas.width = w2;
      this.blur2Canvas.height = h2;
    }
    const extra = 1.1 + amount * 2.6;
    this.blur2Ctx.filter = `blur(${extra.toFixed(2)}px)`;
    this.blur2Ctx.drawImage(this.blurCanvas, 0, 0, w2, h2);
    this.blur2Ctx.filter = "none";
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = "low";
    this.ctx.drawImage(this.blur2Canvas, 0, 0, w, h);
  }

  private draw() {
    const video = this.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    this.resize(vw, vh);
    const z = this.options.cropZoom;
    const sw = vw / z;
    const sh = vh / z;
    const maxSx = Math.max(0, vw - sw);
    const maxSy = Math.max(0, vh - sh);
    const sx = maxSx * (0.5 + this.options.cropPanX * 0.5);
    const sy = maxSy * (0.5 + this.options.cropPanY * 0.5);
    const w = this.canvas.width;
    const h = this.canvas.height;
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.filter = "none";

    if (!this.needsSegmenter()) {
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = "medium";
      ctx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
      this.applyMirror();
      return;
    }

    this.personCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.personCtx.globalCompositeOperation = "source-over";
    this.personCtx.filter = "none";
    this.personCtx.clearRect(0, 0, w, h);
    this.personCtx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);

    if (this.segmenter) {
      this.smallCtx.drawImage(this.personCanvas, 0, 0, this.smallCanvas.width, this.smallCanvas.height);
      try {
        this.segmenter.segmentForVideo(this.smallCanvas, performance.now(), (result) => this.ingestMask(result));
      } catch {
        // кадр сегментации можно пропустить без остановки превью
      }
    }
    this.frameIndex++;

    if (this.options.backgroundMode === "blur") {
      this.drawBackgroundBlur(this.personCanvas, w, h);
    } else {
      const img =
        this.options.backgroundMode === "custom" ? this.customImage : this.bgCache.get(this.options.presetId) ?? null;
      if (img && img.complete && img.naturalWidth) {
        drawCover(ctx, img, w, h);
      } else {
        ctx.drawImage(this.personCanvas, 0, 0, w, h);
        if (this.options.backgroundMode === "preset") void this.ensurePreset(this.options.presetId);
        if (this.options.backgroundMode === "custom") void this.ensureCustom(this.options.customDataUrl);
      }
    }

    if (this.maskReady) {
      this.ensureOverlaySize(w, h);
      this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
      this.overlayCtx.filter = "none";
      this.overlayCtx.globalCompositeOperation = "copy";
      this.overlayCtx.drawImage(this.personCanvas, 0, 0, w, h);
      this.overlayCtx.globalCompositeOperation = "destination-in";
      this.overlayCtx.imageSmoothingEnabled = true;
      this.overlayCtx.imageSmoothingQuality = this.replacesBackground() ? "low" : "medium";
      this.overlayCtx.drawImage(this.softMaskCanvas.width ? this.softMaskCanvas : this.maskCanvas, 0, 0, w, h);
      this.overlayCtx.globalCompositeOperation = "source-over";
      ctx.drawImage(this.overlayCanvas, 0, 0, w, h);
    }
    this.applyMirror();
  }

  private ensureOverlaySize(w: number, h: number) {
    if (this.overlayCanvas.width === w && this.overlayCanvas.height === h) return;
    this.overlayCanvas.width = w;
    this.overlayCanvas.height = h;
  }

  private applyMirror() {
    const w = this.canvas.width;
    const h = this.canvas.height;
    if (!w || !h) return;
    this.ensureOverlaySize(w, h);
    this.overlayCtx.filter = "none";
    this.overlayCtx.globalCompositeOperation = "copy";
    this.overlayCtx.setTransform(-1, 0, 0, 1, w, 0);
    this.overlayCtx.drawImage(this.canvas, 0, 0);
    this.overlayCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.overlayCtx.globalCompositeOperation = "source-over";
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.globalCompositeOperation = "source-over";
    this.ctx.drawImage(this.overlayCanvas, 0, 0);
  }
}

const engine = new CameraFxEngine();

export async function bindCameraFx(raw: MediaStream) {
  await engine.bind(raw);
}

export function setCameraFxOptions(patch: Partial<CameraFxOptions>) {
  engine.setOptions(patch);
}

export function getCameraFxOptions() {
  return engine.getOptions();
}

export function getCameraFxStream() {
  return engine.getOutputStream();
}

export function getCameraFxTrack() {
  return engine.getOutputTrack();
}

export function stopCameraFx(opts?: { stopOutput?: boolean }) {
  engine.stop(opts);
}
