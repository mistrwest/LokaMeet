import { nativeImage, app } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_EDGE = 1920;
const MAX_CUSTOM = 16;
const ID_RE = /^[a-zA-Z0-9-]{1,64}$/;

export type CustomCameraBackground = { id: string; dataUrl: string };

function bgDir() {
  return path.join(app.getPath("userData"), "camera-bg");
}

function fileFor(id: string) {
  if (!ID_RE.test(id)) throw new Error("Invalid background id");
  return path.join(bgDir(), `${id}.jpg`);
}

function ensureDir() {
  fs.mkdirSync(bgDir(), { recursive: true });
}

function asDataUrl(data: Buffer) {
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

function migrateLegacy() {
  ensureDir();
  const legacy = path.join(bgDir(), "custom.jpg");
  if (!fs.existsSync(legacy)) return;
  const migrated = path.join(bgDir(), "custom-legacy.jpg");
  if (!fs.existsSync(migrated)) fs.renameSync(legacy, migrated);
  else fs.unlinkSync(legacy);
}

function readRecord(id: string): CustomCameraBackground | null {
  const filePath = fileFor(id);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  if (!data.length) return null;
  return { id, dataUrl: asDataUrl(data) };
}

export function listCustomCameraBackgrounds(): CustomCameraBackground[] {
  migrateLegacy();
  const names = fs.readdirSync(bgDir());
  const out: CustomCameraBackground[] = [];
  for (const name of names) {
    const match = /^([a-zA-Z0-9-]{1,64})\.jpg$/.exec(name);
    if (!match) continue;
    const rec = readRecord(match[1]);
    if (rec) out.push(rec);
  }
  return out;
}

export function saveCustomCameraBackground(sourcePath: string) {
  if (typeof sourcePath !== "string" || !sourcePath) throw new Error("Invalid background path");
  if (listCustomCameraBackgrounds().length >= MAX_CUSTOM) throw new Error("Too many custom backgrounds");
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("Background image must be smaller than 12 MB");
  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error("Unsupported background image");
  const size = image.getSize();
  const scale = Math.min(1, MAX_EDGE / Math.max(size.width, size.height));
  const resized =
    scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }) : image;
  const data = resized.toJPEG(82);
  const id = `c${Date.now().toString(36)}${crypto.randomBytes(4).toString("hex")}`;
  fs.writeFileSync(fileFor(id), data);
  return { id, dataUrl: asDataUrl(data) };
}

export function getCustomCameraBackground(id?: string) {
  migrateLegacy();
  if (typeof id === "string" && id) return readRecord(id);
  return listCustomCameraBackgrounds()[0] ?? null;
}

export function removeCustomCameraBackground(id: string) {
  if (typeof id !== "string" || !ID_RE.test(id)) throw new Error("Invalid background id");
  migrateLegacy();
  const filePath = fileFor(id);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  return true;
}
