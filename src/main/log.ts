import { writeLog } from "./logger";

// Единая область main упрощает фильтрацию сообщений процесса приложения.
export function logDebug(msg: string, data?: unknown) {
  writeLog("DEBUG", "main", msg, data);
}

export function logInfo(msg: string, data?: unknown) {
  writeLog("INFO", "main", msg, data);
}

export function logWarn(msg: string, data?: unknown) {
  writeLog("WARN", "main", msg, data);
}

export function logError(msg: string, data?: unknown) {
  writeLog("ERROR", "main", msg, data);
}

