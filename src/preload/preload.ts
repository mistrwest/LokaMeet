import { contextBridge, ipcRenderer } from "electron";
import type { ChatMessage, UserProfile, WsEnvelope } from "../shared/types";
import type { DiscoverySnapshot } from "../main/discovery/LanDiscovery";
import type { HostedRoom } from "../main/signaling/SignalingServer";

type Unsub = () => void;

// Слой preload предоставляет рендереру узкий IPC-интерфейс вместо прямого доступа к Electron API.
const api = {
  app: {
    getState: () => ipcRenderer.invoke("app:getState") as Promise<{ profile: UserProfile; chats: ChatMessage[]; hostedRoom?: HostedRoom; signalingPort: number }>,
    updateProfile: (patch: Partial<UserProfile>) => ipcRenderer.invoke("app:updateProfile", patch) as Promise<UserProfile>,
    openDevTools: () => ipcRenderer.invoke("app:openDevTools") as Promise<boolean>,
    openPath: (pathToOpen: string) => ipcRenderer.invoke("app:openPath", pathToOpen) as Promise<boolean>,
    openExternal: (url: string) => ipcRenderer.invoke("app:openExternal", url) as Promise<boolean>,
    showOpenDialog: (options: { filters?: Array<{ name: string; extensions: string[] }> }) => ipcRenderer.invoke("app:showOpenDialog", options) as Promise<string | null>
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
      ipcRenderer.invoke("net:connect", host, port) as Promise<{ peerId: string; userName: string; status: string; statusText?: string; avatarHash?: string; avatarPosition?: { x: number; y: number } }>,
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
    clearHistory: () => ipcRenderer.invoke("chat:clearHistory") as Promise<boolean>
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
    getSources: () => ipcRenderer.invoke("screen:getSources") as Promise<Array<{ id: string; name: string; thumbnail: string }>>,
    setPreferredSource: (sourceId: string | null) => ipcRenderer.invoke("screen:setPreferredSource", sourceId) as Promise<boolean>
  }
};

contextBridge.exposeInMainWorld("lokameet", api);

export type LokaMeetApi = typeof api;

