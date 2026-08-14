import { BrowserWindow, ipcMain, desktopCapturer } from "electron";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { app } from "electron";
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

export function emitToRenderer(win: BrowserWindow | null, channel: string, ...args: any[]) {
  if (!win) return;
  win.webContents.send(channel, ...args);
}

