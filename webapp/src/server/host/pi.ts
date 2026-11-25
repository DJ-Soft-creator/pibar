// Running Pi processes of the webapp – port of src-tauri/src/pi.rs (PiManager). One `pi --mode rpc` per open session
// on its host (over SSH), JSON lines over stdin/stdout: answers go to the waiting send(), everything else is an event.
//
// Differences to the desktop, because phones come and go:
// - A process belongs to the server, not to a browser tab. Opening a session that is already open in the webapp
//   (same host and session file) returns the running process, so a reconnect or a second device joins it.
// - Every event gets a sequence number and is kept in a ring buffer; a client that reconnects asks for the events
//   after the last number it saw (replay). If they are no longer in the buffer it is told to reload the history.
// - Processes nobody watches that are idle (no answer running) are closed after a while.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { HostExec, HostTarget } from "./hostexec.js";

/** How long a single RPC command may take until Pi answers (pi.rs: RPC_TIMEOUT) */
const RPC_TIMEOUT_MS = 60_000;
/** Events kept per process for replays */
const BUFFER_EVENTS = 5000;
/** Characters of stderr kept (pi.rs keeps ~4000) */
const STDERR_TAIL = 4000;

/** Pi's tool flags: null = Pi's default, [] = no tools, otherwise an allowlist (pi.rs: tool_args) */
export function toolArgs(tools: string[] | null): string[] {
  if (tools === null) return [];
  const clean = tools.map((t) => t.trim()).filter((t) => /^[A-Za-z0-9_.-]+$/.test(t));
  if (clean.length === 0) return ["--no-tools"];
  return ["--tools", clean.join(",")];
}

export interface BufferedEvent {
  seq: number;
  event: unknown;
}

export interface PiInfo {
  handle: number;
  hostId: string;
  cwd: string;
  sessionPath: string | null;
  alive: boolean;
  streaming: boolean;
}

interface Pending {
  resolve(v: Record<string, unknown>): void;
  reject(e: Error): void;
  timer: NodeJS.Timeout;
}

interface PiProc extends PiInfo {
  child: ChildProcessWithoutNullStreams;
  pending: Map<string, Pending>;
  stderr: string;
  buffer: BufferedEvent[];
  seq: number;
  lastActivity: number;
}

export interface PiListener {
  /** A Pi event (everything that is not the answer to a command) */
  onEvent(handle: number, seq: number, event: unknown): void;
  /** The process ended (stderr tail for the error box) */
  onExit(handle: number, stderr: string): void;
}

export interface OpenOptions {
  sessionPath?: string | null;
  tools?: string[] | null;
  appendPrompt?: string | null;
}

export class PiManager {
  private readonly procs = new Map<number, PiProc>();
  private nextHandle = 1;
  private nextReq = 1;
  private listener: PiListener | null = null;
  private sweeper: NodeJS.Timeout | null = null;

  constructor(
    private readonly exec: HostExec,
    private readonly opts: { idleMs?: number; isWatched?: (handle: number) => boolean } = {},
  ) {}

  setListener(l: PiListener | null) {
    this.listener = l;
  }

  /** Close idle processes nobody watches (every minute; idleMs default 30 min) */
  startSweeper(isWatched: (handle: number) => boolean) {
    this.stopSweeper();
    const idle = this.opts.idleMs ?? 30 * 60_000;
    this.sweeper = setInterval(() => this.sweep(isWatched, idle), 60_000);
    this.sweeper.unref();
  }

  stopSweeper() {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = null;
  }

  sweep(isWatched: (handle: number) => boolean, idleMs: number, now = Date.now()) {
    for (const p of this.procs.values()) {
      if (!p.streaming && !isWatched(p.handle) && now - p.lastActivity > idleMs) this.close(p.handle);
    }
  }

  info(handle: number): PiInfo | null {
    const p = this.procs.get(handle);
    if (!p) return null;
    const { child: _c, pending: _p, stderr: _s, buffer: _b, seq: _q, lastActivity: _l, ...info } = p;
    return info;
  }

  list(): PiInfo[] {
    return [...this.procs.keys()].map((h) => this.info(h)).filter((i): i is PiInfo => i !== null);
  }

  /** The running process of a session file on a host, if the webapp has one */
  findSession(hostId: string, sessionPath: string): number | null {
    for (const p of this.procs.values()) if (p.alive && p.hostId === hostId && p.sessionPath === sessionPath) return p.handle;
    return null;
  }

  /**
   * Start Pi for a session (pi.rs: open). An existing session that already runs in the webapp is joined instead of
   * started a second time (two processes must never write the same session file).
   */
  open(host: HostTarget, cwd: string, o: OpenOptions = {}): { handle: number; joined: boolean } {
    const sessionPath = o.sessionPath ?? null;
    if (sessionPath) {
      const running = this.findSession(host.id, sessionPath);
      if (running !== null) {
        this.touch(running);
        return { handle: running, joined: true };
      }
    }
    const args: string[] = [];
    if (sessionPath) args.push("--session", sessionPath);
    args.push(...toolArgs(o.tools ?? null));
    if (o.appendPrompt) args.push("--append-system-prompt", o.appendPrompt);
    const child = this.exec.spawnPi(host, cwd, args);
    const handle = this.nextHandle++;
    const proc: PiProc = {
      handle,
      hostId: host.id,
      cwd,
      sessionPath,
      alive: true,
      streaming: false,
      child,
      pending: new Map(),
      stderr: "",
      buffer: [],
      seq: 0,
      lastActivity: Date.now(),
    };
    this.procs.set(handle, proc);
    this.pump(proc);
    return { handle, joined: false };
  }

  private pump(p: PiProc) {
    const lines = createInterface({ input: p.child.stdout });
    lines.on("line", (raw) => {
      const line = raw.trim();
      if (!line) return;
      let v: unknown;
      try {
        v = JSON.parse(line);
      } catch {
        return; // output of the login shell and the like
      }
      if (typeof v !== "object" || v === null) return;
      const msg = v as Record<string, unknown>;
      if (msg.type === "response" && typeof msg.id === "string") {
        const waiting = p.pending.get(msg.id);
        if (waiting) {
          p.pending.delete(msg.id);
          clearTimeout(waiting.timer);
          waiting.resolve(msg);
          return;
        }
      }
      this.event(p, msg);
    });
    p.child.stderr.on("data", (d: Buffer) => {
      p.stderr = (p.stderr + d.toString("utf8")).slice(-STDERR_TAIL);
    });
    p.child.stdin.on("error", () => {
      /* Pi ended; close handles it */
    });
    p.child.on("close", () => {
      p.alive = false;
      p.streaming = false;
      for (const w of p.pending.values()) {
        clearTimeout(w.timer);
        w.reject(new Error("Pi process has ended"));
      }
      p.pending.clear();
      this.listener?.onExit(p.handle, p.stderr);
    });
    p.child.on("error", () => {
      /* spawn errors also end in close */
    });
  }

  private event(p: PiProc, msg: Record<string, unknown>) {
    if (msg.type === "agent_start") p.streaming = true;
    else if (msg.type === "agent_settled") p.streaming = false;
    p.lastActivity = Date.now();
    const seq = ++p.seq;
    p.buffer.push({ seq, event: msg });
    if (p.buffer.length > BUFFER_EVENTS) p.buffer.splice(0, p.buffer.length - BUFFER_EVENTS);
    this.listener?.onEvent(p.handle, seq, msg);
  }

  /**
   * Events after `since`. `complete` is false when some of them are no longer buffered (the client then reloads the
   * history with get_messages instead).
   */
  replay(handle: number, since: number): { events: BufferedEvent[]; complete: boolean; seq: number } {
    const p = this.procs.get(handle);
    if (!p) return { events: [], complete: false, seq: 0 };
    const first = p.buffer[0]?.seq ?? p.seq + 1;
    return { events: p.buffer.filter((e) => e.seq > since), complete: since >= first - 1, seq: p.seq };
  }

  touch(handle: number) {
    const p = this.procs.get(handle);
    if (p) p.lastActivity = Date.now();
  }

  /** Send an RPC command and wait for Pi's answer (pi.rs: send) */
  send(handle: number, cmd: Record<string, unknown>): Promise<Record<string, unknown>> {
    const p = this.procs.get(handle);
    if (!p || !p.alive) return Promise.reject(new Error("Pi process not found"));
    p.lastActivity = Date.now();
    const id = `r${this.nextReq++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        p.pending.delete(id);
        reject(new Error("Pi did not answer in time"));
      }, RPC_TIMEOUT_MS);
      p.pending.set(id, { resolve, reject, timer });
      p.child.stdin.write(`${JSON.stringify({ ...cmd, id })}\n`, (err) => {
        if (!err) return;
        const w = p.pending.get(id);
        if (!w) return;
        p.pending.delete(id);
        clearTimeout(w.timer);
        reject(new Error(`Pi not reachable: ${err.message}`));
      });
    });
  }

  /** Write one message without waiting (answers to Pi's dialogs; pi.rs: reply) */
  reply(handle: number, msg: Record<string, unknown>) {
    const p = this.procs.get(handle);
    if (!p || !p.alive) throw new Error("Pi process not found");
    p.lastActivity = Date.now();
    p.child.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  stderr(handle: number): string {
    return this.procs.get(handle)?.stderr ?? "";
  }

  close(handle: number) {
    const p = this.procs.get(handle);
    if (!p) return;
    this.procs.delete(handle);
    if (p.alive) p.child.kill("SIGTERM");
  }

  closeAll() {
    for (const h of [...this.procs.keys()]) this.close(h);
  }
}
