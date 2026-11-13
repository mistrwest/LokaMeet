function clampVoiceSensitivity(value: number | undefined) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  return Math.max(0, Math.min(100, n));
}

/** Запас до открытия: начало слова уже лежит в линии задержки и не срезается. */
const VOICE_LOOKAHEAD_SEC = 0.18;
/** Удержание после последней речи: паузы между словами не закрывают микрофон. */
const VOICE_HANG_SEC = 0.7;

function voiceOpenThreshold(sensitivity: number) {
  const t = Math.max(0, Math.min(100, sensitivity)) / 100;
  const db = -30 - t * 32;
  return Math.pow(10, db / 20);
}

export type MicEnhanceOptions = {
  enabled: boolean;
  sensitivity: number;
  volume: number;
  /** Микрофон передаёт звук только пока пользователь говорит. */
  voiceActivation?: boolean;
  /** 0 — только громкая речь, 100 — открывается от тихого голоса. */
  voiceSensitivity?: number;
};

/**
 * Только штатные ограничения Chromium.
 * Старые goog*-флаги делают голос «роботом» и при переключении перезапускают
 * общее аудиоустройство, из-за чего портится звук собеседника.
 */
export function getEnhancedAudioConstraints(
  enabled: boolean,
  _sensitivity: number,
  deviceId?: string
): MediaTrackConstraints {
  const ac: MediaTrackConstraints = {
    echoCancellation: { ideal: true },
    noiseSuppression: { ideal: enabled },
    // AGC Chromium уводит уровень вниз на внешнем интерфейсе, и собеседник слышит тише.
    autoGainControl: { ideal: false },
    channelCount: { ideal: 1 }
  };
  if (deviceId) (ac as MediaTrackConstraints & { deviceId: ConstrainDOMString }).deviceId = { ideal: deviceId };
  return ac;
}

/**
 * Лёгкая обработка поверх системного шумоподавления.
 * Без шумоподавления и голосовой активации при полной громкости трек идёт как есть.
 */
export class MicEnhancer {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private highpass: BiquadFilterNode | null = null;
  private lowpass: BiquadFilterNode | null = null;
  private compressor: DynamicsCompressorNode | null = null;
  private delay: DelayNode | null = null;
  private gate: GainNode | null = null;
  private volumeNode: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meterMute: GainNode | null = null;
  private meterTimer = 0;
  private inputTrack: MediaStreamTrack | null = null;
  private outputTrack: MediaStreamTrack | null = null;
  private sensitivity = 50;
  private enabled = true;
  private volume = 1;
  private voiceActivation = false;
  private voiceSensitivity = 50;
  private noiseFloor = 0.004;
  private lastSpeechAt = 0;
  private speaking = false;
  private gateOpen = false;
  private armed = true;
  private graceUntil = 0;

  getInputTrack() {
    return this.inputTrack;
  }

  getOutputTrack() {
    return this.outputTrack;
  }

  isSpeaking() {
    return this.speaking;
  }

  needsRebuild(opts: MicEnhanceOptions) {
    const volume = Math.max(0, Math.min(1, opts.volume / 100));
    const needGraph = Boolean(opts.enabled || opts.voiceActivation || volume < 0.995);
    const hasGraph = Boolean(this.ctx && this.outputTrack && this.inputTrack && this.outputTrack !== this.inputTrack);
    if (needGraph !== hasGraph) return true;
    if (this.inputTrack && this.inputTrack.readyState !== "live") return true;
    if (this.outputTrack && this.outputTrack.readyState !== "live") return true;
    return false;
  }

  setArmed(armed: boolean) {
    this.armed = armed;
    if (!armed) {
      this.speaking = false;
      this.gateOpen = !this.voiceActivation;
      if (this.gate && this.ctx) {
        const closed = this.voiceActivation ? 0 : 1;
        this.gate.gain.setTargetAtTime(closed, this.ctx.currentTime, 0.03);
      }
    }
  }

  async attach(track: MediaStreamTrack, opts: MicEnhanceOptions): Promise<MediaStreamTrack> {
    this.detach(false);
    this.inputTrack = track;
    this.sensitivity = Math.max(0, Math.min(100, opts.sensitivity));
    this.enabled = opts.enabled;
    this.volume = Math.max(0, Math.min(1, opts.volume / 100));
    this.voiceActivation = Boolean(opts.voiceActivation);
    this.voiceSensitivity = clampVoiceSensitivity(opts.voiceSensitivity);
    this.noiseFloor = 0.004;
    this.lastSpeechAt = 0;
    this.speaking = false;
    this.gateOpen = !this.voiceActivation;
    const needGraph = opts.enabled || this.voiceActivation || this.volume < 0.995;
    if (!needGraph) {
      this.outputTrack = track;
      return track;
    }
    const ctx = new AudioContext();
    this.ctx = ctx;
    await ctx.resume().catch(() => undefined);
    const src = ctx.createMediaStreamSource(new MediaStream([track]));
    const highpass = ctx.createBiquadFilter();
    highpass.type = "highpass";
    highpass.Q.value = 0.707;
    const lowpass = ctx.createBiquadFilter();
    lowpass.type = "lowpass";
    lowpass.Q.value = 0.707;
    const compressor = ctx.createDynamicsCompressor();
    compressor.knee.value = 18;
    compressor.attack.value = 0.008;
    compressor.release.value = 0.18;
    this.applyFilterParams(highpass, lowpass, compressor);
    const delay = ctx.createDelay(0.3);
    delay.delayTime.value = this.voiceActivation ? VOICE_LOOKAHEAD_SEC : 0;
    const gate = ctx.createGain();
    gate.gain.value = this.voiceActivation ? 0 : 1;
    const volumeNode = ctx.createGain();
    volumeNode.gain.value = this.outputGain();
    const dest = ctx.createMediaStreamDestination();
    src.connect(highpass);
    highpass.connect(lowpass);
    lowpass.connect(compressor);
    compressor.connect(delay);
    delay.connect(gate);
    gate.connect(volumeNode);
    volumeNode.connect(dest);

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = this.voiceActivation ? 0.05 : 0.35;
    const meterMute = ctx.createGain();
    meterMute.gain.value = 0;
    compressor.connect(analyser);
    analyser.connect(meterMute);
    meterMute.connect(dest);

    this.source = src;
    this.highpass = highpass;
    this.lowpass = lowpass;
    this.compressor = compressor;
    this.delay = delay;
    this.gate = gate;
    this.volumeNode = volumeNode;
    this.analyser = analyser;
    this.meterMute = meterMute;
    this.dest = dest;
    this.graceUntil = ctx.currentTime + 0.28;
    this.outputTrack = dest.stream.getAudioTracks()[0] ?? track;
    this.outputTrack.enabled = true;
    this.startMeter();
    return this.outputTrack;
  }

  setOptions(opts: Partial<MicEnhanceOptions>) {
    if (typeof opts.sensitivity === "number") this.sensitivity = Math.max(0, Math.min(100, opts.sensitivity));
    if (typeof opts.enabled === "boolean") this.enabled = opts.enabled;
    if (typeof opts.volume === "number") this.volume = Math.max(0, Math.min(1, opts.volume / 100));
    if (typeof opts.voiceSensitivity === "number") this.voiceSensitivity = clampVoiceSensitivity(opts.voiceSensitivity);
    if (typeof opts.voiceActivation === "boolean") {
      this.voiceActivation = opts.voiceActivation;
      if (!this.voiceActivation && this.gate && this.ctx) {
        this.speaking = true;
        this.gateOpen = true;
        this.gate.gain.setTargetAtTime(1, this.ctx.currentTime, 0.02);
      }
    }
    if (this.delay) this.delay.delayTime.value = this.voiceActivation ? VOICE_LOOKAHEAD_SEC : 0;
    if (this.analyser) this.analyser.smoothingTimeConstant = this.voiceActivation ? 0.05 : 0.35;
    if (this.highpass && this.lowpass && this.compressor) {
      this.applyFilterParams(this.highpass, this.lowpass, this.compressor);
    }
    if (this.volumeNode && (typeof opts.volume === "number" || typeof opts.enabled === "boolean")) {
      this.volumeNode.gain.value = this.outputGain();
    }
    if (!this.voiceActivation && this.outputTrack && this.outputTrack !== this.inputTrack) {
      this.outputTrack.enabled = true;
    }
  }

  detach(stopInput = false) {
    this.stopMeter();
    for (const node of [this.source, this.highpass, this.lowpass, this.compressor, this.delay, this.gate, this.volumeNode, this.analyser, this.meterMute, this.dest]) {
      try {
        node?.disconnect();
      } catch {
        // игнор
      }
    }
    this.source = null;
    this.highpass = null;
    this.lowpass = null;
    this.compressor = null;
    this.delay = null;
    this.gate = null;
    this.volumeNode = null;
    this.analyser = null;
    this.meterMute = null;
    this.dest = null;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    if (stopInput) {
      try {
        this.inputTrack?.stop();
      } catch {
        // игнор
      }
    }
    this.inputTrack = null;
    this.outputTrack = null;
    this.speaking = false;
    this.gateOpen = false;
  }

  private startMeter() {
    this.stopMeter();
    this.meterTimer = window.setInterval(() => this.measure(), 16);
  }

  private stopMeter() {
    if (!this.meterTimer) return;
    window.clearInterval(this.meterTimer);
    this.meterTimer = 0;
  }

  /** Шумодав чуть поднимает среднюю громкость, чтобы компрессия не делала голос тише. */
  private outputGain() {
    const level = Math.max(0, Math.min(1, this.volume));
    return level * (this.enabled ? 1.45 : 1);
  }

  private applyFilterParams(highpass: BiquadFilterNode, lowpass: BiquadFilterNode, compressor: DynamicsCompressorNode) {
    const s = this.sensitivity / 100;
    const ns = this.enabled;
    highpass.frequency.value = ns ? 55 + s * 20 : 28;
    lowpass.frequency.value = ns ? 17000 - s * 1200 : 18000;
    compressor.threshold.value = ns ? -20 - s * 3 : -28;
    compressor.ratio.value = ns ? 1.3 + s * 0.4 : 1.15;
  }

  private measure() {
    if (!this.gate || !this.ctx || !this.analyser) return;
    const now = this.ctx.currentTime;
    if (!this.armed) {
      this.speaking = false;
      this.gate.gain.setTargetAtTime(this.voiceActivation ? 0 : 1, now, 0.03);
      return;
    }
    const buf = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    let peak = 0;
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      sum += v * v;
      const abs = Math.abs(v);
      if (abs > peak) peak = abs;
    }
    const rms = Math.sqrt(sum / Math.max(1, buf.length));
    let open: boolean;
    if (this.voiceActivation) {
      const openAt = voiceOpenThreshold(this.voiceSensitivity);
      const holdAt = openAt * 0.38;
      const detected = rms >= openAt || (this.gateOpen && rms >= holdAt);
      if (detected) this.lastSpeechAt = now;
      open = detected || (this.lastSpeechAt > 0 && now - this.lastSpeechAt < VOICE_HANG_SEC);
    } else {
      const s = this.sensitivity / 100;
      const thresh = this.noiseFloor * (2.4 + (1 - s) * 0.8) + 0.0028 + s * 0.004;
      const detected = rms >= thresh && peak >= thresh * 1.2;
      if (!detected) {
        this.noiseFloor = this.noiseFloor * 0.9 + rms * 0.1;
        this.noiseFloor = Math.min(0.02, Math.max(0.0008, this.noiseFloor));
      }
      if (detected) this.lastSpeechAt = now;
      open = now < this.graceUntil || detected || now - this.lastSpeechAt < 0.16;
    }
    this.speaking = open;
    const target = open || !this.voiceActivation ? 1 : 0;
    if (this.gateOpen === (target === 1)) return;
    this.gateOpen = target === 1;
    const ramp = this.voiceActivation ? (target === 1 ? 0.004 : 0.08) : target === 1 ? 0.012 : 0.1;
    this.gate.gain.setTargetAtTime(target, now, ramp);
  }
}
