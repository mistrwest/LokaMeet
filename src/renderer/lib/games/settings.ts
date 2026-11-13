import type { UserProfile } from "../../../shared/types";

export type GameBoardScale = "medium" | "large" | "xl";

export type GamesSettings = {
  boardScale: GameBoardScale;
  showCoordinates: boolean;
  highlightLastMove: boolean;
  confirmResign: boolean;
  soundEnabled: boolean;
  soundVolume: number;
  checkersShowHints: boolean;
  chessShowHints: boolean;
  battleshipShowSunkOutline: boolean;
};

export const DEFAULT_GAMES_SETTINGS: GamesSettings = {
  boardScale: "large",
  showCoordinates: true,
  highlightLastMove: true,
  confirmResign: true,
  soundEnabled: true,
  soundVolume: 55,
  checkersShowHints: true,
  chessShowHints: true,
  battleshipShowSunkOutline: true
};

export function normalizeGamesSettings(raw?: UserProfile["gamesSettings"] | null): GamesSettings {
  const scale = raw?.boardScale;
  return {
    boardScale: scale === "medium" || scale === "large" || scale === "xl" ? scale : DEFAULT_GAMES_SETTINGS.boardScale,
    showCoordinates: raw?.showCoordinates ?? true,
    highlightLastMove: raw?.highlightLastMove ?? true,
    confirmResign: raw?.confirmResign ?? true,
    soundEnabled: raw?.soundEnabled ?? true,
    soundVolume: Math.max(0, Math.min(100, Number(raw?.soundVolume ?? 55) || 0)),
    checkersShowHints: raw?.checkersShowHints ?? true,
    chessShowHints: raw?.chessShowHints ?? true,
    battleshipShowSunkOutline: raw?.battleshipShowSunkOutline ?? true
  };
}

let audioCtx: AudioContext | null = null;

function ctx() {
  if (!audioCtx) {
    const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    audioCtx = new Ctor();
  }
  return audioCtx;
}

export function playGameSound(
  kind: "hit" | "miss" | "sunk" | "move" | "win" | "place",
  settings: Pick<GamesSettings, "soundEnabled" | "soundVolume">
) {
  if (!settings.soundEnabled || settings.soundVolume <= 0) return;
  const audio = ctx();
  if (!audio) return;
  if (audio.state === "suspended") void audio.resume().catch(() => undefined);
  const now = audio.currentTime;
  const gain = audio.createGain();
  gain.gain.value = (settings.soundVolume / 100) * 0.18;
  gain.connect(audio.destination);

  const beep = (freq: number, start: number, dur: number, type: OscillatorType = "sine") => {
    const osc = audio.createOscillator();
    const g = audio.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + start);
    g.gain.exponentialRampToValueAtTime(1, now + start + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + start + dur);
    osc.connect(g);
    g.connect(gain);
    osc.start(now + start);
    osc.stop(now + start + dur + 0.02);
  };

  if (kind === "miss") beep(220, 0, 0.12, "triangle");
  else if (kind === "hit") {
    beep(420, 0, 0.08, "square");
    beep(560, 0.06, 0.1, "square");
  } else if (kind === "sunk") {
    beep(180, 0, 0.16, "sawtooth");
    beep(140, 0.14, 0.22, "sawtooth");
  } else if (kind === "move") beep(520, 0, 0.07, "sine");
  else if (kind === "place") beep(340, 0, 0.08, "triangle");
  else if (kind === "win") {
    beep(523, 0, 0.12);
    beep(659, 0.12, 0.12);
    beep(784, 0.24, 0.2);
  }
}
