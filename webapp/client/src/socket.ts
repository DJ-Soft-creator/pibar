// WebSocket to the server (/ws, session cookie): server messages of the form {"type":"event","event":…,"payload":…}
// go to the bridge's listeners, other types to onMessage. Reconnects with backoff, and at once when the page becomes
// visible again (phone unlocked). Catching up on missed Pi events after a reconnect: tasks B10/C4.
import { dispatchEvent } from "./bridge";

export interface SocketOptions {
  /** Every parsed message (also events) */
  onMessage?: (msg: Record<string, unknown>) => void;
  /** Connection state changed */
  onState?: (open: boolean) => void;
}

export interface SocketHandle {
  send(msg: unknown): boolean;
  close(): void;
  readonly open: boolean;
}

export function connectSocket(opts: SocketOptions = {}): SocketHandle {
  let ws: WebSocket | null = null;
  let closed = false;
  let delay = 1000;
  let timer: number | null = null;

  const url = () => `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/ws`;

  function schedule() {
    if (closed || timer !== null) return;
    timer = window.setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    delay = Math.min(delay * 2, 30_000);
  }

  function connect() {
    if (closed || (ws && ws.readyState <= WebSocket.OPEN)) return;
    const sock = new WebSocket(url());
    ws = sock;
    sock.onopen = () => {
      delay = 1000;
      opts.onState?.(true);
    };
    sock.onmessage = (ev) => {
      let msg: unknown;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (typeof msg !== "object" || msg === null) return;
      const m = msg as Record<string, unknown>;
      if (m.type === "event" && typeof m.event === "string") dispatchEvent(m.event, m.payload);
      opts.onMessage?.(m);
    };
    sock.onclose = () => {
      if (ws === sock) ws = null;
      opts.onState?.(false);
      schedule();
    };
  }

  const onVisible = () => {
    if (document.visibilityState !== "visible" || closed) return;
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
    delay = 1000;
    connect();
  };
  document.addEventListener("visibilitychange", onVisible);
  connect();

  return {
    send(msg) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    close() {
      closed = true;
      document.removeEventListener("visibilitychange", onVisible);
      if (timer !== null) window.clearTimeout(timer);
      ws?.close();
    },
    get open() {
      return ws?.readyState === WebSocket.OPEN;
    },
  };
}
