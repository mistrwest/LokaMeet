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

const LEGACY_THEMES: Record<string, UserProfile["theme"]> = {
  "ipad-slate": "ipd-slate",
  "ipad-lagoon": "ipd-lagoon",
  "ipad-midnight": "ipd-midnight"
};

function migrateTheme(theme: UserProfile["theme"] | string | undefined): UserProfile["theme"] {
  if (!theme) return "ipd-lagoon";
  return LEGACY_THEMES[theme] ?? (theme as UserProfile["theme"]);
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
    if (parsed.profile.theme !== originalTheme) {
      try {
        fs.writeFileSync(statePath, JSON.stringify(parsed, null, 2), "utf-8");
      } catch {
        // Миграция темы не должна мешать запуску, если файл занят.
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

