import { app, nativeImage } from "electron";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const MAX_SOURCE_BYTES = 5 * 1024 * 1024;
const MAX_AVATAR_BYTES = 512 * 1024;
const MAX_DIMENSION = 256;

function assertPeerId(peerId: string) {
  // Проверка идентификатора не позволяет выйти из каталога аватаров через путь к файлу.
  if (!/^[a-zA-Z0-9-]{1,128}$/.test(peerId)) throw new Error("Invalid peer ID");
}

function avatarPath(peerId: string) {
  assertPeerId(peerId);
  return path.join(app.getPath("userData"), "avatars", `${peerId}.jpg`);
}

function hashAvatar(data: Buffer) {
  return crypto.createHash("sha256").update(data).digest("hex").slice(0, 16);
}

function asDataUrl(data: Buffer) {
  return `data:image/jpeg;base64,${data.toString("base64")}`;
}

function ensureAvatarDirectory() {
  fs.mkdirSync(path.join(app.getPath("userData"), "avatars"), { recursive: true });
}

export function saveLocalAvatar(sourcePath: string, peerId: string) {
  const stat = fs.statSync(sourcePath);
  if (!stat.isFile() || stat.size > MAX_SOURCE_BYTES) throw new Error("Avatar image must be smaller than 5 MB");
  const image = nativeImage.createFromPath(sourcePath);
  if (image.isEmpty()) throw new Error("Unsupported avatar image");

  const size = image.getSize();
  // Ограничения размера предотвращают разрастание хранилища и нагрузку при передаче аватаров.
  const scale = Math.min(1, MAX_DIMENSION / Math.max(size.width, size.height));
  const resized = scale < 1 ? image.resize({ width: Math.round(size.width * scale), height: Math.round(size.height * scale) }) : image;
  const data = resized.toJPEG(84);
  if (data.length > MAX_AVATAR_BYTES) throw new Error("Avatar image is too large after compression");

  ensureAvatarDirectory();
  fs.writeFileSync(avatarPath(peerId), data);
  return { avatarHash: hashAvatar(data), dataUrl: asDataUrl(data) };
}

export function getAvatarDataUrl(peerId: string, expectedHash?: string) {
  const filePath = avatarPath(peerId);
  if (!fs.existsSync(filePath)) return null;
  const data = fs.readFileSync(filePath);
  const avatarHash = hashAvatar(data);
  if (expectedHash && avatarHash !== expectedHash) return null;
  return { avatarHash, dataUrl: asDataUrl(data) };
}

export function saveRemoteAvatar(peerId: string, avatarHash: string, dataUrl: string) {
  // Принимается только ожидаемый JPEG data URL, чтобы не сохранять произвольные данные от узла.
  const match = /^data:image\/jpeg;base64,([a-zA-Z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("Unsupported avatar format");
  const data = Buffer.from(match[1], "base64");
  if (data.length === 0 || data.length > MAX_AVATAR_BYTES) throw new Error("Avatar image is too large");
  const image = nativeImage.createFromBuffer(data);
  if (image.isEmpty() || hashAvatar(data) !== avatarHash) throw new Error("Invalid avatar image");

  ensureAvatarDirectory();
  fs.writeFileSync(avatarPath(peerId), data);
  return { avatarHash, dataUrl: asDataUrl(data) };
}

export function removeAvatar(peerId: string) {
  const filePath = avatarPath(peerId);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}
