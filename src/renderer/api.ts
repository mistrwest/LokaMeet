export const api = {
  invoke<T = any>(cmd: string, data?: unknown): Promise<T> {
    return window.loka.invoke(cmd, data);
  },
  on(callback: (event: any) => void): () => void {
    return window.loka.on(callback);
  },
};
