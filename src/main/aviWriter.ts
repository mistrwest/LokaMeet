import fs from "node:fs";

function fourcc(tag: string) {
  return Buffer.from(tag, "ascii");
}

function u16(n: number) {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(n & 0xffff, 0);
  return buf;
}

function u32(n: number) {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(n >>> 0, 0);
  return buf;
}

function i32(n: number) {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(n, 0);
  return buf;
}

type IndexEntry = { id: string; flags: number; offset: number; size: number };

/**
 * Потоковый MJPEG+PCM AVI: кадры пишутся на диск сразу,
 * заголовок и индекс собираются при завершении.
 */
export class AviWriter {
  readonly filePath: string;
  private readonly tmpPath: string;
  private readonly width: number;
  private readonly height: number;
  private readonly fps: number;
  private readonly sampleRate: number;
  private fd: number;
  private moviBytes = 4;
  private frames = 0;
  private audioBytes = 0;
  private maxFrame = 0;
  private readonly index: IndexEntry[] = [];
  private closed = false;
  private videoScale = 1;
  private videoRate: number;
  private usecPerFrame: number;

  constructor(filePath: string, width: number, height: number, fps: number, sampleRate: number) {
    this.filePath = filePath;
    this.tmpPath = `${filePath}.movi.tmp`;
    this.width = Math.max(16, Math.round(width));
    this.height = Math.max(16, Math.round(height));
    this.fps = Math.max(1, Math.round(fps));
    this.sampleRate = Math.max(8000, Math.round(sampleRate));
    this.videoRate = this.fps;
    this.usecPerFrame = Math.max(1, Math.round(1_000_000 / this.fps));
    this.fd = fs.openSync(this.tmpPath, "w");
  }

  getStats() {
    return {
      frames: this.frames,
      audioBytes: this.audioBytes,
      fps: this.videoRate / this.videoScale,
      usecPerFrame: this.usecPerFrame
    };
  }

  addJpeg(jpeg: Buffer) {
    if (this.closed || jpeg.length < 2) return;
    this.addChunk("00dc", jpeg, 0x10);
    this.frames += 1;
    if (jpeg.length > this.maxFrame) this.maxFrame = jpeg.length;
  }

  addPcm(pcm: Buffer) {
    if (this.closed || pcm.length < 2) return;
    this.addChunk("01wb", pcm, 0);
    this.audioBytes += pcm.length;
  }

  finish() {
    if (this.closed) return this.filePath;
    this.closed = true;
    fs.closeSync(this.fd);
    this.syncVideoRateToAudio();
    const hdrl = this.buildHdrl();
    const idx1 = this.buildIdx1();
    const moviPayload = this.moviBytes;
    const riffSize = 4 + hdrl.length + 8 + moviPayload + idx1.length;
    const out = fs.openSync(this.filePath, "w");
    fs.writeSync(out, fourcc("RIFF"));
    fs.writeSync(out, u32(riffSize));
    fs.writeSync(out, fourcc("AVI "));
    fs.writeSync(out, hdrl);
    fs.writeSync(out, fourcc("LIST"));
    fs.writeSync(out, u32(moviPayload));
    fs.writeSync(out, fourcc("movi"));
    const tmp = fs.openSync(this.tmpPath, "r");
    const buf = Buffer.alloc(1024 * 1024);
    let n = 0;
    while ((n = fs.readSync(tmp, buf, 0, buf.length, null)) > 0) {
      fs.writeSync(out, buf, 0, n);
    }
    fs.closeSync(tmp);
    fs.writeSync(out, idx1);
    fs.closeSync(out);
    try {
      fs.unlinkSync(this.tmpPath);
    } catch {
      // временный файл мог быть уже удалён
    }
    return this.filePath;
  }

  discard() {
    if (!this.closed) {
      this.closed = true;
      try {
        fs.closeSync(this.fd);
      } catch {
        // дескриптор мог быть уже закрыт
      }
    }
    try {
      fs.unlinkSync(this.tmpPath);
    } catch {
      // игнор
    }
    try {
      fs.unlinkSync(this.filePath);
    } catch {
      // игнор
    }
  }

  /**
   * Кадры JPEG приходят реже целевых fps (toBlob + IPC).
   * Подгоняем dwRate/dwScale под длительность PCM, иначе плеер
   * крутит видео быстрее звука и дорожки расходятся.
   */
  private syncVideoRateToAudio() {
    const pcmSamples = Math.floor(this.audioBytes / 2);
    if (this.frames < 1) {
      this.videoScale = 1;
      this.videoRate = this.fps;
      this.usecPerFrame = Math.max(1, Math.round(1_000_000 / this.fps));
      return;
    }
    if (pcmSamples < this.sampleRate / 4) {
      this.videoScale = 1;
      this.videoRate = this.fps;
      this.usecPerFrame = Math.max(1, Math.round(1_000_000 / this.fps));
      return;
    }
    this.videoScale = 1000;
    this.videoRate = Math.max(1, Math.round((this.frames * this.sampleRate * 1000) / pcmSamples));
    this.usecPerFrame = Math.max(1, Math.round((pcmSamples * 1_000_000) / (this.frames * this.sampleRate)));
  }

  private addChunk(id: string, data: Buffer, flags: number) {
    const pad = data.length % 2;
    const header = Buffer.concat([fourcc(id), u32(data.length)]);
    fs.writeSync(this.fd, header);
    fs.writeSync(this.fd, data);
    if (pad) fs.writeSync(this.fd, Buffer.from([0]));
    this.index.push({ id, flags, offset: this.moviBytes, size: data.length });
    this.moviBytes += 8 + data.length + pad;
  }

  private buildHdrl() {
    const avih = this.buildAvih();
    const video = this.buildVideoStrl();
    const audio = this.buildAudioStrl();
    const payload = Buffer.concat([avih, video, audio]);
    return Buffer.concat([fourcc("LIST"), u32(payload.length + 4), fourcc("hdrl"), payload]);
  }

  private buildAvih() {
    const suggested = Math.max(this.maxFrame, this.width * this.height);
    const body = Buffer.concat([
      u32(this.usecPerFrame),
      u32(suggested * this.fps),
      u32(0),
      u32(0x110),
      u32(this.frames),
      u32(0),
      u32(2),
      u32(suggested),
      u32(this.width),
      u32(this.height),
      u32(0),
      u32(0),
      u32(0),
      u32(0)
    ]);
    return Buffer.concat([fourcc("avih"), u32(body.length), body]);
  }

  private buildVideoStrl() {
    const strhBody = Buffer.concat([
      fourcc("vids"),
      fourcc("MJPG"),
      u32(0),
      u16(0),
      u16(0),
      u32(0),
      u32(this.videoScale),
      u32(this.videoRate),
      u32(0),
      u32(this.frames),
      u32(Math.max(this.maxFrame, 1)),
      i32(-1),
      u32(0),
      u16(0),
      u16(0),
      u16(this.width),
      u16(this.height)
    ]);
    const strh = Buffer.concat([fourcc("strh"), u32(strhBody.length), strhBody]);
    const strfBody = Buffer.concat([
      u32(40),
      i32(this.width),
      i32(this.height),
      u16(1),
      u16(24),
      fourcc("MJPG"),
      u32(this.width * this.height * 3),
      u32(0),
      u32(0),
      u32(0),
      u32(0)
    ]);
    const strf = Buffer.concat([fourcc("strf"), u32(strfBody.length), strfBody]);
    const payload = Buffer.concat([strh, strf]);
    return Buffer.concat([fourcc("LIST"), u32(payload.length + 4), fourcc("strl"), payload]);
  }

  private buildAudioStrl() {
    const blockAlign = 2;
    const avgBytes = this.sampleRate * blockAlign;
    const samples = Math.floor(this.audioBytes / blockAlign);
    const strhBody = Buffer.concat([
      fourcc("auds"),
      u32(0),
      u32(0),
      u16(0),
      u16(0),
      u32(0),
      u32(blockAlign),
      u32(avgBytes),
      u32(0),
      u32(Math.max(1, samples)),
      u32(avgBytes),
      i32(-1),
      u32(blockAlign),
      u16(0),
      u16(0),
      u16(0),
      u16(0)
    ]);
    const strh = Buffer.concat([fourcc("strh"), u32(strhBody.length), strhBody]);
    const strfBody = Buffer.concat([
      u16(1),
      u16(1),
      u32(this.sampleRate),
      u32(avgBytes),
      u16(blockAlign),
      u16(16)
    ]);
    const strf = Buffer.concat([fourcc("strf"), u32(strfBody.length), strfBody]);
    const payload = Buffer.concat([strh, strf]);
    return Buffer.concat([fourcc("LIST"), u32(payload.length + 4), fourcc("strl"), payload]);
  }

  private buildIdx1() {
    const entries = this.index.map((item) =>
      Buffer.concat([fourcc(item.id), u32(item.flags), u32(item.offset), u32(item.size)])
    );
    const body = Buffer.concat(entries);
    return Buffer.concat([fourcc("idx1"), u32(body.length), body]);
  }
}
