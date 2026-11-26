// Session lock on the host (tasks B9/D1) – the same scripts as src-tauri/src/lock.rs. A session must never run in
// two Pi processes at once (desktop and webapp). The script that starts Pi writes ~/.pibar/<hash>.lock
// ("<owner> <pid> <unix seconds>", hash = FNV-1a of the session path as in bg.rs) and then becomes Pi (`exec`), so
// the pid in the file is Pi's. A lock counts only while that process lives and its command line names the session
// file (pid reuse); a stale lock is ignored. Owners: "desktop:<instance>" or "webapp:<instance>".
import { randomBytes } from "node:crypto";
import { CommandError } from "../commands.js";
import { sq, type HostExec, type HostTarget } from "./hostexec.js";

/** Stable short name of a session's files: FNV-1a 64 over the UTF-8 bytes of the path (bg.rs: hash) */
export function fnv1a(s: string): string {
  let h = 0xcbf29ce484222325n;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h.toString(16).padStart(16, "0");
}

/** Lock file of a session (shell snippet, expands "$HOME") */
export function lockPath(session: string): string {
  return `"$HOME"/.pibar/${fnv1a(session)}.lock`;
}

/** A new owner id for this process ("webapp:<8 hex>"), so its own locks never block it */
export function newLockOwner(kind: "webapp" | "desktop"): string {
  return `${kind}:${randomBytes(4).toString("hex")}`;
}

/** Shell condition: process "$p" lives and its command line names the session file */
function aliveCheck(session: string): string {
  return (
    `[ -n "$p" ] && kill -0 "$p" 2>/dev/null && ` +
    `{ ps -ww -p "$p" -o args= 2>/dev/null || ps -p "$p" -o args= 2>/dev/null; } | grep -qF -e ${sq(session)}`
  );
}

/** Prints "<owner> <pid> <time>" of a live lock, nothing when the session is free or the lock is stale */
export function lockCheckScript(session: string): string {
  return (
    `f=${lockPath(session)}; if [ -s "$f" ]; then read -r o p t < "$f"; ` +
    `if ${aliveCheck(session)}; then echo "$o $p $t"; fi; fi; true`
  );
}

/** Take a session over: stop the Pi process holding the lock (TERM, after 3 s KILL); a stale lock is left alone */
export function lockTakeoverScript(session: string): string {
  return (
    `f=${lockPath(session)}; if [ -s "$f" ]; then read -r o p t < "$f"; ` +
    `if ${aliveCheck(session)}; then kill -TERM "$p" 2>/dev/null; i=0; ` +
    `while kill -0 "$p" 2>/dev/null && [ $i -lt 30 ]; do sleep 0.1; i=$((i+1)); done; ` +
    `kill -0 "$p" 2>/dev/null && kill -KILL "$p" 2>/dev/null; fi; fi; true`
  );
}

/** Put in front of the Pi start script: writes the lock with the pid of the shell that then becomes Pi */
export function lockWritePrefix(owner: string, session: string): string {
  const clean = owner.replace(/[^A-Za-z0-9:._-]/g, "") || "unknown";
  return `mkdir -p "$HOME"/.pibar && echo ${sq(clean)} "$$" "$(date +%s)" > ${lockPath(session)} && `;
}

export interface LockHolder {
  owner: string;
  /** "desktop" or "webapp" (the part of the owner before ":") */
  kind: string;
  pid: number;
  /** Unix seconds the holder started (0 = unknown) */
  since: number;
}

/** The output of lockCheckScript; null = free */
export function parseLockLine(out: string): LockHolder | null {
  const [owner, pid, since] = out.trim().split(/\s+/);
  if (!owner || !pid || !/^\d+$/.test(pid)) return null;
  return { owner, kind: owner.split(":")[0] ?? owner, pid: Number(pid), since: /^\d+$/.test(since ?? "") ? Number(since) : 0 };
}

/**
 * Error of a locked session. The message starts with a machine-readable tag the clients recognise
 * (src/shared/sessionLock.ts: "session-locked:<kind>:<since> …"), then a readable text.
 */
export class SessionLockedError extends CommandError {
  constructor(readonly holder: LockHolder) {
    const where = holder.kind === "desktop" ? "in the desktop app" : "in another PiBar webapp";
    super(409, `session-locked:${holder.kind}:${holder.since} This session is open ${where} right now`);
  }
}

/**
 * Make sure no other live Pi process holds the session before starting one. Own locks (same owner) count as free.
 * force = take over: the other Pi process is stopped.
 */
export async function claimSession(exec: HostExec, host: HostTarget, session: string, owner: string, force: boolean) {
  const holder = parseLockLine(await exec.runShell(host, lockCheckScript(session), { timeoutMs: 20_000 }));
  if (!holder || holder.owner === owner) return;
  if (!force) throw new SessionLockedError(holder);
  await exec.runShell(host, lockTakeoverScript(session), { timeoutMs: 20_000 });
}
