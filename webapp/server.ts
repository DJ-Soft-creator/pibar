// PiBar webapp backend entry point. Express + ws on a real http.Server,
// JSON-file persistence under DATA_DIR, static client from src/client.
import { createServer } from "node:http";
import { resolve } from "node:path";
import dotenv from "dotenv";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "./src/server/app.js";
import { bootstrapAdmin } from "./src/server/auth.js";
import { Store } from "./src/server/store.js";

dotenv.config();

const dataDir = resolve(process.env.DATA_DIR ?? "./data");
const clientDir = resolve(process.env.CLIENT_DIR ?? "./src/client");

// Validate PORT: integer 1-65535, otherwise fall back to 8787 with a warning.
const rawPort = process.env.PORT ?? "8787";
const parsedPort = Number(rawPort);
const port = Number.isInteger(parsedPort) && parsedPort >= 1 && parsedPort <= 65535 ? parsedPort : 8787;
if (port !== parsedPort) {
  console.warn(`[pibar-webapp] Invalid PORT "${rawPort}" (expected integer 1-65535), falling back to 8787.`);
}

const store = new Store(dataDir);
await bootstrapAdmin(
  store,
  { ADMIN_USERNAME: process.env.ADMIN_USERNAME, ADMIN_PASSWORD: process.env.ADMIN_PASSWORD },
  (msg) => console.log(msg),
);

let wss: WebSocketServer | null = null;

const app = createApp(store, {
  clientDir,
  onConfigUpdated: (receivedAt) => {
    const message = JSON.stringify({ type: "config/updated", receivedAt });
    wss?.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) client.send(message);
    });
  },
});

const server = createServer(app);
wss = new WebSocketServer({ server, path: "/ws" });

// Heartbeat: ping every 30 s, terminate connections that missed a pong.
const HEARTBEAT_MS = 30_000;
const alive = new WeakMap<WebSocket, boolean>();
wss.on("connection", (ws) => {
  alive.set(ws, true);
  ws.on("pong", () => alive.set(ws, true));
  ws.on("error", () => {
    /* socket errors must not crash the server */
  });
  ws.on("message", (raw) => {
    // Chat messages are a later task — parse safely and ignore unknown types.
    try {
      JSON.parse(String(raw));
    } catch {
      /* not JSON: ignore */
    }
  });
});
const heartbeat = setInterval(() => {
  wss?.clients.forEach((ws) => {
    if (alive.get(ws) === false) {
      ws.terminate();
      return;
    }
    alive.set(ws, false);
    ws.ping();
  });
}, HEARTBEAT_MS);
heartbeat.unref();

server.listen(port, () => {
  console.log(`[pibar-webapp] Listening on http://localhost:${port} (data: ${dataDir})`);
});
