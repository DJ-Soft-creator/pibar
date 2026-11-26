// Two-way sync of the session-list organisation (session metadata, groups, projects) between the desktop and the
// webapp (POST /api/sync/meta, webapp/src/server/sync.ts). Pure logic, tested in metaSync.test.ts; the requests
// and timers live in src/main/configExchange.ts.
//
// Every entry carries `updatedAt` (ms). Instead of touching every place that edits sessionMeta, groups or projects,
// stampChanges() compares the config with a snapshot of the last look before each save: new or changed entries get
// the current time, vanished ones a tombstone in `syncDeleted`. Merging: per entry the newer `updatedAt` wins (on
// the server and here alike), a tombstone competes with its deletion time.
import type { AppConfig, HostCfg, Project, SessionGroup, SessionMeta, SyncTombstones } from "./api";

/** Tombstones older than this are dropped (every desktop has synced long before) */
export const TOMBSTONE_TTL_MS = 180 * 24 * 60 * 60 * 1000;

/** A host as the webapp sees it: only id, name, kind and a display address (no commands or folders) */
export interface HostInfo {
  id: string;
  name: string;
  kind: "local" | "ssh";
  /** ssh: "[user@]target[:port]"; local: "" */
  address: string;
}

/** Map a host of the settings to the sync shape: ssh gets "[user@]target[:port]", local an empty address */
export function hostInfo(h: Pick<HostCfg, "id" | "name" | "kind" | "sshTarget" | "sshUser" | "sshPort">): HostInfo {
  const address =
    h.kind === "ssh" ? (h.sshUser ? `${h.sshUser}@` : "") + h.sshTarget + (h.sshPort ? `:${h.sshPort}` : "") : "";
  return { id: h.id, name: h.name, kind: h.kind, address };
}

/** What the sync needs of the config (AppConfig or a test object) */
export type SyncConfig = Pick<AppConfig, "sessionMeta" | "groups" | "projects" | "syncDeleted">;

/** JSON of every entry without its updatedAt, as seen at the last stamp */
export interface Snapshot {
  sessions: Map<string, string>;
  groups: Map<string, string>;
  projects: Map<string, string>;
}

type Stamped = { updatedAt?: number };

/** JSON with sorted keys at every level: key order must not count as a change */
function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const keys = Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${stable(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v) ?? "null";
}

function body(v: Stamped): string {
  const rest: Record<string, unknown> = { ...(v as Record<string, unknown>) };
  delete rest.updatedAt;
  return stable(rest);
}

function tombstones(cfg: SyncConfig): SyncTombstones {
  cfg.syncDeleted ??= { sessions: {}, groups: {}, projects: {} };
  cfg.syncDeleted.sessions ??= {};
  cfg.syncDeleted.groups ??= {};
  cfg.syncDeleted.projects ??= {};
  return cfg.syncDeleted;
}

/** The three sections as key → entry */
function sections(cfg: SyncConfig): Record<keyof Snapshot, Map<string, Stamped>> {
  return {
    sessions: new Map(Object.entries(cfg.sessionMeta ?? {})),
    groups: new Map((cfg.groups ?? []).map((g) => [g.id, g])),
    projects: new Map((cfg.projects ?? []).map((p) => [p.id, p])),
  };
}

export function snapshot(cfg: SyncConfig): Snapshot {
  const s = sections(cfg);
  const map = (m: Map<string, Stamped>) => new Map([...m].map(([k, v]) => [k, body(v)]));
  return { sessions: map(s.sessions), groups: map(s.groups), projects: map(s.projects) };
}

/**
 * Stamp what changed since `prev`: new and changed entries get `now`, entries gone since then a tombstone. With
 * prev = null (first look after the start) only entries without a stamp get one – the desktop's state then counts
 * as current, so an older copy on the webapp (the old config exchange) does not overwrite it. Returns the new
 * snapshot and whether the config changed (save it then).
 */
export function stampChanges(
  cfg: SyncConfig,
  prev: Snapshot | null,
  now = Date.now(),
): { snap: Snapshot; changed: boolean } {
  const dead = tombstones(cfg);
  let changed = false;
  const cur = sections(cfg);
  for (const section of ["sessions", "groups", "projects"] as const) {
    const before = prev?.[section];
    for (const [k, v] of cur[section]) {
      const isNew = before ? before.get(k) !== body(v) : !v.updatedAt;
      if (isNew) {
        v.updatedAt = now;
        changed = true;
      }
      if (isNew && dead[section][k] !== undefined) delete dead[section][k];
    }
    if (before) {
      for (const k of before.keys()) {
        if (!cur[section].has(k)) {
          dead[section][k] = now;
          changed = true;
        }
      }
    }
    for (const [k, at] of Object.entries(dead[section])) {
      if (now - at > TOMBSTONE_TTL_MS) {
        delete dead[section][k];
        changed = true;
      }
    }
  }
  return { snap: snapshot(cfg), changed };
}

/** Body of POST /api/sync/meta */
export interface SyncRequest {
  hosts: HostInfo[];
  sessionMeta: Record<string, SessionMeta>;
  groups: SessionGroup[];
  projects: Project[];
  deleted: {
    sessions: { key: string; updatedAt: number }[];
    groups: { id: string; updatedAt: number }[];
    projects: { id: string; updatedAt: number }[];
  };
}

/** Answer of the webapp: the merged state for this desktop's hosts (its own host ids) */
export interface SyncResponse {
  sessionMeta: Record<string, SessionMeta>;
  groups: SessionGroup[];
  projects: Project[];
  deleted: SyncRequest["deleted"];
  /** Per desktop host: the webapp host it matched (name), null = not synced */
  hosts: { id: string; webappHost: string | null }[];
  serverTime: number;
}

export function buildRequest(cfg: SyncConfig, hosts: HostInfo[]): SyncRequest {
  const dead = tombstones(cfg);
  return {
    hosts,
    sessionMeta: cfg.sessionMeta ?? {},
    groups: cfg.groups ?? [],
    projects: cfg.projects ?? [],
    deleted: {
      sessions: Object.entries(dead.sessions).map(([key, updatedAt]) => ({ key, updatedAt })),
      groups: Object.entries(dead.groups).map(([id, updatedAt]) => ({ id, updatedAt })),
      projects: Object.entries(dead.projects).map(([id, updatedAt]) => ({ id, updatedAt })),
    },
  };
}

/** Shape check of the webapp's answer (its JSON is untyped) */
export function isSyncResponse(v: unknown): v is SyncResponse {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Partial<SyncResponse>;
  const d = r.deleted;
  return (
    typeof r.sessionMeta === "object" &&
    r.sessionMeta !== null &&
    Array.isArray(r.groups) &&
    Array.isArray(r.projects) &&
    typeof d === "object" &&
    d !== null &&
    Array.isArray(d.sessions) &&
    Array.isArray(d.groups) &&
    Array.isArray(d.projects)
  );
}

export interface ApplyCounts {
  /** entries taken over from the webapp (new or newer) */
  updated: number;
  /** entries removed because the webapp deleted them later */
  removed: number;
}

/** Local time of an entry: its stamp, or the time it was deleted here; -1 = unknown here */
function localTime(entry: Stamped | undefined, deletedAt: number | undefined): number {
  if (entry) return entry.updatedAt ?? 0;
  return deletedAt ?? -1;
}

/**
 * Apply the webapp's answer: an entry replaces the local one when it is newer, a tombstone removes it when the
 * deletion is newer. Takes the snapshot of the result (applied changes are no local changes). Returns the counts;
 * the caller saves when something changed.
 */
export function applyResponse(cfg: SyncConfig, res: SyncResponse): ApplyCounts & { snap: Snapshot } {
  const dead = tombstones(cfg);
  const counts: ApplyCounts = { updated: 0, removed: 0 };
  const meta = (cfg.sessionMeta ??= {});
  for (const [key, v] of Object.entries(res.sessionMeta)) {
    const at = v.updatedAt ?? 0;
    if (at > localTime(meta[key], dead.sessions[key])) {
      meta[key] = { ...v, updatedAt: at };
      delete dead.sessions[key];
      counts.updated++;
    }
  }
  for (const { key, updatedAt } of res.deleted.sessions) {
    if (meta[key] && updatedAt > (meta[key].updatedAt ?? 0)) {
      delete meta[key];
      dead.sessions[key] = updatedAt;
      counts.removed++;
    }
  }
  const lists = [
    ["groups", (cfg.groups ??= []), res.groups, res.deleted.groups],
    ["projects", (cfg.projects ??= []), res.projects, res.deleted.projects],
  ] as const;
  for (const [section, list, incoming, deleted] of lists) {
    const items = list as (SessionGroup | Project)[];
    for (const v of incoming as (SessionGroup | Project)[]) {
      const at = v.updatedAt ?? 0;
      const i = items.findIndex((x) => x.id === v.id);
      if (at > localTime(i >= 0 ? items[i] : undefined, dead[section][v.id])) {
        const next = { ...v, updatedAt: at };
        if (i >= 0) items[i] = next;
        else items.push(next);
        delete dead[section][v.id];
        counts.updated++;
      }
    }
    for (const { id, updatedAt } of deleted) {
      const i = items.findIndex((x) => x.id === id);
      if (i >= 0 && updatedAt > (items[i]?.updatedAt ?? 0)) {
        items.splice(i, 1);
        dead[section][id] = updatedAt;
        counts.removed++;
      }
    }
  }
  return { ...counts, snap: snapshot(cfg) };
}
