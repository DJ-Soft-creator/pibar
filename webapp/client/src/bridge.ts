// The webapp's stand-in for the Tauri bridge: shared code (src/shared/api.ts) calls invoke("<command>", args) as on
// the desktop; here that becomes POST /api/cmd/<command> on the webapp server (same names and arguments, see
// webapp/src/server/commands.ts). Events (listen/emit) come from the WebSocket (socket.ts → dispatchEvent).
// No DOM or WebSocket in here, so the module also runs in the server's node tests (test/bridge.test.ts).

/** Payload as Tauri hands it to listeners */
export interface BridgeEvent<T> {
  event: string;
  id: number;
  payload: T;
}

type Handler = (e: BridgeEvent<unknown>) => void;

let base = "";
let fetchImpl: typeof fetch = (...a) => fetch(...a);
let unauthorized: (() => void) | null = null;
const handlers = new Map<string, Set<Handler>>();
let nextId = 1;

/** Server base URL ("" = same origin) and the fetch to use (tests) */
export function configureBridge(opts: { base?: string; fetch?: typeof fetch }) {
  if (opts.base !== undefined) base = opts.base.replace(/\/+$/, "");
  if (opts.fetch) fetchImpl = opts.fetch;
}

/** Called when the server answers 401 (login expired or revoked) */
export function setUnauthorizedHandler(fn: (() => void) | null) {
  unauthorized = fn;
}

/**
 * Run a command on the server. Like Tauri, a failure rejects with the error STRING (not an Error), because the
 * desktop code shows Tauri errors with String(e).
 */
export async function invoke<T>(cmd: string, args: Record<string, unknown> = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetchImpl(`${base}/api/cmd/${encodeURIComponent(cmd)}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
  } catch {
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects with strings
    throw "Server not reachable";
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* empty or no JSON */
  }
  if (res.status === 401) unauthorized?.();
  if (!res.ok) {
    const msg =
      typeof data === "object" && data !== null && typeof (data as { error?: unknown }).error === "string"
        ? (data as { error: string }).error
        : `HTTP ${res.status}`;
    // eslint-disable-next-line @typescript-eslint/only-throw-error -- Tauri rejects with strings
    throw msg;
  }
  return (data as { result: T }).result;
}

/** Listen to an event (Tauri's listen); resolves to the unlisten function */
export function listen<T>(event: string, handler: (e: BridgeEvent<T>) => void): Promise<() => void> {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  const h = handler as Handler;
  set.add(h);
  return Promise.resolve(() => {
    handlers.get(event)?.delete(h);
  });
}

/** Deliver an event to its listeners (from the WebSocket, or emit() for events inside the page) */
export function dispatchEvent(event: string, payload: unknown) {
  const set = handlers.get(event);
  if (!set) return;
  const e: BridgeEvent<unknown> = { event, id: nextId++, payload };
  for (const h of [...set]) {
    try {
      h(e);
    } catch (err) {
      console.error(`Listener for ${event} failed:`, err);
    }
  }
}

/** Tauri's emit: in the webapp there is only this page, so it goes straight to its own listeners */
export function emit(event: string, payload?: unknown): Promise<void> {
  dispatchEvent(event, payload);
  return Promise.resolve();
}
