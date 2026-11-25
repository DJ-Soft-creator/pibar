// The one WebSocket of the page, shared by the views: send messages, hear when it (re)connects (to subscribe again),
// and receive server messages that are not events (pi/subscribed, pi/reload, pi/denied …). main.ts owns the socket.
import type { SocketHandle } from "./socket";

export type SocketMsg = Record<string, unknown> & { type?: string; handle?: number };

let socket: SocketHandle | null = null;
const openListeners = new Set<() => void>();
const msgListeners = new Set<(m: SocketMsg) => void>();

export function setSocket(s: SocketHandle | null) {
  socket = s;
}

export function socketSend(msg: unknown): boolean {
  return socket?.send(msg) ?? false;
}

/** Runs after every (re)connect; returns the function that removes it */
export function onSocketOpen(fn: () => void): () => void {
  openListeners.add(fn);
  return () => openListeners.delete(fn);
}

export function onSocketMessage(fn: (m: SocketMsg) => void): () => void {
  msgListeners.add(fn);
  return () => msgListeners.delete(fn);
}

/** Called by main.ts */
export function notifySocketOpen() {
  for (const fn of [...openListeners]) fn();
}

/** Called by main.ts for every message */
export function notifySocketMessage(m: Record<string, unknown>) {
  for (const fn of [...msgListeners]) fn(m as SocketMsg);
}
