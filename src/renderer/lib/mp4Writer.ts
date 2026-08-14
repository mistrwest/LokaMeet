/** Минимальный muxer AVC+AAC в MP4 (без внешних зависимостей). */

function concat(parts: Uint8Array[]) {
  const size = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(size);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u8(...bytes: number[]) {
  return new Uint8Array(bytes);
}

function u16(n: number) {
  return u8((n >>> 8) & 255, n & 255);
}

function u24(n: number) {
  return u8((n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function u32(n: number) {
  return u8((n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255);
}

function latin1(text: string) {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 255;
  return out;
}

function box(type: string, ...payload: Uint8Array[]) {
  const body = concat(payload);
  return concat([u32(body.length + 8), latin1(type), body]);
}

function fullBox(type: string, version: number, flags: number, ...payload: Uint8Array[]) {
  return box(type, u8(version, (flags >>> 16) & 255, (flags >>> 8) & 255, flags & 255), ...payload);
}

export type Mp4Sample = {
  data: Uint8Array;
  timestamp: number;
  duration: number;
  keyframe: boolean;
};

export type Mp4VideoTrack = {
  width: number;
  height: number;
  timescale: number;
  avcC: Uint8Array;
  samples: Mp4Sample[];
};

export type Mp4AudioTrack = {
  sampleRate: number;
  channelCount: number;
  timescale: number;
  decSpecific: Uint8Array;
  samples: Mp4Sample[];
};

function stts(samples: Mp4Sample[]) {
  const entries: Array<{ count: number; duration: number }> = [];
  for (const sample of samples) {
    const last = entries[entries.length - 1];
    if (last && last.duration === sample.duration) last.count += 1;
    else entries.push({ count: 1, duration: sample.duration });
  }
  return fullBox(
    "stts",
    0,
    0,
    u32(entries.length),
    ...entries.flatMap((e) => [u32(e.count), u32(e.duration)])
  );
}

function stss(samples: Mp4Sample[]) {
  const keys = samples.map((s, i) => (s.keyframe ? i + 1 : 0)).filter((n) => n > 0);
  if (!keys.length) return fullBox("stss", 0, 0, u32(0));
  return fullBox("stss", 0, 0, u32(keys.length), ...keys.map((n) => u32(n)));
}

function stsc(count: number) {
  if (!count) return fullBox("stsc", 0, 0, u32(0));
  return fullBox("stsc", 0, 0, u32(1), u32(1), u32(count), u32(1));
}

function stsz(samples: Mp4Sample[]) {
  return fullBox("stsz", 0, 0, u32(0), u32(samples.length), ...samples.map((s) => u32(s.data.length)));
}

function stco(offset: number) {
  return fullBox("stco", 0, 0, u32(1), u32(offset));
}

function mdhd(timescale: number, duration: number) {
  return fullBox("mdhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u16(0x55c4), u16(0));
}

function hdlr(handler: string, name: string) {
  return fullBox("hdlr", 0, 0, u32(0), latin1(handler), u32(0), u32(0), u32(0), latin1(name), u8(0));
}

function dinf() {
  return box("dinf", fullBox("dref", 0, 0, u32(1), box("url ", u8(0, 0, 0, 1))));
}

function tkhd(id: number, duration: number, width: number, height: number, audio: boolean) {
  const volume = audio ? 0x0100 : 0;
  const matrix = concat([
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000)
  ]);
  return fullBox(
    "tkhd",
    0,
    7,
    u32(0),
    u32(0),
    u32(id),
    u32(0),
    u32(duration),
    u32(0),
    u32(0),
    u16(0),
    u16(0),
    u16(volume),
    u16(0),
    matrix,
    u32(width << 16),
    u32(height << 16)
  );
}

function vmhd() {
  return fullBox("vmhd", 0, 1, u16(0), u16(0), u16(0), u16(0));
}

function smhd() {
  return fullBox("smhd", 0, 0, u16(0), u16(0));
}

function avcSampleEntry(width: number, height: number, avcC: Uint8Array) {
  const reserved = new Uint8Array(6);
  const compressor = new Uint8Array(32);
  const avcCBox = avcC.length >= 8 && avcC[4] === 0x61 && avcC[5] === 0x76 && avcC[6] === 0x63 && avcC[7] === 0x43
    ? avcC
    : box("avcC", avcC);
  return box(
    "avc1",
    reserved,
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u32(0),
    u32(0),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1),
    compressor,
    u16(0x0018),
    u16(0xffff),
    avcCBox
  );
}

function mp4aSampleEntry(sampleRate: number, channelCount: number, decSpecific: Uint8Array) {
  const reserved = new Uint8Array(6);
  const esds = fullBox(
    "esds",
    0,
    0,
    u8(0x03),
    u8(23 + decSpecific.length),
    u16(1),
    u8(0),
    u8(0x04),
    u8(15 + decSpecific.length),
    u8(0x40),
    u8(0x15),
    u24(0),
    u32(0),
    u32(0),
    u8(0x05),
    u8(decSpecific.length),
    decSpecific,
    u8(0x06),
    u8(1),
    u8(2)
  );
  return box(
    "mp4a",
    reserved,
    u16(1),
    u16(0),
    u16(0),
    u32(0),
    u16(channelCount),
    u16(16),
    u16(0),
    u16(0),
    u32(sampleRate << 16),
    esds
  );
}

function trackDuration(samples: Mp4Sample[]) {
  return samples.reduce((n, s) => n + s.duration, 0);
}

function movieDuration(video?: Mp4VideoTrack, audio?: Mp4AudioTrack, movieTimescale = 1000) {
  let seconds = 0;
  if (video?.samples.length) seconds = Math.max(seconds, trackDuration(video.samples) / video.timescale);
  if (audio?.samples.length) seconds = Math.max(seconds, trackDuration(audio.samples) / audio.timescale);
  return Math.max(1, Math.round(seconds * movieTimescale));
}

function mvhd(duration: number, timescale = 1000, nextTrackId = 2) {
  const matrix = concat([
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x00010000),
    u32(0),
    u32(0),
    u32(0),
    u32(0x40000000)
  ]);
  return fullBox("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), u16(0), u32(0), u32(0), matrix, u32(0), u32(0), u32(0), u32(0), u32(0), u32(0), u32(nextTrackId));
}

export function muxMp4(video: Mp4VideoTrack, audio?: Mp4AudioTrack | null): Uint8Array {
  if (!video.samples.length) throw new Error("no-video-samples");
  const movieTs = 1000;
  const duration = movieDuration(video, audio ?? undefined, movieTs);
  const videoDur = trackDuration(video.samples);
  const audioDur = audio?.samples.length ? trackDuration(audio.samples) : 0;
  const chunks = [video.samples.map((s) => s.data)];
  if (audio?.samples.length) chunks.push(audio.samples.map((s) => s.data));
  const mdatPayload = concat(chunks.flat());
  const mdat = box("mdat", mdatPayload);

  const ftyp = box("ftyp", latin1("isom"), u32(0x200), latin1("isom"), latin1("iso2"), latin1("avc1"), latin1("mp41"));

  const videoStsd = fullBox("stsd", 0, 0, u32(1), avcSampleEntry(video.width, video.height, video.avcC));
  const videoStbl = box("stbl", videoStsd, stts(video.samples), stss(video.samples), stsc(video.samples.length), stsz(video.samples), stco(0));
  const videoMinf = box("minf", vmhd(), dinf(), videoStbl);
  const videoMdia = box("mdia", mdhd(video.timescale, videoDur), hdlr("vide", "VideoHandler"), videoMinf);
  const videoTrak = box("trak", tkhd(1, duration, video.width, video.height, false), videoMdia);

  const tracks = [videoTrak];
  if (audio?.samples.length) {
    const audioStsd = fullBox("stsd", 0, 0, u32(1), mp4aSampleEntry(audio.sampleRate, audio.channelCount, audio.decSpecific));
    const audioStbl = box("stbl", audioStsd, stts(audio.samples), stsc(audio.samples.length), stsz(audio.samples), stco(0));
    const audioMinf = box("minf", smhd(), dinf(), audioStbl);
    const audioMdia = box("mdia", mdhd(audio.timescale, audioDur), hdlr("soun", "SoundHandler"), audioMinf);
    tracks.push(box("trak", tkhd(2, duration, 0, 0, true), audioMdia));
  }

  const nextTrackId = audio?.samples.length ? 3 : 2;
  const moov = box("moov", mvhd(duration, movieTs, nextTrackId), ...tracks);
  const header = concat([ftyp, moov]);
  const mdatStart = header.length;
  const videoOffset = mdatStart + 8;
  const audioOffset = videoOffset + video.samples.reduce((n, s) => n + s.data.length, 0);

  const patchedVideo = box("stbl", videoStsd, stts(video.samples), stss(video.samples), stsc(video.samples.length), stsz(video.samples), stco(videoOffset));
  const patchedVideoMinf = box("minf", vmhd(), dinf(), patchedVideo);
  const patchedVideoMdia = box("mdia", mdhd(video.timescale, videoDur), hdlr("vide", "VideoHandler"), patchedVideoMinf);
  const patchedVideoTrak = box("trak", tkhd(1, duration, video.width, video.height, false), patchedVideoMdia);
  const patchedTracks = [patchedVideoTrak];
  if (audio?.samples.length) {
    const audioStsd = fullBox("stsd", 0, 0, u32(1), mp4aSampleEntry(audio.sampleRate, audio.channelCount, audio.decSpecific));
    const patchedAudio = box("stbl", audioStsd, stts(audio.samples), stsc(audio.samples.length), stsz(audio.samples), stco(audioOffset));
    const patchedAudioMinf = box("minf", smhd(), dinf(), patchedAudio);
    const patchedAudioMdia = box("mdia", mdhd(audio.timescale, audioDur), hdlr("soun", "SoundHandler"), patchedAudioMinf);
    patchedTracks.push(box("trak", tkhd(2, duration, 0, 0, true), patchedAudioMdia));
  }
  const patchedMoov = box("moov", mvhd(duration, movieTs, nextTrackId), ...patchedTracks);
  return concat([ftyp, patchedMoov, mdat]);
}
