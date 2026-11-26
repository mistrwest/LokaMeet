import type { Settings } from "../shared/types";

let ctx: AudioContext | null = null;
let level = 0.7;

function context(): AudioContext {
  if (!ctx) ctx = new AudioContext();
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

function voice(type: OscillatorType, freq: number, at: number, dur: number, gain = 0.08, slide?: number): void {
  const audio = context();
  const osc = audio.createOscillator();
  const filter = audio.createBiquadFilter();
  const amp = audio.createGain();
  const peak = Math.max(0.0001, gain * level);
  osc.type = type;
  osc.frequency.setValueAtTime(freq, audio.currentTime + at);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, audio.currentTime + at + dur);
  filter.type = "lowpass";
  filter.frequency.value = 2800;
  filter.Q.value = 0.7;
  amp.gain.setValueAtTime(0, audio.currentTime + at);
  amp.gain.linearRampToValueAtTime(peak, audio.currentTime + at + 0.018);
  amp.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + at + dur);
  osc.connect(filter);
  filter.connect(amp);
  amp.connect(audio.destination);
  osc.start(audio.currentTime + at);
  osc.stop(audio.currentTime + at + dur + 0.03);
}

export type Cue = "call" | "message" | "join" | "record";

function packed(kind: Cue): string {
  const base = import.meta.env.BASE_URL;
  if (kind === "call") return `${base}sounds/call.mp3`;
  if (kind === "message") return `${base}sounds/sms.mp3`;
  if (kind === "join") return `${base}sounds/int.mp3`;
  return `${base}sounds/call_1.mp3`;
}

function chosen(kind: Cue, settings?: Settings | null): string {
  if (!settings) return "default";
  if (kind === "call") return settings.toneCall || "default";
  if (kind === "message") return settings.toneMessage || "default";
  if (kind === "join") return settings.toneJoin || "default";
  return settings.toneRecord || "default";
}

function fileUrl(filePath: string): string {
  return `loka://media/?path=${encodeURIComponent(filePath)}`;
}

function playFile(src: string, volume: number, fallback: () => void): void {
  const audio = new Audio(src);
  audio.volume = Math.min(1, Math.max(0, volume));
  void audio.play().catch(() => fallback());
}

export function playTone(toneId: string, volume = 0.7): void {
  level = Math.min(1, Math.max(0, volume));
  if (!level) return;
  if (toneId.startsWith("file:") || toneId.startsWith("data:")) {
    playFile(toneId.startsWith("file:") ? fileUrl(toneId.slice(5)) : toneId, volume, () => playTone("soft", volume));
    return;
  }
  if (toneId === "pack-call") {
    playFile(packed("call"), volume, () => playTone("call-fallback", volume));
    return;
  }
  if (toneId === "pack-message") {
    playFile(packed("message"), volume, () => playTone("message-fallback", volume));
    return;
  }
  if (toneId === "pack-join") {
    playFile(packed("join"), volume, () => playTone("join-fallback", volume));
    return;
  }
  if (toneId === "pack-record") {
    playFile(packed("record"), volume, () => playTone("record-fallback", volume));
    return;
  }
  if (toneId === "soft") {
    voice("sine", 523.25, 0, 0.22, 0.05);
    voice("triangle", 783.99, 0.08, 0.28, 0.04);
    return;
  }
  if (toneId === "chime") {
    voice("sine", 659.25, 0, 0.16, 0.045);
    voice("triangle", 830.61, 0.09, 0.2, 0.04);
    voice("sine", 1046.5, 0.18, 0.32, 0.038, 1318.5);
    return;
  }
  if (toneId === "pop") {
    voice("sine", 392, 0, 0.09, 0.05, 660);
    return;
  }
  if (toneId === "call" || toneId === "call-fallback" || toneId === "default-fallback") {
    voice("sine", 493.88, 0, 0.22, 0.055);
    voice("triangle", 659.25, 0.12, 0.28, 0.05);
    voice("sine", 783.99, 0.28, 0.34, 0.04);
    return;
  }
  if (toneId === "message" || toneId === "message-fallback") {
    voice("sine", 698.46, 0, 0.12, 0.042);
    voice("triangle", 1046.5, 0.07, 0.18, 0.036);
    return;
  }
  if (toneId === "join" || toneId === "join-fallback") {
    voice("sine", 392, 0, 0.14, 0.045, 523.25);
    voice("triangle", 659.25, 0.12, 0.24, 0.04);
    return;
  }
  if (toneId === "record" || toneId === "record-fallback") {
    voice("sine", 880, 0, 0.1, 0.04);
    voice("triangle", 554.37, 0.1, 0.2, 0.038);
    return;
  }
  if (toneId === "default") {
    playFile(packed("message"), volume, () => playTone("soft", volume));
    return;
  }
  voice("sine", 659.25, 0, 0.18, 0.045);
  voice("triangle", 830.61, 0.1, 0.22, 0.035);
}

function cueVolume(kind: Cue, settings?: Settings | null): number {
  if (kind === "call") return settings?.volumeCall ?? settings?.notifyVolume ?? 0.7;
  if (kind === "message") return settings?.volumeMessage ?? settings?.notifyVolume ?? 0.7;
  if (kind === "join") return settings?.volumeJoin ?? settings?.notifyVolume ?? 0.7;
  return settings?.volumeRecord ?? settings?.notifyVolume ?? 0.7;
}

export function playCue(kind: Cue, settings?: Settings | null): void {
  const volume = cueVolume(kind, settings);
  const picked = chosen(kind, settings);
  if (!picked || picked === "default" || picked === "soft" || picked === "chime" || picked === "pop") {
    playFile(packed(kind), volume, () => playTone(`${kind}-fallback`, volume));
    return;
  }
  playTone(picked, volume);
}

export function playRing(): void {
  playCue("call");
}

export function playMessage(): void {
  playCue("message");
}

export function playJoin(): void {
  playCue("join");
}

export function playRecord(): void {
  playCue("record");
}

function pickVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const ranked = [/zira/i, /aria/i, /jenny/i, /samantha/i, /hazel/i, /female/i, /google us english/i, /microsoft.*(english|online)/i];
  const english = voices.filter((item) => /^en(-|_|$)/i.test(item.lang));
  const pool = english.length ? english : voices;
  for (const re of ranked) {
    const found = pool.find((item) => re.test(item.name));
    if (found) return found;
  }
  return pool[0] ?? null;
}

function speakNow(text: string): void {
  if (!window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.92;
  utterance.pitch = 1.08;
  utterance.volume = 1;
  const voice = pickVoice(window.speechSynthesis.getVoices());
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function speakRecord(kind: "start" | "stop"): void {
  if (!window.speechSynthesis) return;
  const text = kind === "start" ? "record start" : "record stop";
  const voices = window.speechSynthesis.getVoices();
  if (voices.length) {
    speakNow(text);
    return;
  }
  let spoken = false;
  const run = () => {
    if (spoken) return;
    spoken = true;
    window.speechSynthesis.removeEventListener("voiceschanged", run);
    speakNow(text);
  };
  window.speechSynthesis.addEventListener("voiceschanged", run);
  window.setTimeout(run, 280);
}
