import type { Settings } from "../shared/types";

export interface LocalMedia {
  stream: MediaStream;
  preview: MediaStream;
  stop: () => void;
  setMic: (on: boolean) => void;
  setCamera: (on: boolean) => void;
  addVideoTrack: (track: MediaStreamTrack) => void;
  clearVideo: () => void;
  level: () => number;
  resume: () => Promise<void>;
  health: () => { ended: boolean; muted: boolean; running: boolean };
  recapture: () => Promise<void>;
  applyVoice: (opts: { vad: boolean; vadSensitivity: number; micGain: number }) => void;
}

let segmenterPromise: Promise<any | null> | null = null;

async function segmenter(): Promise<any | null> {
  if (!segmenterPromise) {
    segmenterPromise = (async () => {
      try {
        const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
        const base = import.meta.env.BASE_URL;
        const vision = await FilesetResolver.forVisionTasks(`${base}mediapipe`);
        return await ImageSegmenter.createFromOptions(vision, {
          baseOptions: { modelAssetPath: `${base}models/selfie_segmenter.tflite`, delegate: "CPU" },
          runningMode: "VIDEO",
          outputCategoryMask: true,
        });
      } catch (error) {
        console.error("segmenter", error);
        return null;
      }
    })();
  }
  return segmenterPromise;
}

export function cameraConstraints(settings: Settings): MediaTrackConstraints {
  const video: MediaTrackConstraints = {};
  if (settings.cameraId) video.deviceId = { exact: settings.cameraId };
  if (settings.camWidth) video.width = { ideal: settings.camWidth };
  if (settings.camHeight) video.height = { ideal: settings.camHeight };
  if (settings.camFps) video.frameRate = { ideal: settings.camFps };
  if (settings.camFacing) video.facingMode = settings.camFacing;
  return Object.keys(video).length ? video : { width: { ideal: 1280 }, height: { ideal: 720 } };
}

export async function applyCameraTune(track: MediaStreamTrack, settings: Settings): Promise<void> {
  const advanced: Record<string, number | string | boolean> = {};
  for (const [key, value] of Object.entries(settings.camTune ?? {})) {
    if (value === "" || value == null) continue;
    advanced[key] = value;
  }
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, { min?: number; max?: number } | unknown>;
  const sat = caps.saturation as { min?: number; max?: number } | undefined;
  if (sat && typeof sat === "object" && sat.min != null && sat.max != null) {
    const min = Number(sat.min);
    const max = Number(sat.max);
    const stored = Number(advanced.saturation);
    const floor = min + (max - min) * 0.12;
    const color = min + (max - min) * 0.62;
    if (!Number.isFinite(stored) || stored <= floor) advanced.saturation = color;
  } else if ("saturation" in advanced && Number(advanced.saturation) <= 0) {
    delete advanced.saturation;
  }
  if (!Object.keys(advanced).length) return;
  try {
    await track.applyConstraints({ advanced: [advanced] } as MediaTrackConstraints);
  } catch {
    for (const [key, value] of Object.entries(advanced)) {
      try {
        await track.applyConstraints({ advanced: [{ [key]: value }] } as MediaTrackConstraints);
      } catch {
        /* this camera rejected the control */
      }
    }
  }
}

export async function openCameraTrack(settings: Settings): Promise<{ track: MediaStreamTrack; stop: () => void }> {
  const video = cameraConstraints(settings);
  let cam: MediaStream;
  try {
    cam = await navigator.mediaDevices.getUserMedia({ audio: false, video });
  } catch {
    cam = await navigator.mediaDevices.getUserMedia({ audio: false, video: { width: { ideal: 1280 }, height: { ideal: 720 } } });
  }
  const raw = cam.getVideoTracks()[0];
  if (!raw) {
    cam.getTracks().forEach((track) => track.stop());
    throw new Error("camera");
  }
  await applyCameraTune(raw, settings);
  if (settings.bgMode !== "off") {
    const composed = await compose(raw, settings);
    if (composed) return { track: composed.track, stop: () => { composed.stop(); raw.stop(); } };
  }
  return { track: raw, stop: () => raw.stop() };
}

function captureAudio(settings: Settings): MediaTrackConstraints {
  return {
    deviceId: settings.micId ? { exact: settings.micId } : undefined,
    channelCount: 1,
    sampleRate: 48000,
    echoCancellation: settings.echoCancellation !== false,
    noiseSuppression: settings.noiseSuppression !== false,
    autoGainControl: settings.autoGain !== false,
    latency: 0.01,
  } as MediaTrackConstraints;
}

async function tuneMic(track: MediaStreamTrack, settings: Settings): Promise<void> {
  try {
    await track.applyConstraints({
      echoCancellation: settings.echoCancellation !== false,
      noiseSuppression: settings.noiseSuppression !== false,
      autoGainControl: settings.autoGain !== false,
    } as MediaTrackConstraints);
  } catch {
    /* the device may ignore extra capture flags */
  }
}

export async function openLocalMedia(settings: Settings, withVideo: boolean): Promise<LocalMedia> {
  const audio = captureAudio(settings);
  const video = withVideo ? cameraConstraints(settings) : false;
  let raw: MediaStream;
  try {
    raw = await navigator.mediaDevices.getUserMedia({ audio, video });
  } catch {
    raw = await navigator.mediaDevices.getUserMedia({
      audio: captureAudio({ ...settings, micId: "" }),
      video: false,
    });
  }
  await tuneMic(raw.getAudioTracks()[0], settings);
  let audioCtx: AudioContext;
  try {
    audioCtx = new AudioContext({ latencyHint: "interactive", sampleRate: 48000 });
  } catch {
    audioCtx = new AudioContext({ latencyHint: "interactive" });
  }
  void audioCtx.resume();
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 2048;
  analyser.smoothingTimeConstant = settings.vad ? 0.05 : 0.28;
  const gain = audioCtx.createGain();
  let micGain = Math.min(2.5, Math.max(0, settings.micGain ?? 1));
  let vadOn = Boolean(settings.vad);
  let vadSens = Math.max(0, Math.min(100, settings.vadSensitivity ?? 55));
  gain.gain.value = vadOn ? 0 : micGain;
  const delay = audioCtx.createDelay(0.4);
  delay.delayTime.value = vadOn ? 0.12 : 0;
  delay.connect(gain);
  let source = audioCtx.createMediaStreamSource(raw);
  const hipass = audioCtx.createBiquadFilter();
  hipass.type = "highpass";
  hipass.frequency.value = 70;
  hipass.Q.value = 0.7;
  const wire = (node: MediaStreamAudioSourceNode) => {
    node.connect(analyser);
    node.connect(hipass);
  };
  hipass.connect(delay);
  wire(source);
  const dest = audioCtx.createMediaStreamDestination();
  try {
    dest.channelCount = 1;
    dest.channelCountMode = "explicit";
  } catch {
    /* this node keeps its default channel layout */
  }
  const comp = audioCtx.createDynamicsCompressor();
  comp.threshold.value = -22;
  comp.knee.value = 12;
  comp.ratio.value = 1.8;
  comp.attack.value = 0.003;
  comp.release.value = 0.16;
  const makeup = audioCtx.createGain();
  makeup.gain.value = 1.08;
  gain.connect(comp);
  comp.connect(makeup);
  makeup.connect(dest);

  const time = new Float32Array(analyser.fftSize);
  let smooth = 0;
  let lastSpeech = 0;
  let gateOpen = !vadOn;
  let micOn = true;
  let applied = gain.gain.value;
  const glide = (value: number, ramp: number) => {
    if (audioCtx.state === "closed" || Math.abs(applied - value) < 0.004) return;
    applied = value;
    const now = audioCtx.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(value, now + ramp);
  };
  const openAt = () => {
    const t = vadSens / 100;
    return Math.pow(10, (-32 - t * 30) / 20);
  };
  const timer = window.setInterval(() => {
    if (audioCtx.state === "suspended") void audioCtx.resume();
    analyser.getFloatTimeDomainData(time);
    let sum = 0;
    for (const value of time) sum += value * value;
    const rms = Math.sqrt(sum / time.length);
    const target = Math.min(1, rms * 8);
    smooth = target > smooth ? smooth * 0.45 + target * 0.55 : smooth * 0.82 + target * 0.18;
    if (!micOn) {
      glide(0, 0.08);
      return;
    }
    if (!vadOn) {
      glide(micGain, 0.05);
      return;
    }
    const thresh = openAt();
    const now = audioCtx.currentTime;
    const heard = rms >= thresh || (gateOpen && rms >= thresh * 0.38);
    if (heard) lastSpeech = now;
    const open = heard || (lastSpeech > 0 && now - lastSpeech < 0.7);
    gateOpen = open;
    glide(open ? micGain : 0, open ? 0.004 : 0.08);
  }, 16);

  let preview = raw;
  let stopVideo = () => undefined as void;
  const videoTrack = raw.getVideoTracks()[0];
  if (videoTrack) await applyCameraTune(videoTrack, settings);
  if (videoTrack && settings.bgMode !== "off") {
    const composed = await compose(videoTrack, settings);
    if (composed) {
      preview = new MediaStream([composed.track, dest.stream.getAudioTracks()[0]]);
      stopVideo = composed.stop;
    }
  }
  const stream = new MediaStream([
    dest.stream.getAudioTracks()[0],
    ...(preview.getVideoTracks().length ? [preview.getVideoTracks()[0]] : []),
  ]);
  if (preview === raw) preview = stream;

  return {
    stream,
    preview,
    level: () => smooth,
    resume: async () => {
      if (audioCtx.state === "closed") return;
      if (audioCtx.state !== "running") await audioCtx.resume();
      if (!micOn) return;
      raw.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
      stream.getAudioTracks().forEach((track) => {
        track.enabled = true;
      });
    },
    health: () => {
      const track = raw.getAudioTracks()[0];
      return {
        ended: !track || track.readyState === "ended",
        muted: Boolean(track?.muted),
        running: audioCtx.state === "running",
      };
    },
    recapture: async () => {
      if (audioCtx.state === "closed") return;
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia({ audio, video: false });
      } catch {
        fresh = await navigator.mediaDevices.getUserMedia({
          audio: captureAudio({ ...settings, micId: "" }),
          video: false,
        });
      }
      const track = fresh.getAudioTracks()[0];
      if (!track) {
        fresh.getTracks().forEach((item) => item.stop());
        return;
      }
      await tuneMic(track, settings);
      source.disconnect();
      raw.getAudioTracks().forEach((item) => item.stop());
      raw = fresh;
      source = audioCtx.createMediaStreamSource(raw);
      wire(source);
      if (audioCtx.state !== "running") await audioCtx.resume();
    },
    applyVoice: (opts) => {
      vadOn = Boolean(opts.vad);
      vadSens = Math.max(0, Math.min(100, opts.vadSensitivity ?? 55));
      micGain = Math.min(2.5, Math.max(0, opts.micGain ?? 1));
      delay.delayTime.value = vadOn ? 0.12 : 0;
      void tuneMic(raw.getAudioTracks()[0], settings);
      analyser.smoothingTimeConstant = vadOn ? 0.05 : 0.35;
      if (!vadOn && micOn) {
        gateOpen = true;
        glide(micGain, 0.05);
      }
    },
    setMic: (on) => {
      micOn = on;
      if (!on) gain.gain.value = 0;
    },
    setCamera: (on) => {
      stream.getVideoTracks().forEach((track) => {
        track.enabled = on;
      });
      preview.getVideoTracks().forEach((track) => {
        track.enabled = on;
      });
    },
    addVideoTrack: (track) => {
      for (const item of stream.getVideoTracks()) {
        if (item !== track && item.readyState !== "live") stream.removeTrack(item);
      }
      if (!stream.getVideoTracks().includes(track)) stream.addTrack(track);
      if (preview !== stream) {
        for (const item of preview.getVideoTracks()) {
          if (item !== track && item.readyState !== "live") preview.removeTrack(item);
        }
        if (!preview.getVideoTracks().includes(track)) preview.addTrack(track);
      }
    },
    clearVideo: () => {
      for (const track of stream.getVideoTracks()) {
        track.stop();
        stream.removeTrack(track);
      }
      if (preview !== stream) {
        for (const track of preview.getVideoTracks()) {
          track.stop();
          preview.removeTrack(track);
        }
      }
      stopVideo();
      stopVideo = () => undefined;
    },
    stop: () => {
      window.clearInterval(timer);
      stopVideo();
      raw.getTracks().forEach((track) => track.stop());
      stream.getTracks().forEach((track) => track.stop());
      void audioCtx.close();
    },
  };
}

async function compose(track: MediaStreamTrack, settings: Settings): Promise<{ track: MediaStreamTrack; stop: () => void } | null> {
  const engine = settings.bgMode === "image" || settings.bgMode === "blur" ? await segmenter() : null;
  if (!engine) return null;
  const video = document.createElement("video");
  video.srcObject = new MediaStream([track]);
  video.muted = true;
  video.playsInline = true;
  await video.play();
  const width = 960;
  const height = 540;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d", { willReadFrequently: true, colorSpace: "srgb" });
  if (!ctx) return null;
  const mask = document.createElement("canvas");
  mask.width = width;
  mask.height = height;
  const maskCtx = mask.getContext("2d");
  if (!maskCtx) return null;
  const bg = new Image();
  if (settings.bgMode === "image") {
    bg.src = settings.bgCustom || `${import.meta.env.BASE_URL}backgrounds/${settings.bgPreset}.svg`;
  }
  let frame = 0;
  const loop = () => {
    frame = requestAnimationFrame(loop);
    if (video.readyState < 2) return;
    const result = engine.segmentForVideo(video, performance.now());
    const category = result.categoryMask;
    if (!category) return;
    maskCtx.drawImage(video, 0, 0, width, height);
    const image = maskCtx.getImageData(0, 0, width, height);
    const data = category.getAsUint8Array() as Uint8Array;
    for (let i = 0; i < data.length; i++) image.data[i * 4 + 3] = data[i] > 0 ? 255 : 0;
    maskCtx.putImageData(image, 0, 0);
    category.close?.();
    ctx.clearRect(0, 0, width, height);
    if (settings.bgMode === "blur") {
      ctx.filter = `blur(${Math.max(4, settings.bgBlur)}px)`;
      ctx.drawImage(video, 0, 0, width, height);
      ctx.filter = "none";
    } else if (bg.complete && bg.naturalWidth) {
      ctx.drawImage(bg, 0, 0, width, height);
    } else {
      ctx.fillStyle = "#243044";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(video, 0, 0, width, height);
    ctx.globalCompositeOperation = "destination-in";
    ctx.drawImage(mask, 0, 0);
    ctx.globalCompositeOperation = "destination-over";
    if (settings.bgMode === "blur") {
      ctx.filter = `blur(${Math.max(4, settings.bgBlur)}px)`;
      ctx.drawImage(video, 0, 0, width, height);
      ctx.filter = "none";
    } else if (bg.complete && bg.naturalWidth) ctx.drawImage(bg, 0, 0, width, height);
    else {
      ctx.fillStyle = "#243044";
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = "source-over";
  };
  frame = requestAnimationFrame(loop);
  const captured = canvas.captureStream(24);
  return {
    track: captured.getVideoTracks()[0],
    stop: () => {
      cancelAnimationFrame(frame);
      video.pause();
      video.srcObject = null;
    },
  };
}

export function duckShareAudio(track: MediaStreamTrack, farTalk: () => number, sendGain = 1): { track: MediaStreamTrack; stop: () => void; setSendGain: (value: number) => void } {
  const ctx = new AudioContext({ latencyHint: "interactive" });
  void ctx.resume();
  const source = ctx.createMediaStreamSource(new MediaStream([track]));
  const gate = ctx.createGain();
  const out = ctx.createGain();
  out.gain.value = Math.min(1, Math.max(0, sendGain));
  source.connect(gate);
  gate.connect(out);
  const dest = ctx.createMediaStreamDestination();
  try {
    dest.channelCount = 2;
  } catch {
    /* keep the default layout */
  }
  out.connect(dest);
  let applied = 1;
  const timer = window.setInterval(() => {
    if (ctx.state === "suspended") void ctx.resume();
    const talk = farTalk();
    const target = talk > 0.045 ? 0.02 : 1;
    if (Math.abs(applied - target) < 0.005) return;
    applied = target;
    const now = ctx.currentTime;
    gate.gain.cancelScheduledValues(now);
    gate.gain.setValueAtTime(gate.gain.value, now);
    gate.gain.linearRampToValueAtTime(target, now + (target < applied ? 0.12 : 0.2));
  }, 16);
  return {
    track: dest.stream.getAudioTracks()[0] ?? track,
    setSendGain: (value) => {
      out.gain.value = Math.min(1, Math.max(0, value));
    },
    stop: () => {
      window.clearInterval(timer);
      try { source.disconnect(); } catch { /* closed */ }
      void ctx.close();
      track.stop();
    },
  };
}

export function watchLevel(track: MediaStreamTrack, onLevel: (value: number) => void, volume = 1, sinkId = "", duck?: () => number): { stop: () => void; setVolume: (value: number) => void } {
  const stream = new MediaStream([track]);
  const el = document.createElement("audio");
  el.autoplay = true;
  el.playsInline = true;
  el.srcObject = stream;
  el.volume = Math.min(1, Math.max(0, volume));
  el.style.display = "none";
  document.body.appendChild(el);
  const withSink = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
  if (sinkId && withSink.setSinkId) void withSink.setSinkId(sinkId);
  void el.play().catch(() => undefined);

  const audio = new AudioContext();
  void audio.resume();
  const source = audio.createMediaStreamSource(stream);
  const analyser = audio.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);
  const time = new Uint8Array(analyser.fftSize);
  let smooth = 0;
  let gain = volume;
  const timer = window.setInterval(() => {
    if (audio.state === "suspended") void audio.resume();
    if (el.paused) void el.play().catch(() => undefined);
    analyser.getByteTimeDomainData(time);
    let sum = 0;
    for (const value of time) {
      const x = (value - 128) / 128;
      sum += x * x;
    }
    const target = Math.min(1, Math.sqrt(sum / time.length) * 5);
    smooth = target > smooth ? smooth * 0.5 + target * 0.5 : smooth * 0.78 + target * 0.22;
    const mute = duck ? duck() : 0;
    el.volume = mute > 0.06 ? 0.02 : Math.min(1, Math.max(0, gain));
    onLevel(smooth);
  }, 50);
  return {
    setVolume: (value) => {
      gain = Math.min(1, Math.max(0, value));
      el.volume = gain;
    },
    stop: () => {
      window.clearInterval(timer);
      source.disconnect();
      el.pause();
      el.srcObject = null;
      el.remove();
      void audio.close();
    },
  };
}
