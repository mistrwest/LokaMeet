import { app, BrowserWindow, desktopCapturer, dialog, ipcMain, nativeImage, net, protocol, screen, session, shell } from "electron";
import fs from "fs";
import path from "path";
import { pathToFileURL } from "url";
import { Hub } from "./hub";
import { injectInput, stopInput } from "./input";
import { appLog, initSessionLog, sessionLog } from "./log";
import { APP_NAME, APP_VERSION } from "../shared/version";

protocol.registerSchemesAsPrivileged([
  { scheme: "loka", privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
]);

if (process.platform === "win32") app.setAppUserModelId("local.lokameet.app");
app.setName(APP_NAME);

const profileName = process.env.LOKAMEET_PROFILE;
if (profileName) {
  app.setPath("userData", path.join(app.getPath("appData"), "LokaMeet", profileName));
}
initSessionLog();

let hub: Hub;
let win: BrowserWindow | null = null;
let cleanupTimer: NodeJS.Timeout | null = null;

function emit(event: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send("loka-event", event);
}

async function createWindow(): Promise<void> {
  protocol.handle("loka", (request) => {
    const filePath = new URL(request.url).searchParams.get("path") || "";
    return net.fetch(pathToFileURL(filePath).href);
  });
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    const armed = hub.takeDisplayMedia();
    void desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 320, height: 180 } }).then((sources) => {
      const source = sources.find((item) => item.id === armed?.sourceId) ?? sources[0];
      if (!source) {
        callback({});
        return;
      }
      callback({ video: source, audio: armed?.withAudio ? "loopback" : undefined });
    });
  });

  hub = new Hub(app.getPath("userData"), emit);
  appLog("info", "app", "Settings and history loaded", {
    "history messages": hub.db.shape.messages ? Object.values(hub.db.shape.messages).reduce((sum, list) => sum + list.length, 0) : 0,
    name: hub.db.shape.profile.name || "",
  });
  await hub.start();
  cleanupTimer = setInterval(() => {
    void hub.handle("cleanup", { all: false });
  }, 86_400_000);

  const icon = appIcon();
  win = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 760,
    minHeight: 560,
    backgroundColor: "#0c1018",
    title: `${APP_NAME} ${APP_VERSION}`,
    icon,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "../preload/preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  win.on("page-title-updated", (event) => {
    event.preventDefault();
    win?.setTitle(`${APP_NAME} ${APP_VERSION}`);
  });
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) await win.loadURL(devUrl);
  else await win.loadFile(path.join(__dirname, "../renderer/index.html"));
  win.setTitle(`${APP_NAME} ${APP_VERSION}`);
  appLog("info", "ui", "Window opened");

  ipcMain.handle("loka", async (_event, cmd: string, data: unknown) => {
    if (cmd === "screenSources") {
      const displays = screen.getAllDisplays();
      const primary = screen.getPrimaryDisplay();
      const dip = primary.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"], thumbnailSize: { width: 640, height: 400 } });
      return sources.map((source) => {
        const display = displays.find((item) => String(item.id) === source.display_id);
        const thumb = source.thumbnail.getSize();
        const width = display ? Math.max(1, Math.round(display.size.width * display.scaleFactor)) : Math.max(1, thumb.width);
        const height = display ? Math.max(1, Math.round(display.size.height * display.scaleFactor)) : Math.max(1, thumb.height);
        const x = display ? Math.round(display.bounds.x * dip) : 0;
        const y = display ? Math.round(display.bounds.y * dip) : 0;
        return {
          id: source.id,
          name: source.name,
          thumbnail: source.thumbnail.isEmpty() ? "" : source.thumbnail.toDataURL(),
          width,
          height,
          x,
          y,
          primary: Boolean(display && display.id === primary.id),
        };
      });
    }
    if (cmd === "pickRecordDir") {
      const chosen = await dialog.showOpenDialog(win!, { properties: ["openDirectory"] });
      if (chosen.canceled || !chosen.filePaths[0]) return false;
      return hub.handle("pickRecordDir", { dir: chosen.filePaths[0] });
    }
    if (cmd === "openPath") {
      const target = String((data as { path?: string })?.path ?? "");
      if (target && fs.existsSync(target)) await shell.openPath(target);
      return true;
    }
    if (cmd === "openExternal") {
      const url = String((data as { url?: string })?.url ?? "");
      let parsed: URL;
      try {
        parsed = new URL(url);
      } catch {
        return false;
      }
      if (parsed.protocol !== "https:") return false;
      await shell.openExternal(parsed.href);
      return true;
    }
    if (cmd === "quit") {
      stopInput();
      app.quit();
      return true;
    }
    if (cmd === "injectInput") {
      const t = String((data as { t?: string })?.t || "");
      if (t === "begin" || t === "end" || t === "down" || t === "key") sessionLog("inject", { t });
      injectInput((data ?? {}) as Record<string, unknown>);
      return true;
    }
    if (cmd === "sessionLog") {
      const body = (data ?? {}) as { event?: string } & Record<string, unknown>;
      sessionLog(String(body.event || "note"), body);
      return true;
    }
    if (cmd === "storeFile") {
      const body = data as { name?: string; bytes?: Uint8Array };
      const dir = hub.db.filesDir();
      fs.mkdirSync(dir, { recursive: true });
      const safe = String(body.name || "file").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").slice(0, 80);
      const target = path.join(dir, `${Date.now()}-${safe}`);
      fs.writeFileSync(target, asIpcBuffer(body.bytes));
      return target;
    }
    if (cmd === "readSlice") {
      const body = data as { path?: string; offset?: number; length?: number };
      const target = String(body.path ?? "");
      if (!target || !fs.existsSync(target)) return { bytes: new Uint8Array(), eof: true };
      const fd = fs.openSync(target, "r");
      const length = Math.min(Number(body.length ?? 65536), 262144);
      const buf = Buffer.alloc(length);
      const read = fs.readSync(fd, buf, 0, length, Number(body.offset ?? 0));
      fs.closeSync(fd);
      return { bytes: buf.subarray(0, read), eof: read < length };
    }
    return hub.handle(cmd, data);
  });
}

function appIcon() {
  const candidates = [
    path.join(process.resourcesPath, "icon.png"),
    path.join(app.getAppPath(), "public", "icon.png"),
    path.join(__dirname, "../../public/icon.png"),
  ];
  for (const file of candidates) {
    if (!file || !fs.existsSync(file)) continue;
    const image = nativeImage.createFromPath(file);
    if (!image.isEmpty()) return image;
  }
  return undefined;
}

function asIpcBuffer(bytes: unknown): Buffer {
  if (Buffer.isBuffer(bytes)) return bytes;
  if (bytes instanceof Uint8Array) return Buffer.from(bytes);
  if (Array.isArray(bytes)) return Buffer.from(bytes);
  if (bytes && typeof bytes === "object" && ArrayBuffer.isView(bytes as ArrayBufferView)) return Buffer.from(bytes as Uint8Array);
  return Buffer.alloc(0);
}

let quitting = false;
app.whenReady().then(() => void createWindow());
app.on("window-all-closed", () => app.quit());
app.on("before-quit", (event) => {
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (!hub || quitting) return;
  event.preventDefault();
  quitting = true;
  stopInput();
  void hub.shutdown().finally(() => app.quit());
});
