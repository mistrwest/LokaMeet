export type CameraFocusMode = "continuous" | "manual";
export type CameraExposureMode = "continuous" | "manual";
export type CameraWhiteBalanceMode = "continuous" | "manual";

export type CameraControls = {
  focusMode: CameraFocusMode;
  focusDistance?: number;
  exposureMode: CameraExposureMode;
  exposureCompensation?: number;
  brightness?: number;
  contrast?: number;
  saturation?: number;
  sharpness?: number;
  zoom?: number;
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
  focusMode: boolean;
  focusDistance?: ConstraintRange;
  exposureMode: boolean;
  exposureCompensation?: ConstraintRange;
  brightness?: ConstraintRange;
  contrast?: ConstraintRange;
  saturation?: ConstraintRange;
  sharpness?: ConstraintRange;
  zoom?: ConstraintRange;
  whiteBalanceMode: boolean;
  colorTemperature?: ConstraintRange;
};

type Caps = MediaTrackCapabilities & {
  focusMode?: string[];
  focusDistance?: ConstraintRange;
  exposureMode?: string[];
  exposureCompensation?: ConstraintRange;
  brightness?: ConstraintRange;
  contrast?: ConstraintRange;
  saturation?: ConstraintRange;
  sharpness?: ConstraintRange;
  zoom?: ConstraintRange;
  whiteBalanceMode?: string[];
  colorTemperature?: ConstraintRange;
};

function asRange(value: unknown): ConstraintRange | undefined {
  if (!value || typeof value !== "object") return undefined;
  const range = value as { min?: unknown; max?: unknown; step?: unknown };
  if (typeof range.min !== "number" || typeof range.max !== "number") return undefined;
  if (range.min === range.max) return undefined;
  return {
    min: range.min,
    max: range.max,
    step: typeof range.step === "number" && range.step > 0 ? range.step : undefined
  };
}

function clampToRange(value: number, range: ConstraintRange): number {
  const stepped = range.step ? Math.round(value / range.step) * range.step : value;
  return Math.min(range.max, Math.max(range.min, stepped));
}

export function readCameraCapabilities(track: MediaStreamTrack | null | undefined): CameraCapabilityInfo | null {
  if (!track || typeof track.getCapabilities !== "function") return null;
  let caps: Caps;
  try {
    caps = track.getCapabilities() as Caps;
  } catch {
    return null;
  }
  const focusModes = Array.isArray(caps.focusMode) ? caps.focusMode : [];
  const exposureModes = Array.isArray(caps.exposureMode) ? caps.exposureMode : [];
  const whiteBalanceModes = Array.isArray(caps.whiteBalanceMode) ? caps.whiteBalanceMode : [];
  return {
    focusMode: focusModes.includes("continuous") || focusModes.includes("manual"),
    focusDistance: asRange(caps.focusDistance),
    exposureMode: exposureModes.includes("continuous") || exposureModes.includes("manual"),
    exposureCompensation: asRange(caps.exposureCompensation),
    brightness: asRange(caps.brightness),
    contrast: asRange(caps.contrast),
    saturation: asRange(caps.saturation),
    sharpness: asRange(caps.sharpness),
    zoom: asRange(caps.zoom),
    whiteBalanceMode: whiteBalanceModes.includes("continuous") || whiteBalanceModes.includes("manual"),
    colorTemperature: asRange(caps.colorTemperature)
  };
}

export function cameraHasManualControls(info: CameraCapabilityInfo | null): boolean {
  if (!info) return false;
  return Boolean(
    info.focusMode ||
      info.focusDistance ||
      info.exposureMode ||
      info.exposureCompensation ||
      info.brightness ||
      info.contrast ||
      info.saturation ||
      info.sharpness ||
      info.zoom ||
      info.whiteBalanceMode ||
      info.colorTemperature
  );
}

function pickMode(requested: string, supported: string[] | undefined, fallback: string): string | undefined {
  if (!supported?.length) return undefined;
  if (supported.includes(requested)) return requested;
  if (supported.includes(fallback)) return fallback;
  return supported[0];
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
  if (!track || track.kind !== "video" || typeof track.applyConstraints !== "function") return;
  let caps: Caps;
  try {
    caps = track.getCapabilities() as Caps;
  } catch {
    return;
  }

  const advanced: Record<string, string | number> = {};
  const focusMode = pickMode(controls.focusMode, caps.focusMode, "continuous");
  if (focusMode) advanced.focusMode = focusMode;
  if (focusMode === "manual" && caps.focusDistance && typeof controls.focusDistance === "number") {
    advanced.focusDistance = clampToRange(controls.focusDistance, caps.focusDistance);
  }

  const exposureMode = pickMode(controls.exposureMode, caps.exposureMode, "continuous");
  if (exposureMode) advanced.exposureMode = exposureMode;
  if (caps.exposureCompensation && typeof controls.exposureCompensation === "number") {
    advanced.exposureCompensation = clampToRange(controls.exposureCompensation, caps.exposureCompensation);
  }

  if (caps.brightness && typeof controls.brightness === "number") {
    advanced.brightness = clampToRange(controls.brightness, caps.brightness);
  }
  if (caps.contrast && typeof controls.contrast === "number") {
    advanced.contrast = clampToRange(controls.contrast, caps.contrast);
  }
  if (caps.saturation && typeof controls.saturation === "number") {
    advanced.saturation = clampToRange(controls.saturation, caps.saturation);
  }
  if (caps.sharpness && typeof controls.sharpness === "number") {
    advanced.sharpness = clampToRange(controls.sharpness, caps.sharpness);
  }
  if (caps.zoom && typeof controls.zoom === "number") {
    advanced.zoom = clampToRange(controls.zoom, caps.zoom);
  }

  const whiteBalanceMode = pickMode(controls.whiteBalanceMode, caps.whiteBalanceMode, "continuous");
  if (whiteBalanceMode) advanced.whiteBalanceMode = whiteBalanceMode;
  if (whiteBalanceMode === "manual" && caps.colorTemperature && typeof controls.colorTemperature === "number") {
    advanced.colorTemperature = clampToRange(controls.colorTemperature, caps.colorTemperature);
  }

  if (Object.keys(advanced).length === 0) return;
  try {
    await track.applyConstraints({ advanced: [advanced] as unknown as MediaTrackConstraintSet[] });
  } catch {
    try {
      await track.applyConstraints(advanced as MediaTrackConstraints);
    } catch {
      // Камера может отклонить часть ручных ограничений — превью и звонок при этом остаются рабочими.
    }
  }
}

export function normalizeCameraControls(raw?: Partial<CameraControls> | null): CameraControls {
  return {
    focusMode: raw?.focusMode === "manual" ? "manual" : "continuous",
    focusDistance: typeof raw?.focusDistance === "number" ? raw.focusDistance : undefined,
    exposureMode: raw?.exposureMode === "manual" ? "manual" : "continuous",
    exposureCompensation: typeof raw?.exposureCompensation === "number" ? raw.exposureCompensation : undefined,
    brightness: typeof raw?.brightness === "number" ? raw.brightness : undefined,
    contrast: typeof raw?.contrast === "number" ? raw.contrast : undefined,
    saturation: typeof raw?.saturation === "number" ? raw.saturation : undefined,
    sharpness: typeof raw?.sharpness === "number" ? raw.sharpness : undefined,
    zoom: typeof raw?.zoom === "number" ? raw.zoom : undefined,
    whiteBalanceMode: raw?.whiteBalanceMode === "manual" ? "manual" : "continuous",
    colorTemperature: typeof raw?.colorTemperature === "number" ? raw.colorTemperature : undefined
  };
}
