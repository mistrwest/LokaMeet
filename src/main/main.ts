import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { app, BrowserWindow, Menu, session, desktopCapturer, nativeImage } from "electron";
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
let settingsWindow: BrowserWindow | null = null;

// Только LAN: ICE-кандидаты с реальными локальными IP, а не mDNS-именами.
// Существенно повышает надёжность WebRTC там, где mDNS нестабилен или заблокирован.
app.commandLine.appendSwitch("disable-features", "WebRtcHideLocalIpsWithMdns,CalculateNativeWinOcclusion");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-background-timer-throttling");

const defaultProfile: UserProfile = {
  peerId: uuidv4(),
  userName: "User",
  status: "online",
  statusText: "",
  language: "ru",
  theme: "ipd-lagoon",
  uiChatHeight: 380,
  uiSidebarWidth: 360,
  uiFontScale: 0.95,
  uiCompact: false,
  uiShowSeconds: false,
  defaultVideoQuality: "auto",
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
  noiseSuppression: true,
  noiseSuppressionSensitivity: 65,
  voiceActivation: false,
  voiceActivationSensitivity: 50,
  soundNotificationsEnabled: true,
  soundNotificationVolume: 50,
  callSoundFile: "snds/call.mp3",
  messageSoundFile: "snds/sms.mp3",
  autoAwayMinutes: 5,
  gamesSettings: {
    boardScale: "large",
    showCoordinates: true,
    highlightLastMove: true,
    confirmResign: true,
    soundEnabled: true,
    soundVolume: 55,
    checkersShowHints: true,
    chessShowHints: true,
    battleshipShowSunkOutline: true
  }
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

async function loadRenderer(win: BrowserWindow, query?: Record<string, string>) {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    const url = new URL(devUrl);
    if (query) {
      for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    }
    await win.loadURL(url.toString());
    return;
  }
  const indexHtml = path.join(__dirname, "..", "renderer", "index.html");
  await win.loadFile(indexHtml, query ? { query } : undefined);
}

function attachRendererGuards(win: BrowserWindow) {
  win.webContents.on("will-navigate", (event, url) => {
    const current = win.webContents.getURL();
    if (url !== current) event.preventDefault();
  });
  win.webContents.on("context-menu", (_event, params) => {
    const { editFlags, isEditable, selectionText } = params;
    const template: Electron.MenuItemConstructorOptions[] = isEditable
      ? [
          { role: "undo", enabled: editFlags.canUndo },
          { role: "redo", enabled: editFlags.canRedo },
          { type: "separator" },
          { role: "cut", enabled: editFlags.canCut },
          { role: "copy", enabled: editFlags.canCopy },
          { role: "paste", enabled: editFlags.canPaste },
          { role: "selectAll", enabled: editFlags.canSelectAll }
        ]
      : [
          { role: "copy", enabled: Boolean(selectionText) || editFlags.canCopy },
          { role: "selectAll" }
        ];
    Menu.buildFromTemplate(template).popup({ window: win });
  });
}

function openSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) {
    if (settingsWindow.isMinimized()) settingsWindow.restore();
    settingsWindow.show();
    settingsWindow.focus();
    return true;
  }
  const preload = path.join(__dirname, "..", "preload", "preload.js");
  const mainBounds = mainWindow?.getBounds();
  settingsWindow = new BrowserWindow({
    width: 720,
    height: 900,
    minWidth: 720,
    minHeight: 900,
    x: mainBounds ? mainBounds.x + Math.max(24, Math.round((mainBounds.width - 720) / 2)) : undefined,
    y: mainBounds ? mainBounds.y + 48 : undefined,
    frame: false,
    show: false,
    backgroundColor: "#111827",
    autoHideMenuBar: true,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: true,
    fullscreenable: false,
    icon: resolveAppIcon(),
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  applyWindowIcon(settingsWindow);
  attachRendererGuards(settingsWindow);
  settingsWindow.on("page-title-updated", (e) => e.preventDefault());
  settingsWindow.setTitle("LokaMeet");
  settingsWindow.once("ready-to-show", () => {
    settingsWindow?.show();
    settingsWindow?.focus();
  });
  settingsWindow.on("closed", () => {
    settingsWindow = null;
  });
  void loadRenderer(settingsWindow, { window: "settings" });
  return true;
}

function closeSettingsWindow() {
  if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
  return true;
}

function resolveAppIcon(): string | undefined {
  const candidates = [
    path.join(process.cwd(), "build", "icon.ico"),
    path.join(__dirname, "..", "..", "build", "icon.ico"),
    path.join(app.getAppPath(), "build", "icon.ico"),
    path.join(process.cwd(), "build", "icon.png"),
    path.join(__dirname, "..", "..", "build", "icon.png"),
    path.join(app.getAppPath(), "build", "icon.png")
  ];
  return candidates.find((file) => fs.existsSync(file));
}

function applyWindowIcon(win: BrowserWindow) {
  const file = resolveAppIcon();
  if (!file) return;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) return;
  win.setIcon(image);
}

async function createMainWindow() {
  Menu.setApplicationMenu(null);
  const appTitle = `LokaMeet ${app.getVersion()}`;
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1600,
    minHeight: 900,
    title: appTitle,
    autoHideMenuBar: true,
    show: false,
    backgroundColor: "#0b0f16",
    icon: resolveAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  });
  mainWindow.setMenuBarVisibility(false);
  applyWindowIcon(mainWindow);
  attachRendererGuards(mainWindow);
  // Vite/index.html ставит <title>LokaMeet</title> и сбрасывает заголовок окна — блокируем.
  mainWindow.on("page-title-updated", (e) => {
    e.preventDefault();
  });
  mainWindow.setTitle(appTitle);

  mainWindow.once("ready-to-show", () => {
    mainWindow?.setTitle(appTitle);
    mainWindow?.show();
  });
  mainWindow.on("focus", () => {
    mainWindow?.flashFrame(false);
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) {
    await mainWindow.loadURL(devUrl);
  } else {
    const indexHtml = path.join(__dirname, "..", "renderer", "index.html");
    await mainWindow.loadFile(indexHtml);
  }
  mainWindow.setTitle(appTitle);

  mainWindow.on("closed", () => {
    mainWindow = null;
    if (settingsWindow && !settingsWindow.isDestroyed()) settingsWindow.close();
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

function discoveryFieldsChanged(prev: UserProfile, next: UserProfile) {
  return (
    prev.status !== next.status ||
    prev.userName !== next.userName ||
    prev.statusText !== next.statusText ||
    prev.avatarHash !== next.avatarHash ||
    prev.hasChosenName !== next.hasChosenName ||
    JSON.stringify(prev.avatarPosition ?? null) !== JSON.stringify(next.avatarPosition ?? null)
  );
}

function setProfile(patch: Partial<UserProfile>) {
  const prev = state.profile;
  state.profile = { ...state.profile, ...patch };
  if (state.profile.hasChosenName) {
    if (discoveryFieldsChanged(prev, state.profile)) {
      discovery.republishPeer();
    }
  } else {
    discovery.unpublishPeer();
  }
  if (prev.status !== state.profile.status) {
    signaling.broadcastSelfHello();
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
    onCloseRoom: closeRoom,
    openSettingsWindow,
    closeSettingsWindow
  });

  logInfo("App ready", { peerId: state.profile.peerId });
});

