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

function toUnpackedAsarUrl(url: string): string {
  return url.replace("/app.asar/", "/app.asar.unpacked/").replace("\\app.asar\\", "\\app.asar.unpacked\\");
}

function assetUrl(rel: string): string {
  const resolved = new URL(rel, document.baseURI).href;
  // WASM/tflite и фоны в portable читаются только как реальные файлы вне asar.
  return toUnpackedAsarUrl(resolved);
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

function loadImageOnce(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("background image failed"));
    img.src = src;
  });
}

async function loadImage(src: string): Promise<HTMLImageElement> {
  try {
    return await loadImageOnce(src);
  } catch {
    const alt = src.includes("app.asar.unpacked")
      ? src.replace("/app.asar.unpacked/", "/app.asar/").replace("\\app.asar.unpacked\\", "\\app.asar\\")
      : toUnpackedAsarUrl(src);
    if (alt !== src) return loadImageOnce(alt);
    throw new Error("background image failed");
  }
}

type MaskResult = {
  confidenceMasks?: Array<{
    getAsFloat32Array?: () => Float32Array;
    getAsUint8Array?: () => Uint8Array;
    width?: number;
    height?: number;
    close?: () => void;
  }>;
  categoryMask?: { getAsUint8Array?: () => Uint8Array; width?: number; height?: number; close?: () => void };
};

/**
 * Виртуальный фон: кадр кладётся в модель без растягивания, маска снимается
 * с той же области. Край чуть уводится внутрь силуэта, чтобы комната не
 * оставалась каймой за головой и плечами.
 */
class CameraFxEngine {
  private readonly video = document.createElement("video");
  private readonly canvas = createCanvas();
  private readonly ctx: CanvasRenderingContext2D;
  private readonly workCanvas = createCanvas();
  private readonly workCtx: CanvasRenderingContext2D;
  private readonly personCanvas = createCanvas();
  private readonly personCtx: CanvasRenderingContext2D;
  private readonly maskCanvas = createCanvas();
  private readonly maskCtx: CanvasRenderingContext2D;
  private readonly maskSoftCanvas = createCanvas();
  private readonly maskSoftCtx: CanvasRenderingContext2D;
  private readonly blurCanvas = createCanvas();
  private readonly blurCtx: CanvasRenderingContext2D;
  private readonly smallCanvas = document.createElement("canvas");
  private readonly smallCtx: CanvasRenderingContext2D;
  private output: MediaStream | null = null;
  private raf = 0;
  private lastDrawAt = 0;
  private options: CameraFxOptions = { ...defaultCameraFxOptions };
  private bgCache = new Map<string, HTMLImageElement>();
  private customImage: HTMLImageElement | null = null;
  private segmenter: ImageSegmenter | null = null;
  private segmenterLoading: Promise<ImageSegmenter | null> | null = null;
  private invertMask = false;
  private invertChecked = false;
  private invertVotes = 0;
  private invertFrames = 0;
  private maskReady = false;
  private lastSegTs = -1;
  private segmentBusy = false;
  private running = false;
  private boundRaw: MediaStream | null = null;
  private maskConf = new Float32Array(0);
  private maskSmooth = new Float32Array(0);
  private maskChokeA = new Float32Array(0);
  private maskChokeB = new Float32Array(0);
  /** Область кадра внутри 16:9 холста сегментации, без чёрных полей. */
  private segBox = { x: 0, y: 0, w: 640, h: 360 };

  constructor() {
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.setAttribute("playsinline", "true");
    this.ctx = this.canvas.getContext("2d", { alpha: false, desynchronized: true })!;
    this.workCtx = this.workCanvas.getContext("2d", { alpha: false, desynchronized: true })!;
    this.personCtx = this.personCanvas.getContext("2d", { alpha: true, desynchronized: true })!;
    this.maskCtx = this.maskCanvas.getContext("2d", { alpha: true })!;
    this.maskSoftCtx = this.maskSoftCanvas.getContext("2d", { alpha: true, desynchronized: true })!;
    this.blurCtx = this.blurCanvas.getContext("2d", { alpha: false, desynchronized: true })!;
    // 4× площадь нативного входа landscape-модели (256×144): MediaPipe отдаёт
    // float-маску уже в этом размере — край не превращается в «лесенку» на 1440p.
    this.smallCanvas.width = 640;
    this.smallCanvas.height = 360;
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
    this.options = normalizeCameraFxOptions({ ...this.options, ...patch });
    const nextNeeds = this.needsSegmenter();
    const prevNeeds = prevMode === "blur" || prevMode === "preset" || prevMode === "custom";
    if (nextNeeds && !prevNeeds) {
      this.maskReady = false;
      this.maskSmooth = new Float32Array(0);
    }
    if (!nextNeeds) this.maskReady = false;
    if (this.options.backgroundMode === "preset") void this.ensurePreset(this.options.presetId);
    if (this.options.backgroundMode === "custom") void this.ensureCustom(this.options.customDataUrl);
    if (nextNeeds) void this.ensureSegmenter();
  }

  getOptions(): CameraFxOptions {
    return this.options;
  }

  async bind(raw: MediaStream, opts?: { fitOutput?: boolean }) {
    this.boundRaw = raw;
    this.video.srcObject = raw;
    await this.video.play().catch(() => undefined);
    await this.waitForFrame();
    const vw = this.video.videoWidth;
    const vh = this.video.videoHeight;
    if (vw && vh) {
      const needResize = this.canvas.width !== vw || this.canvas.height !== vh;
      if (opts?.fitOutput && needResize && this.output) {
        for (const t of this.output.getTracks()) {
          try {
            t.stop();
          } catch {
            // холст пересоздадим под новый размер
          }
        }
        this.output = null;
      }
      this.resize(vw, vh);
    }
    this.ensureLoop();
    if (this.needsSegmenter()) void this.ensureSegmenter();
  }

  stop(opts?: { stopOutput?: boolean }) {
    this.running = false;
    if (this.raf) {
      window.cancelAnimationFrame(this.raf);
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
    const tick = (now: number) => {
      if (!this.running) return;
      this.raf = window.requestAnimationFrame(tick);
      if (now - this.lastDrawAt < 30) return;
      this.lastDrawAt = now;
      if (this.video.paused) void this.video.play().catch(() => undefined);
      try {
        this.draw();
      } catch {
        // кадр FX можно пропустить, чтобы превью не останавливалось
      }
    };
    this.raf = window.requestAnimationFrame(tick);
  }

  private resize(w: number, h: number) {
    const maxW = 3840;
    if (w > maxW) {
      h = Math.max(1, Math.round((h * maxW) / w));
      w = maxW;
    }
    if (this.canvas.width === w && this.canvas.height === h) return;
    // captureStream чернеет, если менять размер холста после старта потока
    if (this.output) return;
    this.canvas.width = w;
    this.canvas.height = h;
  }

  private processSize(outW: number, outH: number) {
    if (!this.needsSegmenter()) return { w: outW, h: outH };
    const maxW = 1920;
    if (outW <= maxW) return { w: outW, h: outH };
    return { w: maxW, h: Math.max(1, Math.round((outH * maxW) / outW)) };
  }

  private ensureWorkSize(w: number, h: number) {
    if (this.workCanvas.width !== w || this.workCanvas.height !== h) {
      this.workCanvas.width = w;
      this.workCanvas.height = h;
    }
    if (this.personCanvas.width !== w || this.personCanvas.height !== h) {
      this.personCanvas.width = w;
      this.personCanvas.height = h;
    }
    if (this.maskSoftCanvas.width !== w || this.maskSoftCanvas.height !== h) {
      this.maskSoftCanvas.width = w;
      this.maskSoftCanvas.height = h;
    }
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

  private ingestMask(result: MaskResult) {
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
    const px = width * height;
    if (this.maskConf.length !== px) this.maskConf = new Float32Array(px);
    for (let i = 0; i < px; i++) {
      this.maskConf[i] = asFloat ? Number(alpha[i]) : Number(alpha[i]) > 0 ? 1 : 0;
    }
    try {
      result.confidenceMasks?.forEach((m) => m.close?.());
      result.categoryMask?.close?.();
    } catch {
      // маска могла быть одноразовой
    }
    if (this.maskCanvas.width !== width || this.maskCanvas.height !== height) {
      this.maskCanvas.width = width;
      this.maskCanvas.height = height;
    }
    const img = this.maskCtx.createImageData(width, height);
    this.updateInvertFromMask(this.maskConf, width, height, true);
    const data = img.data;
    if (this.replacesBackground()) {
      // Рост маски быстрый, спад медленный: закрытое лицо не выедает голову, край не мигает.
      const fresh = this.maskSmooth.length !== px;
      if (fresh) this.maskSmooth = new Float32Array(px);
      for (let i = 0; i < px; i++) {
        let a = this.maskConf[i];
        if (this.invertMask) a = 1 - a;
        const prev = this.maskSmooth[i];
        a = fresh ? a : a >= prev ? prev * 0.35 + a * 0.65 : prev * 0.9 + a * 0.1;
        this.maskSmooth[i] = a;
      }
      const choked = this.chokeConfidence(this.maskSmooth, width, height);
      const lo = 0.3;
      const hi = 0.48;
      for (let i = 0; i < px; i++) {
        const a = choked[i] <= lo ? 0 : choked[i] >= hi ? 1 : smoothstep(lo, hi, choked[i]);
        const byte = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
        const o = i * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = byte;
      }
    } else {
      const lo = 0.28;
      const hi = 0.52;
      for (let i = 0; i < px; i++) {
        let a = this.maskConf[i];
        if (this.invertMask) a = 1 - a;
        a = a <= lo ? 0 : a >= hi ? 1 : smoothstep(lo, hi, a);
        const byte = a <= 0 ? 0 : a >= 1 ? 255 : Math.round(a * 255);
        const o = i * 4;
        data[o] = 255;
        data[o + 1] = 255;
        data[o + 2] = 255;
        data[o + 3] = byte;
      }
    }
    this.maskCtx.putImageData(img, 0, 0);
    this.maskReady = true;
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
    this.invertFrames += 1;
    if (corners - center > 0.32 && corners > 0.5) this.invertVotes += 1;
    else if (center - corners > 0.1) this.invertVotes -= 1;
    if (this.invertVotes >= 6) {
      this.invertMask = true;
      this.invertChecked = true;
    } else if (this.invertVotes <= -2 || this.invertFrames >= 18) {
      this.invertMask = false;
      this.invertChecked = true;
    }
  }

  private min4(src: Float32Array, w: number, h: number, dst: Float32Array) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      for (let x = 0; x < w; x++) {
        let m = src[row + x];
        if (x > 0) m = Math.min(m, src[row + x - 1]);
        if (x + 1 < w) m = Math.min(m, src[row + x + 1]);
        if (y > 0) m = Math.min(m, src[row - w + x]);
        if (y + 1 < h) m = Math.min(m, src[row + w + x]);
        dst[row + x] = m;
      }
    }
  }

  /** Два шага внутрь силуэта: кайма настоящей комнаты за головой уходит под новый фон. */
  private chokeConfidence(src: Float32Array, w: number, h: number): Float32Array {
    if (this.maskChokeA.length !== src.length) this.maskChokeA = new Float32Array(src.length);
    if (this.maskChokeB.length !== src.length) this.maskChokeB = new Float32Array(src.length);
    this.min4(src, w, h, this.maskChokeA);
    this.min4(this.maskChokeA, w, h, this.maskChokeB);
    return this.maskChokeB;
  }

  /** Кадр в холст модели с сохранением пропорций, иначе маска съезжает относительно спины и головы. */
  private paintSegmentInput(source: HTMLCanvasElement) {
    const dw = this.smallCanvas.width;
    const dh = this.smallCanvas.height;
    const sw = Math.max(1, source.width);
    const sh = Math.max(1, source.height);
    const scale = Math.min(dw / sw, dh / sh);
    const w = Math.max(1, Math.round(sw * scale));
    const h = Math.max(1, Math.round(sh * scale));
    const x = Math.floor((dw - w) / 2);
    const y = Math.floor((dh - h) / 2);
    this.segBox = { x, y, w, h };
    this.smallCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.smallCtx.fillStyle = "#000";
    this.smallCtx.fillRect(0, 0, dw, dh);
    this.smallCtx.drawImage(source, 0, 0, sw, sh, x, y, w, h);
  }

  private runSegmenter(source: HTMLCanvasElement) {
    if (!this.segmenter || this.segmentBusy) return;
    this.paintSegmentInput(source);
    const ts = Math.max(this.lastSegTs + 1, Math.round(performance.now()));
    this.lastSegTs = ts;
    this.segmentBusy = true;
    try {
      const result = this.segmenter.segmentForVideo(this.smallCanvas, ts) as MaskResult;
      this.ingestMask(result);
      this.segmentBusy = false;
    } catch {
      try {
        this.segmenter.segmentForVideo(this.smallCanvas, ts, (result) => {
          this.ingestMask(result);
          this.segmentBusy = false;
        });
      } catch {
        this.segmentBusy = false;
        this.segmenter = null;
        this.segmenterLoading = null;
        void this.ensureSegmenter();
      }
    }
  }

  private drawBackgroundBlur(source: HTMLCanvasElement, w: number, h: number) {
    const amount = Math.max(0, Math.min(1, this.options.blurAmount / 100));
    let tw = Math.max(64, Math.round(w / 8));
    let th = Math.max(36, Math.round(h / 8));
    tw += tw % 2;
    th += th % 2;
    if (this.blurCanvas.width !== tw || this.blurCanvas.height !== th) {
      this.blurCanvas.width = tw;
      this.blurCanvas.height = th;
    }
    const radius = 2 + amount * 7;
    this.blurCtx.filter = `blur(${radius.toFixed(1)}px)`;
    this.blurCtx.imageSmoothingEnabled = true;
    this.blurCtx.imageSmoothingQuality = "high";
    this.blurCtx.drawImage(source, 0, 0, tw, th);
    this.blurCtx.filter = "none";
    this.workCtx.imageSmoothingEnabled = true;
    this.workCtx.imageSmoothingQuality = "high";
    this.workCtx.drawImage(this.blurCanvas, 0, 0, w, h);
  }

  private blitMirrored(source: CanvasImageSource, w: number, h: number) {
    const ctx = this.ctx;
    ctx.setTransform(-1, 0, 0, 1, w, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "medium";
    ctx.drawImage(source, 0, 0, w, h);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  }

  private draw() {
    const video = this.video;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh || video.readyState < 2) return;
    this.resize(vw, vh);
    const outW = this.canvas.width;
    const outH = this.canvas.height;
    const z = this.options.cropZoom;
    const sw = vw / z;
    const sh = vh / z;
    const maxSx = Math.max(0, vw - sw);
    const maxSy = Math.max(0, vh - sh);
    const sx = maxSx * (0.5 + this.options.cropPanX * 0.5);
    const sy = maxSy * (0.5 + this.options.cropPanY * 0.5);

    if (!this.needsSegmenter()) {
      this.ctx.setTransform(-1, 0, 0, 1, outW, 0);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = "medium";
      this.ctx.drawImage(video, sx, sy, sw, sh, 0, 0, outW, outH);
      this.ctx.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }

    const proc = this.processSize(outW, outH);
    this.ensureWorkSize(proc.w, proc.h);
    const w = proc.w;
    const h = proc.h;

    this.personCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.personCtx.globalCompositeOperation = "source-over";
    this.personCtx.filter = "none";
    this.personCtx.clearRect(0, 0, w, h);
    this.personCtx.drawImage(video, sx, sy, sw, sh, 0, 0, w, h);
    this.runSegmenter(this.personCanvas);

    // Пока маски нет — отдаём живой кадр, без «пустого» фона и вспышки артефактов.
    if (!this.maskReady) {
      this.blitMirrored(this.personCanvas, outW, outH);
      return;
    }

    this.workCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.workCtx.globalCompositeOperation = "source-over";
    this.workCtx.filter = "none";

    if (this.options.backgroundMode === "blur") {
      this.drawBackgroundBlur(this.personCanvas, w, h);
    } else {
      const img =
        this.options.backgroundMode === "custom" ? this.customImage : this.bgCache.get(this.options.presetId) ?? null;
      if (img && img.complete && img.naturalWidth) {
        drawCover(this.workCtx, img, w, h);
      } else {
        this.workCtx.drawImage(this.personCanvas, 0, 0, w, h);
        if (this.options.backgroundMode === "preset") void this.ensurePreset(this.options.presetId);
        if (this.options.backgroundMode === "custom") void this.ensureCustom(this.options.customDataUrl);
      }
    }

    this.maskSoftCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.maskSoftCtx.globalCompositeOperation = "copy";
    this.maskSoftCtx.imageSmoothingEnabled = true;
    this.maskSoftCtx.imageSmoothingQuality = "high";
    const feather = this.replacesBackground() ? Math.min(2.4, Math.max(1.4, w / 800)) : 0.6;
    this.maskSoftCtx.filter = `blur(${feather.toFixed(2)}px)`;
    const mw = this.maskCanvas.width;
    const mh = this.maskCanvas.height;
    const maskScaleX = mw / this.smallCanvas.width;
    const maskScaleY = mh / this.smallCanvas.height;
    this.maskSoftCtx.drawImage(
      this.maskCanvas,
      this.segBox.x * maskScaleX,
      this.segBox.y * maskScaleY,
      this.segBox.w * maskScaleX,
      this.segBox.h * maskScaleY,
      0,
      0,
      w,
      h
    );
    this.maskSoftCtx.filter = "none";
    this.maskSoftCtx.globalCompositeOperation = "source-over";

    this.personCtx.globalCompositeOperation = "destination-in";
    this.personCtx.imageSmoothingEnabled = true;
    this.personCtx.imageSmoothingQuality = "high";
    this.personCtx.filter = "none";
    this.personCtx.drawImage(this.maskSoftCanvas, 0, 0, w, h);
    this.personCtx.globalCompositeOperation = "source-over";

    this.workCtx.drawImage(this.personCanvas, 0, 0, w, h);
    this.blitMirrored(this.workCanvas, outW, outH);
  }
}

const engine = new CameraFxEngine();

export async function bindCameraFx(raw: MediaStream, opts?: { fitOutput?: boolean }) {
  await engine.bind(raw, opts);
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
