import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

function copyMediapipeWasm() {
  const src = path.resolve(__dirname, "node_modules/@mediapipe/tasks-vision/wasm");
  const dst = path.resolve(__dirname, "public/mediapipe/wasm");
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dst, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    fs.copyFileSync(path.join(src, name), path.join(dst, name));
  }
}

export default defineConfig({
  root: path.resolve(__dirname),
  base: "./",
  plugins: [
    react(),
    {
      name: "copy-mediapipe-wasm",
      buildStart() {
        copyMediapipeWasm();
      }
    }
  ],
  optimizeDeps: {
    include: ["@mediapipe/tasks-vision"]
  },
  build: {
    outDir: "dist/renderer",
    // Очищаем outDir, чтобы старые hashed-бандлы не копились между сборками
    emptyOutDir: true
  },
  server: {
    port: 5173,
    strictPort: true
  }
});

