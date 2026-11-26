// WebSocket server on /ws: only logged-in users (Bearer or session cookie; a cookie upgrade must come from our own
// pages, so no foreign page can open a socket with the user's cookie), ping/pong heartbeat, broadcast, and the live
// events of Pi processes:
//
//   client → {"type":"subscribe","handle":3,"since":41}   (since = last seq it saw, 0 = from the start)
//   server → {"type":"pi/subscribed","handle":3,"seq":57,"alive":true,"streaming":false}
//            {"type":"event","event":"pi-event","payload":{"handle":3,"event":{…}},"seq":42}   (replay, then live)
//            {"type":"pi/reload","handle":3}   (events after `since` are gone from the buffer: reload the history)
//            {"type":"event","event":"pi-exit","payload":{"handle":3,"stderr":"…"}}
//   client → {"type":"unsubscribe","handle":3}
//   server → {"type":"activity","handle":3,"hostId":"…","sessionPath":"…","streaming":true,"alive":true}
//            to every user of that host when a process starts/finishes an answer or ends (session list marks)
import type { IncomingMessage, Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { canUseHost, userForRequest } from "./helpers.js";
import type { PiManager } from "./host/pi.js";
import type { Store, UserRecord } from "./store.js";

/** Heartbeat: ping every 30 s, terminate connections that missed a pong */
const HEARTBEAT_MS = 30_000;

export interface SocketHub {
  wss: WebSocketServer;
  /** Send a message to every connected client (optionally only to users the filter accepts) */
  broadcast(message: unknown, filter?: (user: UserRecord) => boolean): void;
  /** Whether any client follows the events of a Pi process (idle processes nobody watches get closed) */
  isWatched(handle: number): boolean;
  close(): Promise<void>;
}

export function createSocketHub(server: Server, store: Store, pi?: PiManager): SocketHub {
  const users = new WeakMap<WebSocket, UserRecord>();
  const subs = new Map<WebSocket, Set<number>>();
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

  /** The user of a socket, as long as the account still exists */
  const userOf = (ws: WebSocket): UserRecord | null => {
    const u = users.get(ws);
    return u && store.users.has(u.id) ? (store.users.get(u.id) ?? null) : null;
  };

  const send = (ws: WebSocket, msg: unknown) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  function subscribe(ws: WebSocket, handle: number, since: number) {
    const user = userOf(ws);
    const info = pi?.info(handle);
    if (!pi || !user || !info || !canUseHost(user, info.hostId)) {
      send(ws, { type: "pi/denied", handle });
      return;
    }
    // replay and joining the live stream happen in the same tick: no event can slip in between
    const r = pi.replay(handle, since);
    send(ws, { type: "pi/subscribed", handle, seq: r.seq, alive: info.alive, streaming: info.streaming });
    if (!r.complete) send(ws, { type: "pi/reload", handle });
    else for (const e of r.events) send(ws, { type: "event", event: "pi-event", payload: { handle, event: e.event }, seq: e.seq });
    if (!info.alive) send(ws, { type: "event", event: "pi-exit", payload: { handle, stderr: pi.stderr(handle) } });
    let set = subs.get(ws);
    if (!set) {
      set = new Set();
      subs.set(ws, set);
    }
    set.add(handle);
    pi.touch(handle);
  }

  const alive = new WeakMap<WebSocket, boolean>();
  wss.on("connection", (ws, req) => {
    const user = pending.get(req);
    if (user) users.set(ws, user);
    alive.set(ws, true);
    ws.on("pong", () => alive.set(ws, true));
    ws.on("error", () => {
      /* socket errors must not crash the server */
    });
    ws.on("close", () => subs.delete(ws));
    ws.on("message", (raw) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return; // not JSON: ignore
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (typeof m.handle !== "number") return;
      if (m.type === "subscribe") subscribe(ws, m.handle, typeof m.since === "number" ? m.since : 0);
      else if (m.type === "unsubscribe") subs.get(ws)?.delete(m.handle);
    });
  });

  /** Tell every user of the host that a process started/finished an answer or ended */
  function activity(handle: number, alive: boolean) {
    const info = pi?.info(handle);
    if (!info) return;
    const msg = { type: "activity", handle, hostId: info.hostId, sessionPath: info.sessionPath, streaming: info.streaming, alive };
    wss.clients.forEach((ws) => {
      const user = userOf(ws);
      if (user && canUseHost(user, info.hostId)) send(ws, msg);
    });
  }

  if (pi) {
    pi.setListener({
      onEvent(handle, seq, event) {
        const type = (event as { type?: unknown }).type;
        if (type === "agent_start" || type === "agent_settled") activity(handle, true);
        for (const [ws, set] of subs) {
          if (!set.has(handle)) continue;
          // rights can change while a socket is open (admin removes a host): check on every event
          const user = userOf(ws);
          const info = pi.info(handle);
          if (!user || !info || !canUseHost(user, info.hostId)) continue;
          send(ws, { type: "event", event: "pi-event", payload: { handle, event }, seq });
        }
      },
      onExit(handle, stderr) {
        activity(handle, false);
        for (const [ws, set] of subs) {
          if (set.has(handle) && userOf(ws)) send(ws, { type: "event", event: "pi-exit", payload: { handle, stderr } });
        }
      },
    });
  }

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
      wss.clients.forEach((ws) => {
        const user = userOf(ws);
        // a deleted user must not receive anything any more
        if (!user) return;
        if (filter && !filter(user)) return;
        send(ws, message);
      });
    },
    isWatched(handle) {
      for (const set of subs.values()) if (set.has(handle)) return true;
      return false;
    },
    close() {
      clearInterval(heartbeat);
      pi?.setListener(null);
      for (const c of wss.clients) c.terminate();
      return new Promise((r) => wss.close(() => r()));
    },
  };
}
