// Session lock between the desktop app and the webapp (tasks B9/D1): a session must never run in two Pi processes at
// once. Opening a session another live Pi holds fails with an error that starts with a machine-readable tag,
// "session-locked:<desktop|webapp>:<unix seconds> <text>" (src-tauri/src/lock.rs, webapp/src/server/host/lock.ts).
// Pure helpers to recognise it and to show the history read-only, tested in sessionLock.test.ts.
import { t } from "./i18n";
import type { PiMessage } from "./piProtocol";

export interface SessionLock {
  /** Who holds the session: "desktop" (a PiBar desktop app) or "webapp" */
  holder: string;
  /** Since when (ms), 0 = unknown */
  since: number;
}

/** The lock behind an error of pi_open / pi_attach, null for any other error */
export function parseSessionLock(e: unknown): SessionLock | null {
  const text = e instanceof Error ? e.message : String(e);
  const m = /session-locked:([a-z]+):(\d+)/.exec(text);
  if (!m) return null;
  return { holder: m[1] ?? "", since: Number(m[2]) * 1000 };
}

/** Readable sentence for the dialog */
export function sessionLockText(lock: SessionLock): string {
  return lock.holder === "desktop"
    ? t("This session is open in the desktop app right now.")
    : t("This session is open in the webapp right now.");
}

/**
 * Messages of the current branch of a session file (JSONL text) for a read-only view without Pi: Pi's session file
 * is a tree (`id` / `parentId`), the branch is the path from the last entry back to the root.
 */
export function branchMessages(jsonl: string): PiMessage[] {
  const entries: { id?: string; parentId?: string | null; type?: string; message?: PiMessage }[] = [];
  for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o: unknown = JSON.parse(s);
      if (o && typeof o === "object" && !Array.isArray(o)) entries.push(o as (typeof entries)[number]);
    } catch {
      /* a damaged line does not stop the view */
    }
  }
  const byId = new Map(entries.filter((e) => typeof e.id === "string").map((e) => [e.id as string, e]));
  const last = [...entries].reverse().find((e) => e.type !== "session" && typeof e.id === "string");
  const branch: PiMessage[] = [];
  const seen = new Set<string>();
  for (let e = last; e?.id && !seen.has(e.id); e = e.parentId ? byId.get(e.parentId) : undefined) {
    seen.add(e.id);
    if (e.type === "message" && e.message) branch.push(e.message);
  }
  return branch.reverse();
}
