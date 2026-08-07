import { BrowserWindow, ipcMain, desktopCapturer } from "electron";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { ChatMessage, UserProfile, WsEnvelope } from "../shared/types";
import { DiscoverySnapshot } from "./discovery/LanDiscovery";
import { HostedRoom, SignalingServer } from "./signaling/SignalingServer";
import { saveState } from "./storage";
import { getLogInfo, writeLog } from "./logger";
import { setPreferredDisplayMediaSourceId } from "./displayMediaPreference";
import { getAvatarDataUrl, removeAvatar, saveLocalAvatar, saveRemoteAvatar } from "./avatarStore";

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
    return true;
  });

  ipcMain.handle("app:showOpenDialog", async (_evt, options: { filters?: Array<{ name: string; extensions: string[] }> }) => {
    const { dialog } = require("electron");
    const result = await dialog.showOpenDialog(params.win()!, {
      properties: ["openFile"],
      filters: options.filters || [{ name: "All Files", extensions: ["*"] }]
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
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

  ipcMain.handle("screen:setPreferredSource", (_evt, sourceId: string | null) => {
    setPreferredDisplayMediaSourceId(sourceId);
    return true;
  });
}

export function emitToRenderer(win: BrowserWindow | null, channel: string, ...args: any[]) {
  if (!win) return;
  win.webContents.send(channel, ...args);
}

