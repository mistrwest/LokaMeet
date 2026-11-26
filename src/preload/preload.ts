import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("loka", {
  invoke: (cmd: string, data?: unknown) => ipcRenderer.invoke("loka", cmd, data),
  on: (callback: (event: unknown) => void) => {
    const listener = (_event: unknown, payload: unknown) => callback(payload);
    ipcRenderer.on("loka-event", listener);
    return () => ipcRenderer.removeListener("loka-event", listener);
  },
});
