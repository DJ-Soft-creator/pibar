// Vite build of the webapp client (webapp/client → webapp/dist/client). The client reuses the logic of the
// desktop app from src/shared/ (alias @shared). Packages that shared code imports (marked, dompurify,
// highlight.js) resolve from webapp/node_modules – the Docker build only has webapp/ and src/shared/, not the
// root node_modules. Tauri APIs resolve to the webapp bridge (client/src/tauri.ts → bridge.ts: invoke() becomes
// POST /api/cmd/<command>), so src/shared/api.ts runs unchanged.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const modules = here("./node_modules/");

export default defineConfig({
  root: here("./client"),
  publicDir: here("./client/public"),
  resolve: {
    alias: [
      { find: "@shared", replacement: here("../src/shared") },
      { find: /^@tauri-apps\/api\/.*$/, replacement: here("./client/src/tauri.ts") },
      { find: /^(marked|dompurify|highlight\.js)(\/.*)?$/, replacement: `${modules}$1$2` },
    ],
  },
  server: {
    port: 5173,
    // dev: the backend runs separately (npm run dev on :8787)
    proxy: {
      "/api": "http://localhost:8787",
      "/ws": { target: "ws://localhost:8787", ws: true },
    },
    fs: { allow: [here(".."), modules] },
  },
  build: {
    outDir: here("./dist/client"),
    emptyOutDir: true,
    target: "es2021",
  },
});
