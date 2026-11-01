// Where the branches of a session part. Pi's fork writes a new session file that keeps the entry ids of the shared
// history (header `parentSession` points to the original). Comparing the ids of the user messages of all related
// files shows, for each own message, which other versions of that message exist – like "‹ 2/3 ›" in other chats.
import type { SessionInfo } from "./api";

/** User messages of one session file (from the Rust core, sessions.rs `outlines`) */
export interface SessionOutline {
  path: string;
  /** Last change, seconds since the epoch */
  mtime: number;
  users: { id: string; text: string }[];
  /** Creation time from the session header (ISO), filled in from the session list; orders the versions */
  created?: string;
}

/** Creation time in ms: header timestamp, otherwise the last change */
const born = (o: SessionOutline) => (o.created && Date.parse(o.created)) || o.mtime * 1000;

/** One version of a message: the session file to switch to and the text of that version */
export interface BranchChoice {
  path: string;
  text: string;
  current: boolean;
}

/** All sessions linked to `path` through `parent` (both directions): the original, its branches, their branches */
export function branchFamily(sessions: SessionInfo[], path: string): string[] {
  const children = new Map<string, string[]>();
  const parentOf = new Map<string, string>();
  for (const s of sessions) {
    if (!s.parent) continue;
    parentOf.set(s.path, s.parent);
    children.set(s.parent, [...(children.get(s.parent) ?? []), s.path]);
  }
  let root = path;
  const seen = new Set<string>([root]);
  while (parentOf.has(root) && !seen.has(parentOf.get(root)!)) {
    root = parentOf.get(root)!;
    seen.add(root);
  }
  const family: string[] = [];
  const todo = [root];
  const done = new Set<string>();
  while (todo.length) {
    const p = todo.pop()!;
    if (done.has(p)) continue;
    done.add(p);
    family.push(p);
    todo.push(...(children.get(p) ?? []));
  }
  return family;
}

/**
 * Versions per position of the current session's user messages (index into `currentIds`), only where there are at
 * least two. Files that share the same message at that position count as one version; the one to open is the most
 * recently changed file that goes on after that message (a bare "go back" copy only if there is no other).
 * Versions are ordered by when their first file was created, so the order stays the same while you work on.
 */
export function branchesAt(
  currentPath: string,
  currentIds: { id: string; text: string }[],
  outlines: SessionOutline[],
): Map<number, BranchChoice[]> {
  const result = new Map<number, BranchChoice[]>();
  const cur = outlines.find((o) => o.path === currentPath);
  const now = cur ? born(cur) : Number.MAX_SAFE_INTEGER;
  for (let k = 0; k < currentIds.length; k++) {
    // id of the message at position k → files with that message (and the same history before it)
    const groups = new Map<string, { path: string; text: string; first: number; rank: number[]; current: boolean }>();
    groups.set(currentIds[k].id, { path: currentPath, text: currentIds[k].text, first: now, rank: [], current: true });
    for (const o of outlines) {
      if (o.path === currentPath || o.users.length <= k) continue;
      let same = true;
      for (let i = 0; i < k && same; i++) same = o.users[i].id === currentIds[i].id;
      if (!same) continue;
      const id = o.users[k].id;
      const rank = [o.users.length > k + 1 ? 1 : 0, o.mtime];
      const g = groups.get(id);
      if (!g) {
        groups.set(id, { path: o.path, text: o.users[k].text, first: born(o), rank, current: false });
        continue;
      }
      g.first = Math.min(g.first, born(o));
      if (!g.current && (rank[0] > g.rank[0] || (rank[0] === g.rank[0] && rank[1] > g.rank[1]))) {
        g.rank = rank;
        g.path = o.path;
      }
    }
    if (groups.size < 2) continue;
    const list = [...groups.values()].sort((a, b) => a.first - b.first || a.path.localeCompare(b.path));
    result.set(
      k,
      list.map((g) => ({ path: g.path, text: g.text, current: g.current })),
    );
  }
  return result;
}
