import { app } from "electron";
import fs from "fs";
import os from "os";
import path from "path";
import { APP_NAME, APP_VERSION } from "../shared/version";

let file = "";
let hooked = false;
const rawLog = console.log.bind(console);
const rawWarn = console.warn.bind(console);
const rawError = console.error.bind(console);

export type LogLevel = "info" | "warn" | "error";

export function programRoot(): string {
  const fromMain = path.resolve(__dirname, "../..");
  if (fs.existsSync(path.join(fromMain, "package.json"))) return fromMain;
  const cwd = process.cwd();
  if (fs.existsSync(path.join(cwd, "package.json"))) return cwd;
  if (app.isPackaged) return path.dirname(process.execPath);
  return fromMain;
}

export function logsDir(): string {
  return path.join(programRoot(), "logs");
}

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}

function stampName(when = new Date()): string {
  return `${when.getFullYear()}${pad(when.getMonth() + 1)}${pad(when.getDate())}-${pad(when.getHours())}${pad(when.getMinutes())}${pad(when.getSeconds())}`;
}

function stampLine(when = new Date()): string {
  return `${pad(when.getDate())}.${pad(when.getMonth() + 1)}.${when.getFullYear()} ${pad(when.getHours())}:${pad(when.getMinutes())}:${pad(when.getSeconds())}.${pad(when.getMilliseconds(), 3)}`;
}

function profileName(): string {
  return process.env.LOKAMEET_PROFILE || "default";
}

function levelWord(level: LogLevel): string {
  if (level === "error") return "ERROR";
  if (level === "warn") return "WARN";
  return "INFO";
}

const labels: Record<string, string> = {
  peerId: "peer",
  target: "peer",
  name: "name",
  grant: "grant",
  hasScreen: "screen already up",
  w: "width",
  h: "height",
  count: "screens",
  id: "id",
  ok: "ok",
  shareOn: "sharing",
  live: "track",
  mode: "mode",
  phase: "phase",
  self: "self",
  kind: "kind",
  streamId: "stream",
  shareVideo: "is screen",
  expect: "expect screen",
  controlling: "controlling",
  videos: "video tracks",
  cam: "camera",
  pick: "picked",
  pin: "pinned",
  ready: "ready",
  t: "action",
  error: "error",
  file: "file",
  dir: "dir",
  roomId: "room",
  hostId: "host",
  roomName: "room name",
  title: "title",
  direction: "direction",
  duration: "duration ms",
  video: "had video",
  ts: "time",
  accept: "accepted",
  muted: "muted",
  state: "state",
  signal: "signaling",
  receivers: "receivers",
};

function formatValue(value: unknown): string {
  if (value === true) return "yes";
  if (value === false) return "no";
  if (value === null || value === undefined) return "";
  if (typeof value === "number") return String(value);
  return String(value);
}

function skipKey(key: string): boolean {
  return key === "event" || key === "level" || key === "text" || key === "area";
}

export function appLog(level: LogLevel, area: string, title: string, details: Record<string, unknown> = {}): void {
  const lines = [`${stampLine()}  ${levelWord(level)}  [${area}]`, `  ${title}`];
  for (const [key, value] of Object.entries(details)) {
    if (skipKey(key) || value === undefined || value === "") continue;
    const label = labels[key] || key;
    lines.push(`  ${label}: ${formatValue(value)}`);
  }
  const block = `${lines.join("\n")}\n\n`;
  if (file) {
    try {
      fs.appendFileSync(file, block);
    } catch {
      /* disk */
    }
  }
  if (level === "error") rawError(title, details);
  else if (level === "warn") rawWarn(title, details);
  else rawLog(title);
}

const events: Record<string, { level: LogLevel; area: string; title: string | ((data: Record<string, unknown>) => string) }> = {
  boot: { level: "info", area: "app", title: "LokaMeet started" },
  "call-in": { level: "info", area: "call", title: "Incoming call" },
  "call-out": { level: "info", area: "call", title: "Outgoing call" },
  "call-accept": { level: "info", area: "call", title: "Call accepted" },
  "call-answered": { level: "info", area: "call", title: "Peer accepted the call" },
  "call-log": { level: "info", area: "call", title: "Call saved to history" },
  "control-ask": { level: "info", area: "control", title: "Desktop control requested" },
  "control-granted": { level: "info", area: "control", title: "Peer granted desktop control" },
  "control-denied": { level: "warn", area: "control", title: "Desktop control denied" },
  "control-stop": { level: "info", area: "control", title: "Desktop control stopped" },
  "control-answer": { level: "info", area: "control", title: (data) => (data.accept ? "We granted control of this desktop" : "We denied desktop control") },
  "control-sources": { level: "info", area: "screen", title: "Displays found for sharing" },
  "control-share": { level: "info", area: "screen", title: "Screen share started for control" },
  "desk-offer": { level: "info", area: "control", title: "Desktop link offer sent" },
  "desk-answer": { level: "info", area: "control", title: "Desktop link answer sent" },
  "desk-stable": { level: "info", area: "control", title: "Desktop link connected" },
  "desk-fail": { level: "error", area: "control", title: "Desktop link failed" },
  "share-start": { level: "info", area: "screen", title: "Screen share started" },
  "share-none": { level: "error", area: "screen", title: "No display to share" },
  "share-retry": { level: "warn", area: "screen", title: "Retrying screen share" },
  "screen-on": { level: "info", area: "screen", title: "Peer started sharing a screen" },
  "screen-off": { level: "info", area: "screen", title: "Screen share stopped" },
  "screen-harvest": { level: "info", area: "screen", title: "Looking for the remote desktop video" },
  "screen-tile": { level: "info", area: "screen", title: "Remote desktop is on stage" },
  ontrack: { level: "info", area: "call", title: (data) => (data.kind === "video" ? "Remote video track" : "Remote audio track") },
  "pulse-ok": { level: "info", area: "screen", title: "Screen track published again" },
  "pulse-fail": { level: "error", area: "screen", title: "Failed to publish the screen" },
  "pulse-skip": { level: "warn", area: "screen", title: "No live screen track to publish" },
  "screen-timeout": { level: "error", area: "screen", title: "Remote desktop video never arrived" },
  "offer-wait": { level: "warn", area: "call", title: "Waiting for a stable connection before updating video" },
  "offer-hold": { level: "info", area: "call", title: "Offer queued until the peer answers" },
  "offer-sent": { level: "info", area: "call", title: "Connection offer sent" },
  "offer-ignore": { level: "warn", area: "call", title: "Incoming offer ignored: local offer is still unanswered" },
  "answer-sent": { level: "info", area: "call", title: "Connection answer sent" },
  "answer-ok": { level: "info", area: "call", title: "Peer answer applied, connection stable" },
  "answer-skip": { level: "warn", area: "call", title: "Peer answer skipped: not waiting for an offer" },
  "answer-fail": { level: "error", area: "call", title: "Failed to apply the connection answer" },
  "offer-fail": { level: "error", area: "call", title: "Failed to update the connection" },
  inject: { level: "info", area: "control", title: (data) => {
    if (data.t === "begin") return "Mouse and keyboard injection armed";
    if (data.t === "end") return "Input injection stopped";
    if (data.t === "down") return "Mouse click injected on this PC";
    if (data.t === "key") return "Key injected on this PC";
    return "Input event";
  } },
  "conf-host": { level: "info", area: "call", title: "Conference created" },
  "conf-join": { level: "info", area: "call", title: "Joined conference" },
  mdns: { level: "error", area: "net", title: "LAN discovery failed" },
  console: { level: "info", area: "console", title: "Console message" },
};

export function sessionLog(event: string, data: Record<string, unknown> = {}): void {
  const mapped = events[event];
  if (!mapped) {
    appLog("info", "app", event, data);
    return;
  }
  const title = typeof mapped.title === "function" ? mapped.title(data) : mapped.title;
  let level = mapped.level;
  if (event === "console") {
    if (data.level === "error") level = "error";
    else if (data.level === "warn") level = "warn";
    appLog(level, "console", String(data.text || title), {});
    return;
  }
  appLog(level, mapped.area, title, data);
}

function copyLog(from: string, toDir: string): void {
  if (!fs.existsSync(from) || !fs.statSync(from).isFile()) return;
  const name = path.basename(from);
  const dest = path.join(toDir, name);
  if (path.resolve(from) === path.resolve(dest)) return;
  try {
    if (!fs.existsSync(dest)) fs.copyFileSync(from, dest);
  } catch {
    /* skip locked files */
  }
}

function collectOldLogDirs(): string[] {
  const roaming = path.join(os.homedir(), "AppData", "Roaming");
  const roots = [path.join(roaming, "LokaMeet"), path.join(roaming, "lokameet")];
  const dirs: string[] = [];
  for (const root of roots) {
    dirs.push(path.join(root, "logs"));
    try {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        const nested = path.join(root, name, "logs");
        if (fs.existsSync(nested)) dirs.push(nested);
      }
    } catch {
      /* skip */
    }
  }
  try {
    dirs.push(path.join(app.getPath("userData"), "logs"));
  } catch {
    /* app not ready */
  }
  return [...new Set(dirs.map((item) => path.resolve(item)))];
}

export function migrateOldLogs(toDir: string): void {
  for (const oldDir of collectOldLogDirs()) {
    if (!fs.existsSync(oldDir) || path.resolve(oldDir) === path.resolve(toDir)) continue;
    let names: string[] = [];
    try {
      names = fs.readdirSync(oldDir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".log")) continue;
      copyLog(path.join(oldDir, name), toDir);
    }
  }
}

function hookConsole(): void {
  if (hooked) return;
  hooked = true;
  console.warn = (...args: unknown[]) => {
    appLog("warn", "console", args.map(String).join(" "));
    rawWarn(...args);
  };
  console.error = (...args: unknown[]) => {
    appLog("error", "console", args.map((item) => (item instanceof Error ? item.stack || item.message : String(item))).join(" "));
    rawError(...args);
  };
}

export function initSessionLog(): string {
  const folder = logsDir();
  fs.mkdirSync(folder, { recursive: true });
  try {
    app.setPath("logs", folder);
  } catch {
    /* too late or unsupported */
  }
  migrateOldLogs(folder);
  const started = new Date();
  const profile = profileName();
  file = path.join(folder, `${APP_NAME}-${stampName(started)}-${profile}.log`);
  const packed = app.isPackaged;
  const portable = packed && !process.execPath.toLowerCase().includes("program files");
  const header = [
    `==== ${APP_NAME} log ====`,
    `Started: ${stampLine(started)}`,
    `Version: ${APP_VERSION}`,
    `Profile: ${profile}`,
    `App folder: ${programRoot()}`,
    `Installed build: ${packed ? "yes" : "no (development)"}`,
    `Portable build: ${portable ? "yes" : "no"}`,
    `Log file: ${file}`,
    "==========================",
    "",
  ].join("\n");
  fs.writeFileSync(file, `${header}\n`);
  hookConsole();
  appLog("info", "app", `${APP_NAME} started`, { version: APP_VERSION, profile });
  return file;
}
