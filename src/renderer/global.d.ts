export {};

declare global {
  interface Window {
    loka: {
      invoke: (cmd: string, data?: unknown) => Promise<any>;
      on: (callback: (event: any) => void) => () => void;
    };
  }
}
