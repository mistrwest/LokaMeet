import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { UserProfile, ChatMessage } from "../shared/types";
import { logWarn } from "./log";

type PersistedState = {
  profile: UserProfile;
  chats: ChatMessage[];
};

const STATE_FILE = "state.json";

const THEMES = new Set<UserProfile["theme"]>([
  "light",
  "dark",
  "warm-dark",
  "soft-light",
  "ocean-blue",
  "ocean-dusk",
  "ipd-slate",
  "ipd-lagoon",
  "ipd-midnight"
]);

const LEGACY_THEMES: Record<string, UserProfile["theme"]> = {
  "ipad-slate": "ipd-slate",
  "ipad-lagoon": "ipd-lagoon",
  "ipad-midnight": "ipd-midnight",
  "sapphire-bay": "ocean-dusk",
  "aurora-veil": "dark",
  "amber-glow": "warm-dark",
  "rose-ink": "soft-light",
  "tg-day": "light",
  "tg-night": "ipd-midnight",
  "tg-dark": "dark",
  "tg-classic": "soft-light"
};

function migrateTheme(theme: UserProfile["theme"] | string | undefined): UserProfile["theme"] {
  if (!theme) return "ipd-lagoon";
  const mapped = LEGACY_THEMES[theme] ?? theme;
  return THEMES.has(mapped as UserProfile["theme"]) ? (mapped as UserProfile["theme"]) : "ipd-lagoon";
}

function getStatePath() {
  // userData остаётся доступным после упаковки приложения и не зависит от рабочей папки.
  return path.join(app.getPath("userData"), STATE_FILE);
}

export function loadState(defaultProfile: UserProfile): PersistedState {
  const statePath = getStatePath();
  try {
    if (!fs.existsSync(statePath)) {
      return { profile: defaultProfile, chats: [] };
    }
    const raw = fs.readFileSync(statePath, "utf-8");
    const parsed = JSON.parse(raw) as PersistedState;
    if (!parsed?.profile?.peerId) return { profile: defaultProfile, chats: [] };
    const originalTheme = parsed.profile.theme;
    parsed.profile.theme = migrateTheme(parsed.profile.theme);
    const q = parsed.profile.defaultVideoQuality;
    if (q !== "auto" && q !== "low" && q !== "high" && q !== "fullhd" && q !== "qhd" && q !== "uhd") {
      parsed.profile.defaultVideoQuality = "auto";
    }
    const audioNsRev = Number(parsed.profile.audioNsRev ?? 0) || 0;
    if (audioNsRev < 1) {
      parsed.profile.noiseSuppression = true;
      parsed.profile.noiseSuppressionSensitivity =
        typeof parsed.profile.noiseSuppressionSensitivity === "number"
          ? parsed.profile.noiseSuppressionSensitivity
          : 65;
      parsed.profile.audioNsRev = 1;
    }
    if (
      parsed.profile.theme !== originalTheme ||
      parsed.profile.defaultVideoQuality !== q ||
      audioNsRev < 1
    ) {
      try {
        fs.writeFileSync(statePath, JSON.stringify(parsed, null, 2), "utf-8");
      } catch {
        // Миграция не должна мешать запуску, если файл занят.
      }
    }
    return parsed;
  } catch (e) {
    // Повреждённое состояние не должно препятствовать запуску с безопасными значениями по умолчанию.
    logWarn("Failed to load state, using defaults:", e);
    return { profile: defaultProfile, chats: [] };
  }
}

export function saveState(state: PersistedState) {
  const statePath = getStatePath();
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
  } catch (e) {
    logWarn("Failed to save state:", e);
  }
}

