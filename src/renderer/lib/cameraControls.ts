export type CameraModeName = "continuous" | "manual" | "single-shot" | "none";
export type CameraFocusMode = CameraModeName;
export type CameraExposureMode = CameraModeName;
export type CameraWhiteBalanceMode = CameraModeName;

export type CameraControls = {
  focusMode: CameraFocusMode;
  focusDistance?: number;
  exposureMode: CameraExposureMode;
  exposureCompensation?: number;
  exposureTime?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  zoom?: number;
  pan?: number;
  tilt?: number;
  whiteBalanceMode: CameraWhiteBalanceMode;
  colorTemperature?: number;
};

export const defaultCameraControls: CameraControls = {
  focusMode: "continuous",
  exposureMode: "continuous",
  whiteBalanceMode: "continuous"
};

type ConstraintRange = { min: number; max: number; step?: number };

export type CameraCapabilityInfo = {
  focusModes: CameraModeName[];
  focusMode: boolean;
  focusDistance?: ConstraintRange;
  exposureModes: CameraModeName[];
  exposureMode: boolean;
  exposureCompensation?: ConstraintRange;
  exposureTime?: ConstraintRange;
  brightness?: ConstraintRange;
  contrast?: ConstraintRange;
  saturation?: ConstraintRange;
  sharpness?: ConstraintRange;
  zoom?: ConstraintRange;
  pan?: ConstraintRange;
  tilt?: ConstraintRange;
  whiteBalanceModes: CameraModeName[];
  whiteBalanceMode: boolean;
  colorTemperature?: ConstraintRange;
};

type Caps = MediaTrackCapabilities & {
  focusMode?: string[] | string;
  focusDistance?: ConstraintRange;
  exposureMode?: string[] | string;
  exposureCompensation?: ConstraintRange;
  exposureTime?: ConstraintRange;
  brightness?: ConstraintRange;
  contrast?: ConstraintRange;
  saturation?: ConstraintRange;
  sharpness?: ConstraintRange;
  zoom?: ConstraintRange;
  pan?: ConstraintRange;
  tilt?: ConstraintRange;
  whiteBalanceMode?: string[] | string;
  colorTemperature?: ConstraintRange;
};

const CAMERA_MODES: CameraModeName[] = ["continuous", "manual", "single-shot", "none"];
const MODE_ORDER: CameraModeName[] = ["continuous", "single-shot", "manual", "none"];

function asRange(value: unknown): ConstraintRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const range = value as { min?: unknown; max?: unknown; step?: unknown };
  if (typeof range.min !== "number" || typeof range.max !== "number") return undefined;
  if (!(range.max > range.min)) return undefined;
  return {
    min: range.min,
    max: range.max,
    step: typeof range.step === "number" && range.step > 0 ? range.step : undefined
  };
}

function clampToRange(value: number, range: ConstraintRange): number {
  const stepped = range.step ? Math.round(value / range.step) * range.step : value;
  const precise = range.step && range.step < 1 ? Number(stepped.toFixed(4)) : stepped;
  return Math.min(range.max, Math.max(range.min, precise));
}

function asModes(value: unknown): CameraModeName[] {
  const list = Array.isArray(value) ? value : typeof value === "string" ? [value] : [];
  const found = new Set<CameraModeName>();
  for (const item of list) {
    if (typeof item === "string" && CAMERA_MODES.includes(item as CameraModeName)) found.add(item as CameraModeName);
  }
  return MODE_ORDER.filter((mode) => found.has(mode));
}

function isCameraMode(value: unknown): value is CameraModeName {
  return typeof value === "string" && CAMERA_MODES.includes(value as CameraModeName);
}

export function capabilityScore(info: CameraCapabilityInfo | null | undefined): number {
  if (!info) return 0;
  let score = info.focusModes.length + info.exposureModes.length + info.whiteBalanceModes.length;
  const ranges: Array<ConstraintRange | undefined> = [
    info.focusDistance,
    info.exposureCompensation,
    info.exposureTime,
    info.brightness,
    info.contrast,
    info.saturation,
    info.sharpness,
    info.zoom,
    info.pan,
    info.tilt,
    info.colorTemperature
  ];
  for (const range of ranges) if (range) score += 2;
  return score;
}

export function capsEqual(a: CameraCapabilityInfo | null | undefined, b: CameraCapabilityInfo | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

export function readCameraCapabilities(track: MediaStreamTrack | null | undefined): CameraCapabilityInfo | null {
  if (!track || typeof track.getCapabilities !== "function") return null;
  let caps: Caps;
  try {
    caps = track.getCapabilities() as Caps;
  } catch {
    return null;
  }
  const focusModes = asModes(caps.focusMode);
  const exposureModes = asModes(caps.exposureMode);
  const whiteBalanceModes = asModes(caps.whiteBalanceMode);
  return {
    focusModes,
    focusMode: focusModes.length > 0,
    focusDistance: asRange(caps.focusDistance),
    exposureModes,
    exposureMode: exposureModes.length > 0,
    exposureCompensation: asRange(caps.exposureCompensation),
    exposureTime: asRange(caps.exposureTime),
    brightness: asRange(caps.brightness),
    contrast: asRange(caps.contrast),
    saturation: asRange(caps.saturation),
    sharpness: asRange(caps.sharpness),
    zoom: asRange(caps.zoom),
    pan: asRange(caps.pan),
    tilt: asRange(caps.tilt),
    whiteBalanceModes,
    whiteBalanceMode: whiteBalanceModes.length > 0,
    colorTemperature: asRange(caps.colorTemperature)
  };
}

/** Возможности камеры иногда появляются только после старта потока. */
export async function loadCameraCapabilities(track: MediaStreamTrack): Promise<CameraCapabilityInfo | null> {
  let best = readCameraCapabilities(track);
  for (let i = 0; i < 5 && track.readyState === "live"; i++) {
    const score = capabilityScore(best);
    if (score > 0 && (best?.focusModes.length || best?.exposureModes.length || i >= 2)) break;
    await new Promise((resolve) => setTimeout(resolve, 80));
    const next = readCameraCapabilities(track);
    if (capabilityScore(next) >= score) best = next;
  }
  return best;
}

export function cameraHasManualControls(info: CameraCapabilityInfo | null): boolean {
  return capabilityScore(info) > 0;
}

/** Камера стартует сразу в непрерывном автофокусе. Если драйвер отклонит режим — вызывающий код откроет поток без него. */
export function cameraVideoConstraints(constraints: MediaTrackConstraints): MediaTrackConstraints {
  const advanced = Array.isArray(constraints.advanced) ? [...constraints.advanced] : [];
  advanced.push({ focusMode: "continuous" } as MediaTrackConstraintSet);
  return { ...constraints, advanced };
}

const focusKicked = new WeakSet<MediaStreamTrack>();

/**
 * Залипший UVC-фокус не трогается повторной записью того же continuous.
 * Один раз сдвигаем дистанцию и сразу возвращаем автофокус — линза начинает искать резкость
 * и когда лицо закрыто, и когда оно в кадре.
 */
async function kickContinuousAutofocus(track: MediaStreamTrack, caps: Caps): Promise<void> {
  if (focusKicked.has(track)) return;
  const modes = asModes(caps.focusMode);
  const range = asRange(caps.focusDistance);
  // Возможности часто пустые, пока поток только открылся. Не считаем такой вызов попыткой.
  if (!range && modes.length === 0) return;
  focusKicked.add(track);
  const canManual = modes.length === 0 || modes.includes("manual");
  let parked = Number.NaN;
  let nudged = false;
  if (canManual && range) {
    try {
      parked = Number((track.getSettings() as { focusDistance?: number }).focusDistance);
    } catch {
      parked = Number.NaN;
    }
    const span = range.max - range.min;
    const parkedNear = Number.isFinite(parked) && parked - range.min < span * 0.35;
    const nudge = parkedNear ? range.max : range.min;
    nudged = await applyCameraConstraintSet(track, { focusMode: "manual", focusDistance: clampToRange(nudge, range) });
    if (nudged) await new Promise((resolve) => setTimeout(resolve, 80));
  }
  const restored = await applyCameraConstraintSet(track, { focusMode: "continuous" });
  if (nudged && !restored && range && Number.isFinite(parked)) {
    await applyCameraConstraintSet(track, { focusMode: "manual", focusDistance: clampToRange(parked, range) });
  }
}

function pickMode(requested: string, supported: CameraModeName[], fallback: CameraModeName): CameraModeName {
  if (supported.length === 0) return isCameraMode(requested) ? requested : fallback;
  if (supported.includes(requested as CameraModeName)) return requested as CameraModeName;
  if (supported.includes(fallback)) return fallback;
  return supported[0];
}

function supportedMode(current: CameraModeName, modes: CameraModeName[], fallback: CameraModeName): CameraModeName {
  if (modes.length === 0) return current;
  if (modes.includes(current)) return current;
  if (modes.includes(fallback)) return fallback;
  return modes[0];
}

/** Оставляет только режимы, которые камера реально перечислила. */
export function alignCameraControls(controls: CameraControls, caps: CameraCapabilityInfo | null | undefined): CameraControls {
  if (!caps || capabilityScore(caps) === 0) return controls;
  const focusMode = supportedMode(controls.focusMode, caps.focusModes, "continuous");
  const exposureMode = supportedMode(controls.exposureMode, caps.exposureModes, "continuous");
  const whiteBalanceMode = supportedMode(controls.whiteBalanceMode, caps.whiteBalanceModes, "continuous");
  if (
    focusMode === controls.focusMode &&
    exposureMode === controls.exposureMode &&
    whiteBalanceMode === controls.whiteBalanceMode
  ) {
    return controls;
  }
  return { ...controls, focusMode, exposureMode, whiteBalanceMode };
}

export function cameraModeLabelKey(group: "focus" | "exposure" | "wb", mode: string): string {
  if (mode === "manual") {
    if (group === "focus") return "cameraFocusManual";
    if (group === "exposure") return "cameraExposureManual";
    return "cameraWbManual";
  }
  if (mode === "single-shot") {
    if (group === "focus") return "cameraFocusSingle";
    if (group === "exposure") return "cameraExposureSingle";
    return "cameraWbSingle";
  }
  if (mode === "none") return "cameraModeOff";
  if (group === "focus") return "cameraFocusAuto";
  if (group === "exposure") return "cameraExposureAuto";
  return "cameraWbAuto";
}

function baseVideoConstraints(track: MediaStreamTrack): MediaTrackConstraints {
  try {
    const current = typeof track.getConstraints === "function" ? track.getConstraints() : {};
    const { advanced: _advanced, ...rest } = current;
    return rest;
  } catch {
    return {};
  }
}

async function applyCameraConstraintSet(track: MediaStreamTrack, camera: Record<string, string | number>): Promise<boolean> {
  const base = baseVideoConstraints(track) as MediaTrackConstraints & { focusDistance?: number; focusMode?: string };
  const mode = typeof camera.focusMode === "string" ? camera.focusMode : base.focusMode;
  // Залипшая дистанция оставляет линзу в ручном фокусе, и continuous больше не наводится.
  if (mode && mode !== "manual") delete base.focusDistance;
  const attempts: MediaTrackConstraints[] = [
    { ...base, advanced: [camera] as unknown as MediaTrackConstraintSet[] },
    { ...base, ...(camera as MediaTrackConstraints) }
  ];
  for (const constraints of attempts) {
    try {
      await track.applyConstraints(constraints);
      return true;
    } catch {
      // Часть камер принимает только одну из двух форм ограничений.
    }
  }
  return false;
}

const pending = new WeakMap<MediaStreamTrack, number>();

/** Применяет ограничения с короткой задержкой, чтобы слайдер не дёргал камеру на каждом шаге. */
export function applyCameraControlsDebounced(track: MediaStreamTrack | null | undefined, controls: CameraControls, delayMs = 90) {
  if (!track) return;
  const prev = pending.get(track);
  if (prev) window.clearTimeout(prev);
  const id = window.setTimeout(() => {
    pending.delete(track);
    void applyCameraControls(track, controls);
  }, delayMs);
  pending.set(track, id);
}

export async function applyCameraControls(track: MediaStreamTrack | null | undefined, controls: CameraControls): Promise<void> {
  if (!track || track.kind !== "video" || track.readyState !== "live" || typeof track.applyConstraints !== "function") return;
  let caps: Caps = {};
  try {
    caps = (typeof track.getCapabilities === "function" ? track.getCapabilities() : {}) as Caps;
  } catch {
    caps = {};
  }

  const focusModes = asModes(caps.focusMode);
  const exposureModes = asModes(caps.exposureMode);
  const whiteBalanceModes = asModes(caps.whiteBalanceMode);
  const focusMode =
    controls.focusMode === "continuous" ? "continuous" : pickMode(controls.focusMode, focusModes, "continuous");
  const exposureMode = pickMode(controls.exposureMode, exposureModes, "continuous");
  const whiteBalanceMode = pickMode(controls.whiteBalanceMode, whiteBalanceModes, "continuous");

  if (focusMode === "continuous" && (focusModes.length === 0 || focusModes.includes("continuous"))) {
    let current = "";
    try {
      current = String((track.getSettings() as { focusMode?: string }).focusMode || "");
    } catch {
      current = "";
    }
    if (current === "manual" || current === "none" || current === "single-shot") focusKicked.delete(track);
    await kickContinuousAutofocus(track, caps);
  }

  const steps: Array<Record<string, string | number>> = [];
  if (focusMode) steps.push({ focusMode });
  if (focusMode === "manual" && caps.focusDistance && typeof controls.focusDistance === "number") {
    steps.push({ focusDistance: clampToRange(controls.focusDistance, caps.focusDistance) });
  }
  if (exposureMode) steps.push({ exposureMode });
  if (caps.exposureCompensation && typeof controls.exposureCompensation === "number") {
    steps.push({ exposureCompensation: clampToRange(controls.exposureCompensation, caps.exposureCompensation) });
  }
  if (
    caps.exposureTime &&
    typeof controls.exposureTime === "number" &&
    (exposureMode === "manual" || exposureModes.length === 0)
  ) {
    steps.push({ exposureTime: clampToRange(controls.exposureTime, caps.exposureTime) });
  }

  const numeric: Array<[keyof CameraControls, ConstraintRange | undefined]> = [
    ["brightness", asRange(caps.brightness)],
    ["contrast", asRange(caps.contrast)],
    ["saturation", asRange(caps.saturation)],
    ["sharpness", asRange(caps.sharpness)],
    ["zoom", asRange(caps.zoom)],
    ["pan", asRange(caps.pan)],
    ["tilt", asRange(caps.tilt)]
  ];
  for (const [key, range] of numeric) {
    const value = controls[key];
    if (range && typeof value === "number") steps.push({ [key]: clampToRange(value, range) });
  }

  if (whiteBalanceMode) steps.push({ whiteBalanceMode });
  if (whiteBalanceMode === "manual" && caps.colorTemperature && typeof controls.colorTemperature === "number") {
    steps.push({ colorTemperature: clampToRange(controls.colorTemperature, caps.colorTemperature) });
  }

  if (steps.length === 0) return;

  // Один непринятый параметр не должен сбрасывать остальные: в трек уходит весь накопленный набор.
  let accepted: Record<string, string | number> = {};
  for (const step of steps) {
    const next = { ...accepted, ...step };
    if (await applyCameraConstraintSet(track, next)) accepted = next;
  }
}

export async function settleCameraTrack(track: MediaStreamTrack, controls: CameraControls): Promise<CameraCapabilityInfo | null> {
  await applyCameraControls(track, controls);
  const info = await loadCameraCapabilities(track);
  const aligned = alignCameraControls(controls, info);
  if (aligned !== controls || aligned.focusMode === "continuous") await applyCameraControls(track, aligned);
  return info;
}

const NUMERIC_CAMERA_KEYS = [
  "focusDistance",
  "exposureCompensation",
  "exposureTime",
  "brightness",
  "contrast",
  "saturation",
  "sharpness",
  "zoom",
  "pan",
  "tilt",
  "colorTemperature"
] as const;

/** Подставляет текущие значения камеры только в ещё не заданные ползунки. */
export function seedCameraControls(current: CameraControls, settings: object | null | undefined): CameraControls {
  if (!settings) return current;
  const raw = settings as Record<string, unknown>;
  let changed = false;
  const next: CameraControls = { ...current };
  for (const key of NUMERIC_CAMERA_KEYS) {
    if (typeof next[key] !== "number" && typeof raw[key] === "number") {
      next[key] = raw[key] as number;
      changed = true;
    }
  }
  return changed ? next : current;
}

export function normalizeCameraControls(raw?: Partial<CameraControls> | null): CameraControls {
  return {
    focusMode: isCameraMode(raw?.focusMode) ? raw.focusMode : "continuous",
    focusDistance: typeof raw?.focusDistance === "number" ? raw.focusDistance : undefined,
    exposureMode: isCameraMode(raw?.exposureMode) ? raw.exposureMode : "continuous",
    exposureCompensation: typeof raw?.exposureCompensation === "number" ? raw.exposureCompensation : undefined,
    exposureTime: typeof raw?.exposureTime === "number" ? raw.exposureTime : undefined,
    brightness: typeof raw?.brightness === "number" ? raw.brightness : undefined,
    contrast: typeof raw?.contrast === "number" ? raw.contrast : undefined,
    saturation: typeof raw?.saturation === "number" ? raw.saturation : undefined,
    sharpness: typeof raw?.sharpness === "number" ? raw.sharpness : undefined,
    zoom: typeof raw?.zoom === "number" ? raw.zoom : undefined,
    pan: typeof raw?.pan === "number" ? raw.pan : undefined,
    tilt: typeof raw?.tilt === "number" ? raw.tilt : undefined,
    whiteBalanceMode: isCameraMode(raw?.whiteBalanceMode) ? raw.whiteBalanceMode : "continuous",
    colorTemperature: typeof raw?.colorTemperature === "number" ? raw.colorTemperature : undefined
  };
}
