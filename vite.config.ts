/// <reference types="vitest" />
import { defineConfig } from "vite";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  clearScreen: false,
  // The webapp has its own package and node:test suite (cd webapp && npm test) — keep it out of the root vitest run.
  test: {
    exclude: ["**/node_modules/**", "**/dist/**", "webapp/**"],
  },
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ["**/src-tauri/**"] },
  },
  build: {
    target: "es2021",
    outDir: "dist",
    rollupOptions: {
      input: {
        main: "index.html",
        quick: "quick.html",
      },
    },
  },
});
