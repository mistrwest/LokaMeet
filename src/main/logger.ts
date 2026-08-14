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

const LEVEL_LABEL: Record<LogLevel, string> = {
  DEBUG: "ОТЛАДКА",
  INFO: "ИНФО",
  WARN: "ВНИМАНИЕ",
  ERROR: "ОШИБКА"
};

const SCOPE_LABEL: Record<string, string> = {
  main: "приложение",
  renderer: "интерфейс",
  "renderer/media": "камера и звук",
  "renderer/screen": "демонстрация экрана",
  "renderer/envelope": "сообщение сети",
  "renderer/call": "звонок",
  "renderer/webrtc": "видеосвязь",
  "renderer/manual": "ручное подключение",
  "renderer/error-boundary": "ошибка интерфейса"
};

const MESSAGE_LABEL: Record<string, string> = {
  "App starting": "Запуск LokaMeet",
  "State loaded": "Настройки и история загружены",
  "Services started": "Службы запущены",
  "App ready": "Приложение готово к работе",
  "Renderer started": "Окно программы открыто",
  "Discovery started": "Поиск участников в сети включён",
  "Discovery stopped": "Поиск участников в сети выключен",
  "Discovery republishPeer": "Обновление своего объявления в сети",
  "Discovery skip publish: not authenticated": "Объявление в сети пропущено: имя ещё не подтверждено",
  "Discovery unpublishPeer": "Своё объявление в сети снято",
  "Discovery publishPeer": "Пользователь опубликован в локальной сети",
  "Discovery publishRoom": "Конференция опубликована в локальной сети",
  "UDP discovery listening": "UDP-поиск слушает порт",
  "UDP discovery socket error": "Ошибка сокета UDP-поиска",
  "Signaling server listening": "Сервер соединения слушает порт",
  "Signaling stop error:": "Ошибка при остановке сервера соединения",
  "connectToPeer: dialing": "Подключение к участнику",
  "connectToPeer: timeout": "Не удалось дождаться ответа участника",
  "connectToPeer: hello received": "Участник ответил на подключение",
  "connectToPeer: socket error": "Ошибка соединения с участником",
  "sendToPeer failed": "Не удалось отправить данные участнику",
  "WS error": "Ошибка сетевого канала",
  "Peer service parse error:": "Не удалось разобрать объявление пользователя",
  "Room service parse error:": "Не удалось разобрать объявление конференции",
  "Failed to load state, using defaults:": "Не удалось прочитать сохранённые настройки, взяты значения по умолчанию",
  "Failed to save state:": "Не удалось сохранить настройки",
  "Screen share handler error": "Ошибка обработчика демонстрации экрана",
  uncaughtException: "Необработанная ошибка программы",
  unhandledRejection: "Необработанный сбой промиса",
  "Stale media deviceId, retrying defaults": "Сохранённое устройство недоступно, повтор с устройством по умолчанию",
  "Failed to get video+audio, retrying with audio only": "Не удалось включить камеру и микрофон вместе, повтор только с микрофоном",
  "No local A/V devices; continuing with empty stream": "Камера и микрофон не найдены, сеанс продолжается без них",
  "No local media device; continuing with empty stream": "Устройство захвата не найдено, сеанс продолжается без него",
  "Failed to get video track, disabling video": "Не удалось получить видео с камеры, видео отключено",
  "Failed to reacquire camera after screen share": "Не удалось снова включить камеру после демонстрации экрана",
  "Screen share stopped": "Демонстрация экрана остановлена",
  "User cancelled screen share selection": "Пользователь отменил выбор экрана",
  "User cancelled or denied screen share": "Пользователь отменил или запретил демонстрацию экрана",
  "getDisplayMedia not supported": "Демонстрация экрана не поддерживается в этой среде",
  "No video track in display media": "В выбранном источнике экрана нет видео",
  "Failed to start screen share": "Не удалось начать демонстрацию экрана",
  "Failed to get screen sources, using getDisplayMedia": "Список окон недоступен, открывается системный выбор экрана",
  "Creating peer connection": "Создаётся соединение с участником",
  startDirectCall: "Исходящий звонок",
  connect: "Подключение по адресу",
  "connect failed": "Не удалось подключиться по адресу",
  "React component error": "Сбой компонента интерфейса",
  "Peer renegotiation deferred (signaling glare)": "Пересогласование соединения отложено: одновременно пришёл встречный запрос",
  "Peer renegotiation failed": "Не удалось пересогласовать соединение",
  "Media ensure failed before offer": "Не удалось подготовить камеру/микрофон перед звонком",
  "Failed to ensure audio track in room": "Не удалось включить микрофон в конференции",
  "Failed to ensure video track in room": "Не удалось включить камеру в конференции",
  "Failed to ensure local media in room": "Не удалось подготовить камеру и микрофон в конференции",
  "Failed to ensure audio track for new peer": "Не удалось включить микрофон для нового участника",
  "Failed to ensure video track for new peer": "Не удалось включить камеру для нового участника",
  "Failed to ensure local media for new peer": "Не удалось подготовить медиа для нового участника",
  "Closing existing connection before room offer": "Закрывается прежнее соединение перед входом в конференцию",
  "Error closing existing connection": "Ошибка при закрытии прежнего соединения",
  "rtc-answer received but no peer connection": "Получен ответ на звонок, но соединение уже закрыто",
  "Processing rtc-answer": "Обработка ответа на звонок",
  "rtc-answer processed": "Ответ на звонок принят",
  "Failed to ensure audio track before peer connection": "Не удалось включить микрофон перед соединением",
  "Failed to ensure video track before peer connection": "Не удалось включить камеру перед соединением",
  "Local stream is null after ensuring tracks": "Локальный поток пуст после подготовки камеры и микрофона",
  "Added track before createOffer": "Дорожка добавлена перед отправкой предложения связи",
  "Failed to add track before createOffer": "Не удалось добавить дорожку перед отправкой предложения связи",
  "Tracks before createOffer": "Состав дорожек перед отправкой предложения связи",
  "Recording begin": "Начало записи звонка",
  "Recording started": "Запись запущена",
  "Recording stopped": "Запись остановлена",
  "Recording saved": "Запись сохранена",
  "Recording muxed": "Контейнер записи собран",
  "Recording mux failed": "Не удалось собрать контейнер записи",
  "WebCodecs H264 not supported, using WebM fallback": "H.264 недоступен, запись идёт через WebM",
  "WebCodecs produced no samples, switching to WebM": "Кодировщик не дал кадры, переключение на WebM",
  "VideoEncoder configure failed": "Не удалось настроить кодировщик видео",
  "VideoEncoder error": "Ошибка кодировщика видео",
  "AudioEncoder error": "Ошибка кодировщика звука",
  "AudioEncoder unavailable": "Кодировщик звука недоступен",
  "MediaRecorder error": "Ошибка MediaRecorder",
  "Recording chunk write failed": "Не удалось записать фрагмент записи",
  "VideoFrame encode failed": "Не удалось закодировать кадр записи",
  "ICE connection state": "Состояние ICE-соединения",
  "Peer connection state": "Состояние peer-соединения",
  leaveCall: "Выход из звонка"
};

const FIELD_LABEL: Record<string, string> = {
  version: "версия",
  profile: "профиль",
  port: "порт",
  signalingPort: "порт соединения",
  userName: "имя",
  chatsCount: "сообщений в истории",
  peerId: "id пользователя",
  host: "адрес",
  error: "ошибка",
  url: "адрес",
  name: "имя",
  roomId: "id конференции",
  roomName: "конференция",
  fromPeerId: "от",
  toPeerId: "кому",
  remotePeerId: "собеседник",
  remoteUserName: "имя собеседника",
  initiator: "инициатор",
  message: "сообщение",
  stack: "стек",
  reason: "причина",
  errorName: "тип ошибки",
  errorMsg: "ошибка",
  audioInputDeviceId: "микрофон",
  videoInputDeviceId: "камера",
  trackId: "id дорожки",
  kind: "тип дорожки",
  signalingState: "состояние соединения",
  existingCallMode: "текущий режим",
  sendersBefore: "исходящих дорожек до",
  receiversBefore: "входящих дорожек до",
  sendersAfter: "исходящих дорожек после",
  receiversAfter: "входящих дорожек после",
  tracksBefore: "дорожек до",
  tracksAfter: "дорожек после",
  micEnabled: "микрофон включён",
  type: "тип",
  filePath: "файл",
  dir: "папка",
  format: "формат",
  quality: "качество",
  fps: "кадры/с",
  bitrate: "битрейт",
  width: "ширина",
  height: "высота",
  sources: "источников",
  audioStreams: "аудиопотоков",
  sourceLabels: "источники",
  encoder: "кодировщик",
  mime: "тип контейнера",
  bytes: "байт",
  bytesWritten: "записано байт",
  videoSamples: "видеокадров",
  audioSamples: "аудиокадров",
  jpegCount: "jpeg-кадров",
  wrote: "данные записаны",
  mode: "режим записи",
  iceConnectionState: "ICE",
  connectionState: "соединение",
  chunks: "фрагментов",
  jpeg: "кадров jpeg",
  pcm: "блоков pcm",
  usecPerFrame: "мкс/кадр",
  audioBytes: "байт звука",
  hadVideo: "было видео"
};

const ENVELOPE_TYPE_LABEL: Record<string, string> = {
  hello: "приветствие",
  "direct-call-request": "входящий звонок",
  "direct-call-accept": "звонок принят",
  "direct-call-reject": "звонок отклонён",
  "room-join": "вход в конференцию",
  "room-welcome": "добро пожаловать в конференцию",
  "room-peer-joined": "участник вошёл в конференцию",
  "room-peer-left": "участник вышел из конференции",
  "room-leave": "выход из конференции",
  "room-invite": "приглашение в конференцию",
  "room-invite-reject": "приглашение отклонено",
  "chat-message": "сообщение чата",
  "rtc-signal": "сигнал видеосвязи",
  "rtc-offer": "предложение связи",
  "rtc-answer": "ответ на предложение связи",
  "rtc-ice": "ICE-кандидат",
  "screen-share-start": "начало демонстрации экрана",
  "screen-share-stop": "остановка демонстрации экрана",
  "recording-start": "начало записи",
  "recording-stop": "остановка записи",
  "avatar-request": "запрос аватара",
  "avatar-data": "данные аватара"
};

function nowIso() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  const ms = String(now.getMilliseconds()).padStart(3, "0");
  return `${day}.${month}.${year} ${hours}:${minutes}:${seconds}.${ms}`;
}

function scopeLabel(scope: string): string {
  return SCOPE_LABEL[scope] ?? scope.replace(/^renderer\//, "").replace(/[/_-]+/g, " ");
}

function messageLabel(msg: string): string {
  if (MESSAGE_LABEL[msg]) return MESSAGE_LABEL[msg];
  if (ENVELOPE_TYPE_LABEL[msg]) return `Событие сети: ${ENVELOPE_TYPE_LABEL[msg]}`;
  return msg;
}

function fieldLabel(key: string): string {
  return FIELD_LABEL[key] ?? key;
}

function shorten(text: string, max = 800): string {
  const compact = text.replace(/\s+/g, " ").trim();
  if (compact.length <= max) return compact;
  return `${compact.slice(0, max - 1)}…`;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function formatValue(value: unknown, depth = 0): string {
  if (value === undefined) return "нет";
  if (value === null) return "пусто";
  if (typeof value === "boolean") return value ? "да" : "нет";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return shorten(value, depth === 0 ? 800 : 400);
  if (value instanceof Error) return shorten(value.stack || value.message || String(value), 1200);
  if (Array.isArray(value)) {
    if (value.length === 0) return "пусто";
    if (value.every((item) => ["string", "number", "boolean"].includes(typeof item))) {
      return value.map((item) => String(item)).join(", ");
    }
    if (value.length <= 12 && depth < 2) {
      return value.map((item) => formatValue(item, depth + 1)).join(" | ");
    }
    return `${value.length} шт.`;
  }
  if (isPlainObject(value)) {
    const keys = Object.keys(value);
    if (keys.length === 0) return "пусто";
    if (typeof value.type === "string" && ENVELOPE_TYPE_LABEL[value.type] && depth > 0) {
      return ENVELOPE_TYPE_LABEL[value.type];
    }
    if (depth >= 2) return keys.join(", ");
    return keys
      .filter((key) => !["sdp", "candidate", "dataUrl", "previewDataUrl", "avatar"].includes(key))
      .slice(0, 16)
      .map((key) => `${fieldLabel(key)}=${formatValue(value[key], depth + 1)}`)
      .join("; ");
  }
  try {
    return shorten(JSON.stringify(value), 400);
  } catch {
    return String(value);
  }
}

function formatDataLines(data: unknown): string[] {
  if (data === undefined) return [];
  if (data instanceof Error) {
    return [`  ошибка: ${shorten(data.message || String(data), 300)}`];
  }
  if (!isPlainObject(data)) {
    return [`  детали: ${formatValue(data)}`];
  }

  const skip = new Set(["sdp", "candidate", "dataUrl", "previewDataUrl", "avatar", "signal"]);
  const lines: string[] = [];
  if (typeof data.type === "string") {
    lines.push(`  тип: ${ENVELOPE_TYPE_LABEL[data.type] ?? data.type}`);
  }
  if (isPlainObject(data.signal) && typeof data.signal.type === "string") {
    lines.push(`  сигнал: ${ENVELOPE_TYPE_LABEL[data.signal.type] ?? data.signal.type}`);
    if (typeof data.signal.fromPeerId === "string") lines.push(`  от: ${data.signal.fromPeerId}`);
    if (typeof data.signal.toPeerId === "string") lines.push(`  кому: ${data.signal.toPeerId}`);
    if (typeof data.signal.roomId === "string") lines.push(`  конференция: ${data.signal.roomId}`);
  }
  if (isPlainObject(data.message)) {
    const text = typeof data.message.text === "string" ? data.message.text : "";
    const from = typeof data.message.fromUserName === "string" ? data.message.fromUserName : "";
    lines.push(`  сообщение: ${from ? `${from} — ` : ""}${shorten(text || "(без текста)", 160)}`);
  }

  for (const [key, value] of Object.entries(data)) {
    if (skip.has(key) || key === "type" || key === "signal" || key === "message") continue;
    if (value === undefined) continue;
    lines.push(`  ${fieldLabel(key)}: ${formatValue(value)}`);
  }
  return lines;
}

function format(line: LogLine): string {
  const header = `${line.ts}  ${LEVEL_LABEL[line.level]}  [${scopeLabel(line.scope)}]`;
  const body = messageLabel(line.msg);
  const details = formatDataLines(line.data);
  return [header, `  ${body}`, ...details].join("\n");
}

function ensureDir(p: string) {
  fs.mkdirSync(p, { recursive: true });
}

function canWriteDir(dir: string): boolean {
  try {
    ensureDir(dir);
    fs.accessSync(dir, fs.constants.W_OK);
    const probe = path.join(dir, `.lokameet-write-${process.pid}`);
    fs.writeFileSync(probe, "ok", "utf-8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function resolveAppRootDir(): string {
  // Portable-сборка electron-builder кладёт путь к папке запускаемого exe в эту переменную.
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR?.trim();
  if (portableDir) return portableDir;
  if (app.isPackaged) {
    // Установленная и распакованная сборка: журнал рядом с LokaMeet.exe.
    return path.dirname(process.execPath);
  }
  // Разработка: журнал в папке проекта, откуда запущена программа.
  return process.cwd();
}

export function initLogger() {
  if (logFilePath) return;

  const appRoot = resolveAppRootDir();
  const preferred = path.join(appRoot, "logs");
  const fallback = path.join(app.getPath("userData"), "logs");
  const logsDir = canWriteDir(preferred) ? preferred : (canWriteDir(fallback) ? fallback : preferred);
  ensureDir(logsDir);

  const suffix = (process.env.LOKAMEET_PROFILE ?? "").trim() || "default";
  const stamp = new Date();
  const y = stamp.getFullYear();
  const m = String(stamp.getMonth() + 1).padStart(2, "0");
  const d = String(stamp.getDate()).padStart(2, "0");
  const hh = String(stamp.getHours()).padStart(2, "0");
  const mm = String(stamp.getMinutes()).padStart(2, "0");
  const ss = String(stamp.getSeconds()).padStart(2, "0");
  const fileName = `LokaMeet-${y}${m}${d}-${hh}${mm}${ss}-${suffix}.log`;

  logDirPath = logsDir;
  logFilePath = path.join(logsDir, fileName);

  const header = [
    "==== Журнал LokaMeet ====",
    `Время запуска: ${nowIso()}`,
    `Версия: ${app.getVersion()}`,
    `Профиль: ${suffix}`,
    `Папка программы: ${appRoot}`,
    `Установленная сборка: ${app.isPackaged ? "да" : "нет (режим разработки)"}`,
    `Портативная сборка: ${process.env.PORTABLE_EXECUTABLE_DIR ? "да" : "нет"}`,
    `Файл журнала: ${logFilePath}`,
    logsDir === fallback ? `Замечание: папка рядом с программой недоступна для записи, журнал сохранён в ${logsDir}` : null,
    "==========================",
    ""
  ]
    .filter((line) => line !== null)
    .join("\n");
  fs.appendFileSync(logFilePath, header + "\n", "utf-8");

  if (buffer.length) {
    for (const line of buffer) fs.appendFileSync(logFilePath, format(line) + "\n\n", "utf-8");
    buffer = [];
  }

  pruneOldLogFiles(logsDir, 5);
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
  const text = format(line);
  if (!logFilePath) {
    buffer.push(line);
    // eslint-disable-next-line no-console
    console.log("[LokaMeet]\n" + text);
    return;
  }
  fs.appendFileSync(logFilePath, text + "\n\n", "utf-8");
  // eslint-disable-next-line no-console
  console.log("[LokaMeet]\n" + text);
}
