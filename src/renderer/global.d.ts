import type { LokaMeetApi } from "../preload/preload";

// Объявление связывает API из preload с типом window, чтобы вызовы IPC проверялись TypeScript.
declare global {
  interface Window {
    lokameet: LokaMeetApi;
  }
}

export {};

