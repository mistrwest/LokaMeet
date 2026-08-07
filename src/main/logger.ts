import fs from "node:fs";
import path from "node:path";
import { app } from "electron";

type LogLevel = "DEBUG" | "INFO" | "WARN" | "ERROR";

type LogLine = {
  ts: string;
  level: LogLevel;
  pid: number;
  scope: string;
  msg: string;
  data?: unknown;
};

let logFilePath: string | null = null;
let logDirPath: string | null = null;
let buffer: LogLine[] = [];

function nowIso() {
  // Локальное время упрощает сопоставление записей с событиями на компьютере пользователя.
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}.${ms}`;
}

function safeJson(x: unknown) {
  try {
    return JSON.stringify(x);
  } catch {
    return "\"<unserializable>\"";
  }
}

function format(line: LogLine) {
  const base = `${line.ts} ${line.level} pid=${line.pid} [${line.scope}] ${line.msg}`;
  if (line.data === undefined) return base;
  return `${base} data=${safeJson(line.data)}`;
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

export function initLogger() {
  if (logFilePath) return;
  // Для portable-сборки журнал хранится рядом с приложением, чтобы его можно было забрать вместе с ней.
  // В разработке журнал остаётся в рабочей области, где его проще найти.
  // Недоступная для записи директория заменяется userData, чтобы логирование не ломало запуск.
  const appPath = app.getAppPath();
  const isPackaged = app.isPackaged;
  const isPortable = appPath.includes("release") || appPath.includes("win-unpacked") || (!isPackaged && process.cwd().includes("release"));
  
  // Для portable-сборки журналы привязываются к каталогу исполняемого файла.
  let releaseLogsDir: string | null = null;
  if (isPortable || (isPackaged && process.platform === "win32")) {
    try {
      // process.execPath указывает фактическое место запуска, а не каталог исходников.
      const exePath = process.execPath;
      const exeDir = path.dirname(exePath);
      // Для win-unpacked журналы кладутся уровнем выше, рядом с артефактами релиза.
      if (exeDir.includes("win-unpacked")) {
        releaseLogsDir = path.resolve(exeDir, "..", "logs");
      } else if (exeDir.includes("release")) {
        releaseLogsDir = path.resolve(exeDir, "logs");
      } else {
        // Для остальных portable-вариантов журнал остаётся рядом с исполняемым файлом.
        releaseLogsDir = path.resolve(exeDir, "logs");
      }
    } catch {
      // Ошибка определения portable-пути не должна отменять переход к резервным каталогам.
    }
  }
  
  const preferred = path.resolve(appPath, "logs");
  const fallback = path.join(app.getPath("userData"), "logs");
  
  let logsDir = fallback;
  // Portable-путь проверяется первым, чтобы журнал не оказался в профиле пользователя без необходимости.
  if (releaseLogsDir) {
    try {
      ensureDir(releaseLogsDir);
      fs.accessSync(releaseLogsDir, fs.constants.W_OK);
      logsDir = releaseLogsDir;
    } catch {
      // При недоступности portable-каталога проверяется каталог приложения.
    }
  }
  // Каталог приложения используется, только если portable-каталог не подошёл.
  if (logsDir === fallback) {
    try {
      ensureDir(preferred);
      fs.accessSync(preferred, fs.constants.W_OK);
      logsDir = preferred;
    } catch {
      // userData гарантирует каталог, доступный приложению в установленной версии.
      ensureDir(fallback);
    }
  }
  ensureDir(logsDir);

  const suffix = (process.env.LOKAMEET_PROFILE ?? "").trim() || "default";
  const stamp = new Date();
  const y = stamp.getFullYear();
  const m = String(stamp.getMonth() + 1).padStart(2, "0");
  const d = String(stamp.getDate()).padStart(2, "0");
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  const ss = String(stamp.getSeconds()).padStart(2, "0");
  const fileName = `LokaMeet-${y}${m}${d}-${hh}${mm}${ss}-${suffix}-pid${process.pid}.log`;

  logDirPath = logsDir;
  logFilePath = path.join(logsDir, fileName);

  // Заголовок фиксирует контекст, необходимый для разбора журнала отдельного запуска.
  const header = [
    "---- LokaMeet log session start ----",
    `ts=${nowIso()}`,
    `profile=${suffix}`,
    `version=${app.getVersion()}`,
    `appPath=${appPath}`,
    `userData=${app.getPath("userData")}`,
    `logFile=${logFilePath}`,
    "----------------------------------"
  ].join("\n");
  fs.appendFileSync(logFilePath, header + "\n", "utf-8");

  // Сообщения раннего запуска не теряются до определения пути журнала.
  if (buffer.length) {
    for (const line of buffer) fs.appendFileSync(logFilePath, format(line) + "\n", "utf-8");
    buffer = [];
  }

  pruneOldLogFiles(logsDir, 4);
}

/** Оставляет только последние `keep` лог-файлов LokaMeet (по mtime). */
function pruneOldLogFiles(logsDir: string, keep: number) {
  try {
    const entries = fs
      .readdirSync(logsDir)
      .filter((name) => /^LokaMeet-.*\.log$/i.test(name))
      .map((name) => {
        const fullPath = path.join(logsDir, name);
        let mtimeMs = 0;
        try {
          mtimeMs = fs.statSync(fullPath).mtimeMs;
        } catch {
          mtimeMs = 0;
        }
        return { fullPath, mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (const entry of entries.slice(Math.max(0, keep))) {
      try {
        fs.unlinkSync(entry.fullPath);
      } catch {
        // Занятый или уже удалённый файл не должен прерывать очистку старых журналов.
      }
    }
  } catch {
    // Сбой очистки не должен мешать основному журналированию.
  }
}

export function getLogInfo() {
  return { logFilePath, logDirPath };
}

export function writeLog(level: LogLevel, scope: string, msg: string, data?: unknown) {
  const line: LogLine = { ts: nowIso(), level, pid: process.pid, scope, msg, data };
  if (!logFilePath) {
    buffer.push(line);
    // До инициализации файла вывод в консоль сохраняет диагностические сообщения доступными.
    // eslint-disable-next-line no-console
    console.log("[LokaMeet]", format(line));
    return;
  }
  fs.appendFileSync(logFilePath, format(line) + "\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log("[LokaMeet]", format(line));
}

