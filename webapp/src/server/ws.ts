// WebSocket server on /ws: only logged-in users (Bearer or session cookie; a cookie upgrade must come from our
// own pages, so no foreign page can open a socket with the user's cookie), ping/pong heartbeat, broadcast.
// Pi events per handle with replay after a reconnect follow in task B10.
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { userForRequest } from "./helpers.js";
import type { Store, UserRecord } from "./store.js";

/** Heartbeat: ping every 30 s, terminate connections that missed a pong */
const HEARTBEAT_MS = 30_000;

export interface SocketHub {
  wss: WebSocketServer;
  /** Send a message to every connected client (optionally only to users the filter accepts) */
  broadcast(message: unknown, filter?: (user: UserRecord) => boolean): void;
  close(): Promise<void>;
}

export function createSocketHub(server: Server, store: Store): SocketHub {
  const users = new WeakMap<WebSocket, UserRecord>();
  const pending = new WeakMap<IncomingMessage, UserRecord>();
  const wss = new WebSocketServer({
    server,
    path: "/ws",
    verifyClient: (info: { req: IncomingMessage }) => {
      const auth = userForRequest(store, info.req, false);
      if (!auth) return false;
      pending.set(info.req, auth.user);
      return true;
    },
  });
  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws, req) => {
    const user = pending.get(req);
    if (user) users.set(ws, user);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {
      /* socket errors must not crash the server */
    });
    ws.on("message", (raw) => {
      // client messages (subscribe, …) arrive with task B10 — parse safely and ignore unknown types
      try {
        JSON.parse(String(raw));
      } catch {
        /* not JSON: ignore */
      }
    });
  });
  const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
      if (alive.get(ws) === false) {
        ws.terminate();
        return;
      }
      alive.set(ws, false);
      ws.ping();
    });
  }, HEARTBEAT_MS);
  heartbeat.unref();

  return {
    wss,
    broadcast(message, filter) {
      const text = JSON.stringify(message);
      wss.clients.forEach((ws) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const user = users.get(ws);
        // a deleted user or a revoked token must not receive anything any more
        if (!user || !store.users.has(user.id)) return;
        if (filter && !filter(user)) return;
        ws.send(text);
      });
    },
    close() {
      clearInterval(heartbeat);
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => wss.close(() => r()));
    },
  };
}
