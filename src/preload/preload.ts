import { contextBridge, ipcRenderer } from "electron";
import type { ChatMessage, UserProfile, WsEnvelope } from "../shared/types";
import type { DiscoverySnapshot } from "../main/discovery/LanDiscovery";
import type { HostedRoom } from "../main/signaling/SignalingServer";

type Unsub = () => void;

// Слой preload предоставляет рендереру узкий IPC-интерфейс вместо прямого доступа к Electron API.
const api = {
  app: {
    getState: () =>
      ipcRenderer.invoke("app:getState") as Promise<{
        profile: UserProfile;
        chats: ChatMessage[];
        hostedRoom?: HostedRoom;
        signalingPort: number;
        appVersion: string;
      }>,
    updateProfile: (patch: Partial<UserProfile>) => ipcRenderer.invoke("app:updateProfile", patch) as Promise<UserProfile>,
    openDevTools: () => ipcRenderer.invoke("app:openDevTools") as Promise<boolean>,
    openPath: (pathToOpen: string) => ipcRenderer.invoke("app:openPath", pathToOpen) as Promise<boolean>,
    openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url) as Promise<boolean>,
    clipboardReadText: () => ipcRenderer.invoke("app:clipboardReadText") as Promise<string>,
    clipboardReadImage: () => ipcRenderer.invoke("app:clipboardReadImage") as Promise<string | null>,
    clipboardReadPaste: () =>
      ipcRenderer.invoke("app:clipboardReadPaste") as Promise<{ imageDataUrl: string | null; filePaths: string[] }>,
    readLocalFile: (filePath: string) =>
      ipcRenderer.invoke("app:readLocalFile", filePath) as Promise<{ name: string; size: number; data: Uint8Array } | null>,
    clipboardWriteText: (text: string) => ipcRenderer.invoke("app:clipboardWriteText", text) as Promise<boolean>,
    linkProbe: (url: string) =>
      ipcRenderer.invoke("link:probe", url) as Promise<{
        kind: "image" | "animation" | "video" | "audio";
        previewUrl?: string;
        mediaUrl?: string;
      } | null>,
    showOpenDialog: (options: {
      filters?: Array<{ name: string; extensions: string[] }>;
      properties?: Array<"openFile" | "openDirectory" | "createDirectory">;
      defaultPath?: string;
    }) => ipcRenderer.invoke("app:showOpenDialog", options) as Promise<string | null>,
    quit: () => ipcRenderer.invoke("app:quit") as Promise<boolean>,
    flashFrame: () => ipcRenderer.invoke("app:flashFrame") as Promise<boolean>
  },
  avatar: {
    saveFromPath: (sourcePath: string) =>
      ipcRenderer.invoke("avatar:saveFromPath", sourcePath) as Promise<{ avatarHash: string; dataUrl: string }>,
    remove: () => ipcRenderer.invoke("avatar:remove") as Promise<boolean>,
    get: (peerId: string, avatarHash?: string) =>
      ipcRenderer.invoke("avatar:get", peerId, avatarHash) as Promise<{ avatarHash: string; dataUrl: string } | null>,
    storeRemote: (peerId: string, avatarHash: string, dataUrl: string) =>
      ipcRenderer.invoke("avatar:storeRemote", peerId, avatarHash, dataUrl) as Promise<{ avatarHash: string; dataUrl: string }>
  },
  discovery: {
    getSnapshot: () => ipcRenderer.invoke("discovery:getSnapshot") as Promise<DiscoverySnapshot>,
    onUpdate: (cb: (snapshot: DiscoverySnapshot) => void): Unsub => {
      const listener = (_: unknown, snapshot: DiscoverySnapshot) => cb(snapshot);
      ipcRenderer.on("discovery:update", listener);
      // Отписка предотвращает накопление обработчиков после размонтирования React-компонентов.
      return () => ipcRenderer.removeListener("discovery:update", listener);
    }
  },
  net: {
    connect: (host: string, port: number) =>
      ipcRenderer.invoke("net:connect", host, port) as Promise<{ peerId: string; userName: string; status: string; statusText?: string; avatarHash?: string; avatarPosition?: import("../shared/types").AvatarPosition }>,
    getLocalIPv4: () => ipcRenderer.invoke("net:getLocalIPv4") as Promise<string[]>,
    sendToPeer: (peerId: string, env: WsEnvelope) => ipcRenderer.invoke("net:sendToPeer", peerId, env) as Promise<boolean>,
    onEnvelope: (cb: (env: WsEnvelope) => void): Unsub => {
      const listener = (_: unknown, env: WsEnvelope) => cb(env);
      ipcRenderer.on("net:envelope", listener);
      // Обработчик удаляется симметрично подписке, чтобы старые экраны не получали сообщения.
      return () => ipcRenderer.removeListener("net:envelope", listener);
    }
  },
  room: {
    create: (input: { roomName: string; password?: string; maxParticipants: number }) =>
      ipcRenderer.invoke("room:create", input) as Promise<HostedRoom>,
    close: (roomId: string) => ipcRenderer.invoke("room:close", roomId) as Promise<boolean>
  },
  chat: {
    append: (message: ChatMessage) => ipcRenderer.invoke("chat:append", message) as Promise<boolean>,
    clearHistory: () => ipcRenderer.invoke("chat:clearHistory") as Promise<boolean>,
    onCleared: (cb: () => void): Unsub => {
      const listener = () => cb();
      ipcRenderer.on("chat:cleared", listener);
      return () => ipcRenderer.removeListener("chat:cleared", listener);
    }
  },
  log: {
    getInfo: () => ipcRenderer.invoke("log:getInfo") as Promise<{ logFilePath: string | null; logDirPath: string | null }>,
    write: (payload: { level: "DEBUG" | "INFO" | "WARN" | "ERROR"; scope: string; msg: string; data?: unknown }) =>
      ipcRenderer.invoke("log:write", payload) as Promise<boolean>
  },
  smiles: {
    list: () => ipcRenderer.invoke("smiles:list") as Promise<string[]>
  },
  screen: {
    getRefreshRate: () => ipcRenderer.invoke("screen:getRefreshRate") as Promise<number>,
    getCaptureTarget: (sourceId?: string | null) =>
      ipcRenderer.invoke("screen:getCaptureTarget", sourceId ?? null) as Promise<{ width: number; height: number; fps: number }>,
    getSources: () => ipcRenderer.invoke("screen:getSources") as Promise<Array<{ id: string; name: string; thumbnail: string }>>,
    setPreferredSource: (sourceId: string | null) => ipcRenderer.invoke("screen:setPreferredSource", sourceId) as Promise<boolean>,
    getAppWindowSourceId: () => ipcRenderer.invoke("screen:getAppWindowSourceId") as Promise<string | null>,
    keepCapturerAlive: () => ipcRenderer.invoke("screen:keepCapturerAlive") as Promise<boolean>
  },
  cameraBg: {
    saveFromPath: (sourcePath: string) =>
      ipcRenderer.invoke("cameraBg:saveFromPath", sourcePath) as Promise<{ id: string; dataUrl: string }>,
    list: () => ipcRenderer.invoke("cameraBg:list") as Promise<Array<{ id: string; dataUrl: string }>>,
    get: (id?: string) => ipcRenderer.invoke("cameraBg:get", id) as Promise<{ id: string; dataUrl: string } | null>,
    remove: (id: string) => ipcRenderer.invoke("cameraBg:remove", id) as Promise<boolean>
  },
  settings: {
    open: () => ipcRenderer.invoke("settings:open") as Promise<boolean>,
    close: () => ipcRenderer.invoke("settings:close") as Promise<boolean>
  },
  recording: {
    begin: (
      dir: string,
      fileName: string,
      avi?: { format: "avi"; width: number; height: number; fps: number; sampleRate: number }
    ) =>
      ipcRenderer.invoke("recording:begin", dir, fileName, avi) as Promise<{ id: string; filePath: string } | null>,
    append: (id: string, data: string) => ipcRenderer.invoke("recording:append", id, data) as Promise<boolean>,
    aviJpeg: (id: string, data: string) => ipcRenderer.invoke("recording:aviJpeg", id, data) as Promise<boolean>,
    aviPcm: (id: string, data: string) => ipcRenderer.invoke("recording:aviPcm", id, data) as Promise<boolean>,
    finish: (id: string) => ipcRenderer.invoke("recording:finish", id) as Promise<string | null>
  }
};

contextBridge.exposeInMainWorld("lokameet", api);

export type LokaMeetApi = typeof api;

