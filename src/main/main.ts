import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app, BrowserWindow, Menu, session, desktopCapturer } from "electron";
import { v4 as uuidv4 } from "uuid";
import { LanDiscovery, DiscoverySnapshot } from "./discovery/LanDiscovery";
import { SignalingServer, HostedRoom } from "./signaling/SignalingServer";
import { registerIpc, emitToRenderer, MainState } from "./ipc";
import { getPreferredDisplayMediaSourceId, setPreferredDisplayMediaSourceId } from "./displayMediaPreference";
import { loadState, saveState } from "./storage";
import { ChatMessage, UserProfile, WsEnvelope } from "../shared/types";
import { logInfo, logError } from "./log";
import { initLogger } from "./logger";

let mainWindow: BrowserWindow | null = null;

// Только LAN: ICE-кандидаты с реальными локальными IP, а не mDNS-именами.
// Существенно повышает надёжность WebRTC там, где mDNS нестабилен или заблокирован.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns");

const defaultProfile: UserProfile = {
  peerId: uuidv4(),
  userName: "User",
  status: "online",
  statusText: "",
  language: "ru",
  theme: "ipad-lagoon",
  uiChatHeight: 380,
  uiSidebarWidth: 360,
  uiFontScale: 0.95,
  uiCompact: false,
  uiShowSeconds: false,
  defaultVideoQuality: "medium",
  autoSwitchToChatOnAccept: true,
  audioInputDeviceId: "",
  audioOutputDeviceId: "",
  videoInputDeviceId: "",
  chatAutoScroll: true,
  chatSmileSizePx: 24,
  chatFontSize: 14,
  chatDisplayLimit: 0,
  uiSpeakingIndicator: true,
  uiTileAspect: "16x9",
  uiTileObjectFit: "cover",
  uiTileRadius: 12,
  uiTileGap: 5,
  uiLayoutVersion: 2,
  microphoneVolume: 100,
  speakerVolume: 100,
  remoteMicVolume: 100,
  remoteScreenShareVolume: 100,
  noiseSuppression: false,
  noiseSuppressionSensitivity: 50,
  soundNotificationsEnabled: true,
  soundNotificationVolume: 50,
  callSoundFile: "snds/call.mp3",
  messageSoundFile: "snds/sms.mp3",
  autoAwayMinutes: 5
};

const state: MainState = {
  profile: defaultProfile,
  chats: [],
  hostedRoom: undefined
};

let discoverySnapshot: DiscoverySnapshot = { peers: [], rooms: [] };

const signaling = new SignalingServer(
  () => ({
    peerId: state.profile.peerId,
    userName: state.profile.userName,
    status: state.profile.status,
    statusText: state.profile.statusText,
    avatarHash: state.profile.avatarHash,
    avatarPosition: state.profile.avatarPosition
  }),
  {
    onPort: () => {
      discovery.republishPeer();
    },
    onEnvelope: (env: WsEnvelope) => {
      emitToRenderer(mainWindow, "net:envelope", env);
    },
    onRoomUpdated: (roomId, participantsApprox) => {
      const room = state.hostedRoom;
      if (room && room.roomId === roomId) {
        discovery.publishRoom({
          roomId: room.roomId,
          roomName: room.roomName,
          hasPassword: Boolean(room.password),
          maxParticipants: room.maxParticipants,
          participantsApprox
        });
      }
    },
    onRoomClosed: (roomId) => {
      discovery.unpublishRoom(roomId);
    }
  }
);

const discovery = new LanDiscovery(
  () => state.profile,
  () => signaling.getPort(),
  {
    onChange: (snapshot) => {
      discoverySnapshot = snapshot;
      emitToRenderer(mainWindow, "discovery:update", snapshot);
    }
  }
);

async function createMainWindow() {
  Menu.setApplicationMenu(null);
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1600,
    minHeight: 900,
    title: "LokaMeet",
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#0b0f16",
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.setMenuBarVisibility(false);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.show();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    const indexHtml = path.join(__dirname, "..", "renderer", "index.html");
    await mainWindow.loadFile(indexHtml);
  }

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // Screen share в Electron: desktopCapturer + setDisplayMediaRequestHandler
  const ses = session.defaultSession;
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    try {
      const preferredId = getPreferredDisplayMediaSourceId();
      const sources = await desktopCapturer.getSources({
        types: ["screen", "window"],
        thumbnailSize: { width: 150, height: 150 }
      });

      if (sources.length === 0) {
        callback({});
        return;
      }

      const source =
        (preferredId ? sources.find((s) => s.id === preferredId) : undefined) ||
        sources.find((s) => s.id.startsWith("screen:")) ||
        sources[0];

      // На Windows — loopback системного звука; в renderer — suppressLocalAudioPlayback (анти-эхо).
      const response: { video: typeof source; audio?: "loopback" | "loopbackWithMute" } = { video: source };
      if (request.audioRequested && process.platform === "win32") {
        response.audio = "loopback";
      }
      callback(response);
      // Предпочтение источника — одноразовое (после picker сбрасываем).
      setPreferredDisplayMediaSourceId(null);
    } catch (err) {
      logError("Screen share handler error", { error: String(err) });
      callback({});
    }
  });
}

function setProfile(patch: Partial<UserProfile>) {
  state.profile = { ...state.profile, ...patch };
  if (state.profile.hasChosenName) {
    discovery.republishPeer();
  } else {
    discovery.unpublishPeer();
  }
  saveState({ profile: state.profile, chats: state.chats });
}

function appendChat(m: ChatMessage) {
  state.chats.push(m);
  // Храним только последние 2000 сообщений, чтобы state.json не раздувался
  if (state.chats.length > 2000) state.chats.splice(0, state.chats.length - 2000);
  saveState({ profile: state.profile, chats: state.chats });
}

function createRoom(input: { roomName: string; password?: string; maxParticipants: number }): HostedRoom {
  if (state.hostedRoom) {
    signaling.closeHostedRoom(state.hostedRoom.roomId);
    discovery.unpublishRoom(state.hostedRoom.roomId);
  }
  const room = signaling.createHostedRoom(input);
  state.hostedRoom = room;
  discovery.publishRoom({
    roomId: room.roomId,
    roomName: room.roomName,
    hasPassword: Boolean(room.password),
    maxParticipants: room.maxParticipants,
    participantsApprox: room.participants.size
  });
  return room;
}

function closeRoom(roomId: string) {
  if (state.hostedRoom?.roomId === roomId) state.hostedRoom = undefined;
  signaling.closeHostedRoom(roomId);
  discovery.unpublishRoom(roomId);
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", () => {
  discovery.stop();
  signaling.stop();
  saveState({ profile: state.profile, chats: state.chats });

  // Чистим только temp-пути с именем LokaMeet — не трогаем чужие Electron/Chromium папки
  try {
    const tempDir = os.tmpdir();
    if (fs.existsSync(tempDir)) {
      const files = fs.readdirSync(tempDir);
      for (const file of files) {
        if (!/LokaMeet/i.test(file)) continue;
        const fullPath = path.join(tempDir, file);
        try {
          const stat = fs.statSync(fullPath);
          if (stat.isDirectory()) {
            fs.rmSync(fullPath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(fullPath);
          }
        } catch {
          // отдельный файл мог быть занят — пропускаем
        }
      }
    }
  } catch {
    // сбой очистки temp не должен блокировать выход
  }
});

app.whenReady().then(async () => {
  const suffix = process.env.LOKAMEET_PROFILE?.trim();
  if (suffix) {
    // Отдельный userData для второго экземпляра на той же машине (тесты A/B)
    app.setPath("userData", path.join(app.getPath("appData"), `LokaMeet-${suffix}`));
  }

  // Логгер раньше всего — иначе ранние ошибки теряются
  initLogger();
  logInfo("App starting", { version: app.getVersion(), profile: suffix || "default" });

  process.on("uncaughtException", (e) => logError("uncaughtException", { message: String((e as any)?.message ?? e), stack: (e as any)?.stack }));
  process.on("unhandledRejection", (e) => logError("unhandledRejection", { reason: e }));

  const persisted = loadState(defaultProfile);
  state.profile = { ...persisted.profile, hasChosenName: false };
  state.chats = persisted.chats;
  logInfo("State loaded", { chatsCount: state.chats.length, userName: state.profile.userName });

  signaling.start();
  discovery.start();
  logInfo("Services started", { signalingPort: signaling.getPort() });

  await createMainWindow();

  registerIpc({
    win: () => mainWindow,
    getState: () => state,
    setProfile,
    appendChat,
    signaling,
    getDiscovery: () => discoverySnapshot,
    onCreateRoom: createRoom,
    onCloseRoom: closeRoom
  });

  logInfo("App ready", { peerId: state.profile.peerId });
});

