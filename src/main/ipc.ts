import { app, BrowserWindow, desktopCapturer, ipcMain, screen } from "electron";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChatMessage, UserProfile, WsEnvelope } from "../shared/types";
import { DiscoverySnapshot } from "./discovery/LanDiscovery";
import { HostedRoom, SignalingServer } from "./signaling/SignalingServer";
import { saveState } from "./storage";
import { getLogInfo, writeLog } from "./logger";
import { setPreferredDisplayMediaSourceId } from "./displayMediaPreference";
import { getAvatarDataUrl, removeAvatar, saveLocalAvatar, saveRemoteAvatar } from "./avatarStore";
import {
  getCustomCameraBackground,
  listCustomCameraBackgrounds,
  removeCustomCameraBackground,
  saveCustomCameraBackground
} from "./cameraBgStore";
import { AviWriter } from "./aviWriter";

type RecordingSession =
  | { kind: "bytes"; stream: fs.WriteStream; filePath: string; bytes: number; chunks: number }
  | { kind: "avi"; writer: AviWriter; filePath: string; jpeg: number; pcm: number };

const recordingWrites = new Map<string, RecordingSession>();

type AviBeginOptions = {
  format: "avi";
  width: number;
  height: number;
  fps: number;
  sampleRate: number;
};

export type MainState = {
  profile: UserProfile;
  chats: ChatMessage[];
  hostedRoom?: HostedRoom;
};

export function registerIpc(params: {
  win: () => BrowserWindow | null;
  getState: () => MainState;
  setProfile: (patch: Partial<UserProfile>) => void;
  appendChat: (m: ChatMessage) => void;
  signaling: SignalingServer;
  getDiscovery: () => DiscoverySnapshot;
  onCreateRoom: (input: { roomName: string; password?: string; maxParticipants: number }) => HostedRoom;
  onCloseRoom: (roomId: string) => void;
  openSettingsWindow: () => boolean;
  closeSettingsWindow: () => boolean;
}) {
  ipcMain.handle("app:getState", () => {
    const s = params.getState();
    return {
      profile: s.profile,
      chats: s.chats,
      hostedRoom: s.hostedRoom,
      signalingPort: params.signaling.getPort(),
      appVersion: app.getVersion()
    };
  });

  // setProfile сам пишет state.json — без повторного saveState
  ipcMain.handle("app:updateProfile", (_evt, patch: Partial<UserProfile>) => {
    params.setProfile(patch);
    return params.getState().profile;
  });

  ipcMain.handle("app:quit", () => {
    app.quit();
    return true;
  });

  ipcMain.handle("app:flashFrame", () => {
    const win = params.win();
    if (!win || win.isDestroyed() || win.isFocused()) return false;
    win.flashFrame(true);
    return true;
  });

  ipcMain.handle("avatar:saveFromPath", (_evt, sourcePath: string) => {
    const peerId = params.getState().profile.peerId;
    const avatar = saveLocalAvatar(sourcePath, peerId);
    params.setProfile({ avatarHash: avatar.avatarHash });
    return avatar;
  });

  ipcMain.handle("avatar:remove", () => {
    const peerId = params.getState().profile.peerId;
    removeAvatar(peerId);
    params.setProfile({ avatarHash: undefined });
    return true;
  });

  ipcMain.handle("avatar:get", (_evt, peerId: string, avatarHash?: string) => getAvatarDataUrl(peerId, avatarHash));

  ipcMain.handle("avatar:storeRemote", (_evt, peerId: string, avatarHash: string, dataUrl: string) =>
    saveRemoteAvatar(peerId, avatarHash, dataUrl)
  );

  ipcMain.handle("discovery:getSnapshot", () => params.getDiscovery());

  ipcMain.handle("net:connect", async (_evt, host: string, port: number) => {
    return await params.signaling.connectToPeer(host, port);
  });

  ipcMain.handle("net:getLocalIPv4", () => {
    const nets = os.networkInterfaces();
    const out: string[] = [];
    for (const name of Object.keys(nets)) {
      for (const n of nets[name] ?? []) {
        if (n.family !== "IPv4") continue;
        if (n.internal) continue;
        out.push(n.address);
      }
    }
    return out;
  });

  ipcMain.handle("net:sendToPeer", (_evt, peerId: string, env: WsEnvelope) => {
    return params.signaling.sendToPeer(peerId, env);
  });

  ipcMain.handle("room:create", (_evt, input: { roomName: string; password?: string; maxParticipants: number }) => {
    // hostedRoom живёт только в памяти main — на диск не пишем
    return params.onCreateRoom(input);
  });

  ipcMain.handle("room:close", (_evt, roomId: string) => {
    params.onCloseRoom(roomId);
    return true;
  });

  // appendChat сам пишет state.json — без повторного saveState
  ipcMain.handle("chat:append", (_evt, message: ChatMessage) => {
    params.appendChat(message);
    return true;
  });

  ipcMain.handle("app:openDevTools", () => {
    params.win()?.webContents.openDevTools({ mode: "detach" });
    return true;
  });

  ipcMain.handle("app:openPath", async (_evt, pathToOpen: string) => {
    const { shell } = require("electron");
    await shell.openPath(pathToOpen);
    return true;
  });

  ipcMain.handle("app:openExternal", async (_evt, url: string) => {
    const { shell } = require("electron");
    if (typeof url !== "string") return false;
    if (!/^https?:\/\//i.test(url) && !/^ms-settings:/i.test(url)) return false;
    await shell.openExternal(url);
    return true;
  });

  ipcMain.handle("app:clipboardReadText", () => {
    const { clipboard } = require("electron");
    return String(clipboard.readText() ?? "");
  });

  ipcMain.handle("app:clipboardReadImage", () => {
    const { clipboard } = require("electron");
    const image = clipboard.readImage();
    if (!image || image.isEmpty()) return null;
    const png = image.toPNG();
    if (!png || png.length < 32) return null;
    return `data:image/png;base64,${png.toString("base64")}`;
  });

  ipcMain.handle("app:clipboardReadPaste", () => {
    const { clipboard } = require("electron");
    const fs = require("fs") as typeof import("fs");
    let imageDataUrl: string | null = null;
    try {
      const image = clipboard.readImage();
      if (image && !image.isEmpty()) {
        const png = image.toPNG();
        if (png && png.length >= 32 && png.length < 40 * 1024 * 1024) {
          imageDataUrl = `data:image/png;base64,${png.toString("base64")}`;
        }
      }
    } catch {
      imageDataUrl = null;
    }
    return { imageDataUrl, filePaths: readClipboardFilePaths(clipboard, fs) };
  });

  ipcMain.handle("app:readLocalFile", (_evt, filePath: string) => {
    const fs = require("fs") as typeof import("fs");
    if (typeof filePath !== "string" || filePath.length < 2 || filePath.length > 1024) return null;
    let resolved = "";
    try {
      resolved = path.resolve(filePath);
    } catch {
      return null;
    }
    if (!fs.existsSync(resolved)) return null;
    const stat = fs.statSync(resolved);
    if (!stat.isFile() || stat.size > 256 * 1024 * 1024) return null;
    return { name: path.basename(resolved), size: stat.size, data: fs.readFileSync(resolved) };
  });

  ipcMain.handle("link:probe", async (_evt, raw: string) => {
    if (typeof raw !== "string" || !/^https?:\/\//i.test(raw)) return null;
    return probeLink(raw);
  });

  ipcMain.handle("app:clipboardWriteText", (_evt, text: string) => {
    const { clipboard } = require("electron");
    clipboard.writeText(typeof text === "string" ? text : "");
    return true;
  });

  ipcMain.handle("log:getInfo", () => getLogInfo());
  ipcMain.handle("log:write", (_evt, payload: { level: "DEBUG" | "INFO" | "WARN" | "ERROR"; scope: string; msg: string; data?: unknown }) => {
    writeLog(payload.level, payload.scope, payload.msg, payload.data);
    return true;
  });

  ipcMain.handle("smiles:list", () => {
    const root = app.getAppPath();
    const src = path.join(root, "smiles");
    const dist = path.join(root, "dist", "renderer", "smiles");
    const base = fs.existsSync(dist) ? dist : src;
    if (!fs.existsSync(base)) return [];
    const files = fs.readdirSync(base).filter((n) => /\.(gif|png)$/i.test(n));
    files.sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }));
    return files;
  });

  ipcMain.handle("chat:clearHistory", () => {
    const s = params.getState();
    s.chats = [];
    saveState({ profile: s.profile, chats: s.chats });
    for (const w of BrowserWindow.getAllWindows()) {
      if (!w.isDestroyed()) w.webContents.send("chat:cleared");
    }
    return true;
  });

  ipcMain.handle("app:showOpenDialog", async (evt, options: { filters?: Array<{ name: string; extensions: string[] }>; properties?: Array<"openFile" | "openDirectory" | "createDirectory">; defaultPath?: string }) => {
    const { dialog } = require("electron");
    const senderWin = BrowserWindow.fromWebContents(evt.sender);
    const result = await dialog.showOpenDialog(senderWin ?? params.win()!, {
      properties: options.properties?.length ? options.properties : ["openFile"],
      filters: options.filters || [{ name: "All Files", extensions: ["*"] }],
      defaultPath: options.defaultPath
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(
    "recording:begin",
    async (_evt, dir: string, fileName: string, avi?: AviBeginOptions) => {
      if (!dir || !fileName) return null;
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(dir);
      } catch {
        return null;
      }
      if (!stat.isDirectory()) return null;
      const safeName = path.basename(String(fileName)).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_");
      if (!/\.(mp4|avi)$/i.test(safeName)) return null;
      const filePath = path.join(dir, safeName);
      if (path.resolve(path.dirname(filePath)) !== path.resolve(dir)) return null;
      const id = randomUUID();
      if (avi?.format === "avi") {
        const writer = new AviWriter(
          filePath,
          Number(avi.width) || 1280,
          Number(avi.height) || 720,
          Number(avi.fps) || 30,
          Number(avi.sampleRate) || 48000
        );
        recordingWrites.set(id, { kind: "avi", writer, filePath, jpeg: 0, pcm: 0 });
        writeLog("INFO", "main", "Recording begin", { filePath, format: "avi", width: avi.width, height: avi.height, fps: avi.fps });
        return { id, filePath };
      }
      const stream = fs.createWriteStream(filePath);
      recordingWrites.set(id, { kind: "bytes", stream, filePath, bytes: 0, chunks: 0 });
      writeLog("INFO", "main", "Recording begin", { filePath, format: "mp4" });
      return { id, filePath };
    }
  );

  ipcMain.handle("recording:append", async (_evt, id: string, data: string) => {
    const session = recordingWrites.get(id);
    if (!session || session.kind !== "bytes" || typeof data !== "string" || !data) return false;
    const buf = Buffer.from(data, "base64");
    if (!buf.length) return false;
    try {
      await new Promise<void>((resolve, reject) => {
        session.stream.write(buf, (err) => (err ? reject(err) : resolve()));
      });
    } catch (err) {
      writeLog("ERROR", "main", "Recording chunk write failed", { error: String(err), bytes: buf.length });
      return false;
    }
    session.bytes += buf.length;
    session.chunks += 1;
    return true;
  });

  ipcMain.handle("recording:aviJpeg", async (_evt, id: string, data: string) => {
    const session = recordingWrites.get(id);
    if (!session || session.kind !== "avi" || typeof data !== "string" || !data) return false;
    const buf = Buffer.from(data, "base64");
    if (!buf.length) return false;
    session.writer.addJpeg(buf);
    session.jpeg += 1;
    return true;
  });

  ipcMain.handle("recording:aviPcm", async (_evt, id: string, data: string) => {
    const session = recordingWrites.get(id);
    if (!session || session.kind !== "avi" || typeof data !== "string" || !data) return false;
    const buf = Buffer.from(data, "base64");
    if (!buf.length) return false;
    session.writer.addPcm(buf);
    session.pcm += 1;
    return true;
  });

  ipcMain.handle("recording:finish", async (_evt, id: string) => {
    const session = recordingWrites.get(id);
    if (!session) return null;
    recordingWrites.delete(id);
    if (session.kind === "avi") {
      try {
        const filePath = session.writer.finish();
        const stats = session.writer.getStats();
        let size = 0;
        try {
          size = fs.statSync(filePath).size;
        } catch {
          size = 0;
        }
        writeLog(size > 0 ? "INFO" : "ERROR", "main", "Recording saved", {
          filePath,
          format: "avi",
          bytes: size,
          jpeg: session.jpeg,
          pcm: session.pcm,
          fps: Number(stats.fps.toFixed(2)),
          usecPerFrame: stats.usecPerFrame,
          audioBytes: stats.audioBytes
        });
        return filePath;
      } catch (err) {
        writeLog("ERROR", "main", "Recording mux failed", { error: String(err), format: "avi" });
        session.writer.discard();
        return null;
      }
    }
    await new Promise<void>((resolve) => session.stream.end(() => resolve()));
    let size = 0;
    try {
      size = fs.statSync(session.filePath).size;
    } catch {
      size = 0;
    }
    writeLog(size > 0 ? "INFO" : "ERROR", "main", "Recording saved", {
      filePath: session.filePath,
      format: "mp4",
      bytes: size,
      bytesWritten: session.bytes,
      chunks: session.chunks
    });
    return session.filePath;
  });

  // Источники экрана/окон для picker демонстрации экрана
  ipcMain.handle("screen:getRefreshRate", () => {
    try {
      const displays = screen.getAllDisplays();
      let hz = 0;
      for (const display of displays) {
        if (display.displayFrequency > hz) hz = display.displayFrequency;
      }
      return hz > 0 ? hz : 60;
    } catch (err) {
      writeLog("WARN", "main", "Display refresh rate unavailable", { error: String(err) });
      return 60;
    }
  });

  ipcMain.handle("screen:getCaptureTarget", (_evt, sourceId?: string | null) => {
    const fallback = { width: 1920, height: 1080, fps: 60 };
    try {
      const displays = screen.getAllDisplays();
      if (displays.length === 0) return fallback;
      let display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
      if (typeof sourceId === "string" && sourceId.startsWith("screen:")) {
        const id = Number(sourceId.split(":")[1]);
        const matched = displays.find((item) => item.id === id);
        if (matched) display = matched;
      }
      if (!display) {
        display = displays.reduce((best, item) =>
          item.size.width * item.size.height > best.size.width * best.size.height ? item : best
        );
      }
      const scale = display.scaleFactor > 0 ? display.scaleFactor : 1;
      return {
        width: Math.max(2, Math.round(display.size.width * scale)),
        height: Math.max(2, Math.round(display.size.height * scale)),
        fps: display.displayFrequency > 0 ? display.displayFrequency : 60
      };
    } catch (err) {
      writeLog("WARN", "main", "Display capture size unavailable", { error: String(err) });
      return fallback;
    }
  });

  ipcMain.handle("screen:getSources", async () => {
    const sources = await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 150, height: 150 }
    });
    return sources.map((source) => ({
      id: source.id,
      name: source.name,
      thumbnail: source.thumbnail.toDataURL()
    }));
  });

  ipcMain.handle("screen:getAppWindowSourceId", async (evt) => {
    const win = params.win();
    if (!win || win.isDestroyed()) return null;
    try {
      const id = win.webContents.getMediaSourceId(evt.sender);
      if (id) return id;
    } catch (err) {
      writeLog("WARN", "main", "App window media source id failed", { error: String(err) });
    }
    try {
      const sources = await desktopCapturer.getSources({
        types: ["window"],
        thumbnailSize: { width: 1, height: 1 }
      });
      const title = win.getTitle();
      const match =
        sources.find((s) => s.name === title) ||
        sources.find((s) => /lokameet/i.test(s.name));
      return match?.id ?? null;
    } catch (err) {
      writeLog("WARN", "main", "App window source lookup failed", { error: String(err) });
      return null;
    }
  });

  ipcMain.handle("screen:setPreferredSource", (_evt, sourceId: string | null) => {
    setPreferredDisplayMediaSourceId(sourceId);
    return true;
  });

  ipcMain.handle("screen:keepCapturerAlive", async () => {
    await desktopCapturer.getSources({
      types: ["screen", "window"],
      thumbnailSize: { width: 1, height: 1 }
    });
    return true;
  });

  ipcMain.handle("cameraBg:saveFromPath", (_evt, sourcePath: string) => saveCustomCameraBackground(sourcePath));
  ipcMain.handle("cameraBg:list", () => listCustomCameraBackgrounds());
  ipcMain.handle("cameraBg:get", (_evt, id?: string) => getCustomCameraBackground(id));
  ipcMain.handle("cameraBg:remove", (_evt, id: string) => removeCustomCameraBackground(id));

  ipcMain.handle("settings:open", () => params.openSettingsWindow());
  ipcMain.handle("settings:close", () => params.closeSettingsWindow());
}

function kindFromContentType(contentType: string): "image" | "animation" | "video" | "audio" | null {
  const ct = contentType.toLowerCase();
  if (!ct) return null;
  if (ct.includes("gif") || ct.includes("apng")) return "animation";
  if (ct.startsWith("image/")) return "image";
  if (ct.startsWith("video/")) return "video";
  if (ct.startsWith("audio/")) return "audio";
  return null;
}

function requestContentType(url: string, method: "HEAD" | "GET"): Promise<string> {
  const { net } = require("electron") as typeof import("electron");
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const req = net.request({ method, url });
      const timer = setTimeout(() => {
        try {
          req.abort();
        } catch {
          // уже закрыт
        }
        done("");
      }, 4000);
      req.on("response", (res) => {
        clearTimeout(timer);
        const header = res.headers["content-type"];
        const ct = Array.isArray(header) ? header[0] : header || "";
        res.on("data", () => undefined);
        res.on("end", () => undefined);
        try {
          req.abort();
        } catch {
          // тело больше не нужно
        }
        done(String(ct));
      });
      req.on("error", () => {
        clearTimeout(timer);
        done("");
      });
      req.end();
    } catch {
      done("");
    }
  });
}

async function probeLinkContentType(url: string) {
  const head = await requestContentType(url, "HEAD");
  if (kindFromContentType(head)) return head;
  return requestContentType(url, "GET");
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function metaContent(html: string, key: string) {
  const attr = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${attr}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${attr}["']`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1].trim());
  }
  return "";
}

function isVideoPage(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    const pagePath = parsed.pathname;
    if (host === "vkvideo.ru" || host === "vk.com" || host === "m.vk.com" || host === "vk.ru") {
      return /\/(?:video|clip|live)(-?\d+)_(\d+)/.test(pagePath);
    }
    if (host === "rutube.ru" || host.endsWith(".rutube.ru")) return /\/(?:video|shorts|play\/embed)\//.test(pagePath);
    if (host === "vimeo.com" || host.endsWith(".vimeo.com")) return /\/\d+/.test(pagePath);
    if (host === "dailymotion.com" || host.endsWith(".dailymotion.com")) return /\/video\//.test(pagePath);
    if (host === "ok.ru" || host.endsWith(".ok.ru")) return /\/video\//.test(pagePath);
    if (host === "coub.com") return /\/view\//.test(pagePath);
    return false;
  } catch {
    return false;
  }
}

function isImageSearch(url: string) {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, "");
    if (host.includes("yandex.") && parsed.pathname.includes("/images")) return true;
    if (host.includes("google.") && (parsed.pathname.includes("/imgres") || parsed.pathname.includes("/search"))) {
      return parsed.searchParams.has("imgurl") || parsed.searchParams.has("tbm");
    }
    if (host.includes("bing.") && parsed.pathname.includes("/images")) return true;
    return false;
  } catch {
    return false;
  }
}

function readHtmlPrefix(url: string): Promise<string> {
  const { net } = require("electron") as typeof import("electron");
  return new Promise((resolve) => {
    let settled = false;
    const done = (value: string) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    try {
      const req = net.request({ method: "GET", url });
      try {
        req.setHeader(
          "User-Agent",
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
        );
        req.setHeader("Accept", "text/html,application/xhtml+xml");
        req.setHeader("Accept-Language", "ru,en;q=0.8");
      } catch {
        // заголовки необязательны для локальных адресов
      }
      const timer = setTimeout(() => {
        try {
          req.abort();
        } catch {
          // уже закрыт
        }
        done("");
      }, 5000);
      req.on("response", (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size <= 180_000) chunks.push(chunk);
          if (size >= 180_000) {
            clearTimeout(timer);
            try {
              req.abort();
            } catch {
              // хватит префикса страницы
            }
          }
        });
        res.on("end", () => {
          clearTimeout(timer);
          done(Buffer.concat(chunks).toString("utf8"));
        });
        res.on("error", () => {
          clearTimeout(timer);
          done(Buffer.concat(chunks).toString("utf8"));
        });
      });
      req.on("error", () => {
        clearTimeout(timer);
        done("");
      });
      req.end();
    } catch {
      done("");
    }
  });
}

async function probeLink(url: string): Promise<{ kind: "image" | "animation" | "video" | "audio"; previewUrl?: string; mediaUrl?: string } | null> {
  const contentType = await probeLinkContentType(url);
  const direct = kindFromContentType(contentType);
  if (direct) return { kind: direct, mediaUrl: url, previewUrl: direct === "image" || direct === "animation" ? url : undefined };
  if (!isVideoPage(url) && !isImageSearch(url)) return null;
  const html = await readHtmlPrefix(url);
  if (!html) return null;
  const image = metaContent(html, "og:image") || metaContent(html, "twitter:image") || metaContent(html, "twitter:image:src");
  const video = metaContent(html, "og:video") || metaContent(html, "og:video:url");
  if (isVideoPage(url)) {
    const decoded = html.replace(/\\u0026/g, "&").replace(/\\\//g, "/");
    const hosted = decoded.match(/https?:\/\/[^"'\\\s<>]+(?:userapi\.com|mycdn\.me|vk\.me|okcdn\.ru)[^"'\\\s<>]+/i)?.[0] ?? "";
    const preview = /^https?:\/\//i.test(image) ? image : /^https?:\/\//i.test(hosted) ? hosted : "";
    return {
      kind: "video",
      previewUrl: preview || undefined,
      mediaUrl: /^https?:\/\//i.test(video) ? video : undefined
    };
  }
  if (/^https?:\/\//i.test(image)) return { kind: "image", previewUrl: image, mediaUrl: image };
  return null;
}

function readClipboardFilePaths(clipboard: { readBuffer: (format: string) => Buffer }, fs: typeof import("fs")) {
  const found: string[] = [];
  const add = (candidate: string) => {
    const filePath = candidate.trim().replace(/^"|"$/g, "");
    if (!filePath || filePath.length < 3 || found.includes(filePath)) return;
    try {
      if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) found.push(filePath);
    } catch {
      // битый путь в буфере пропускаем
    }
  };
  const fromUtf16 = (buf: Buffer) => {
    if (!buf || buf.length < 4) return;
    const text = buf.toString("utf16le").replace(/\u0000+$/g, "");
    for (const part of text.split("\u0000")) add(part);
  };
  for (const format of ["FileNameW", "CF_HDROP", "text/uri-list", "text/x-moz-url"]) {
    let buf: Buffer;
    try {
      buf = clipboard.readBuffer(format);
    } catch {
      continue;
    }
    if (!buf || buf.length === 0) continue;
    if (format === "FileNameW" || format === "CF_HDROP") {
      fromUtf16(buf);
      if (found.length === 0) {
        const ansi = buf.toString("utf8").replace(/\u0000+$/g, "");
        for (const part of ansi.split("\u0000")) add(part);
      }
      continue;
    }
    const text = buf.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      if (/^file:/i.test(trimmed)) {
        try {
          const parsed = new URL(trimmed);
          let name = decodeURIComponent(parsed.pathname);
          if (/^\/[A-Za-z]:/.test(name)) name = name.slice(1);
          add(name);
        } catch {
          // не uri
        }
      } else {
        add(trimmed);
      }
    }
  }
  return found;
}

export function emitToRenderer(win: BrowserWindow | null, channel: string, ...args: any[]) {
  if (!win) return;
  win.webContents.send(channel, ...args);
}

