const START_TEXT = "record start";
const STOP_TEXT = "record stop";

function pickFemaleVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  const ranked = [
    /zira/i,
    /aria/i,
    /jenny/i,
    /sara/i,
    /samantha/i,
    /eva/i,
    /hazel/i,
    /female/i,
    /google us english/i,
    /microsoft.*(english|online)/i
  ];
  const english = voices.filter((v) => /^en(-|_|$)/i.test(v.lang));
  const pool = english.length ? english : voices;
  for (const re of ranked) {
    const found = pool.find((v) => re.test(v.name));
    if (found) return found;
  }
  return pool[0] ?? null;
}

function speakNow(text: string) {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = "en-US";
  utterance.rate = 0.92;
  utterance.pitch = 1.08;
  utterance.volume = 1;
  const voice = pickFemaleVoice(window.speechSynthesis.getVoices());
  if (voice) utterance.voice = voice;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(utterance);
}

export function speakRecordAnnouncement(kind: "start" | "stop") {
  if (typeof window === "undefined" || !window.speechSynthesis) return;
  const text = kind === "start" ? START_TEXT : STOP_TEXT;
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
