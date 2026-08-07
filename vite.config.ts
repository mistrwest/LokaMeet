import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  root: path.resolve(__dirname),
  base: "./",
  plugins: [react()],
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

