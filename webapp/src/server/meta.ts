// Organisation of the session list, shared by all users of the webapp and synced with the desktop app: session
// metadata (name, colour, pin, group, model choice … – SessionMeta of src/shared/api.ts), groups and projects.
// Every entry carries `updatedAt` (ms); a deleted entry stays as a tombstone, so a sync can tell "deleted" from
// "never seen". Merging two states: per entry the newer one wins (last writer wins).
//
// Keys of session entries are "<webapp host id>|<session file path>". The desktop uses its own host ids; the sync
// (task D2) maps them with mapDesktopHost.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { HostRecord } from "./hosts.js";
import { isRecord } from "./validation.js";

/** Session metadata as the desktop stores it (src/shared/api.ts SessionMeta); unknown fields are kept */
export type SessionMetaValue = Record<string, unknown>;

export interface GroupValue {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
  [k: string]: unknown;
}

export interface ProjectValue {
  id: string;
  name: string;
  hostId: string;
  dir: string;
  collapsed: boolean;
  [k: string]: unknown;
}

export interface Entry<T> {
  /** null = deleted (tombstone) */
  value: T | null;
  updatedAt: number;
}

export interface MetaState {
  sessions: Record<string, Entry<SessionMetaValue>>;
  groups: Record<string, Entry<GroupValue>>;
  projects: Record<string, Entry<ProjectValue>>;
}

/** What the client sees: only live entries */
export interface MetaView {
  sessionMeta: Record<string, SessionMetaValue>;
  groups: GroupValue[];
  projects: ProjectValue[];
}

export const emptyState = (): MetaState => ({ sessions: {}, groups: {}, projects: {} });

/** Key of a session entry */
export const sessionKey = (hostId: string, path: string) => `${hostId}|${path}`;

/** Host id of a session key */
export const keyHost = (key: string) => key.slice(0, Math.max(0, key.indexOf("|")));

function isEntry(v: unknown): v is Entry<Record<string, unknown>> {
  return isRecord(v) && typeof v.updatedAt === "number" && (v.value === null || isRecord(v.value));
}

function parseSection<T>(v: unknown): Record<string, Entry<T>> {
  const out: Record<string, Entry<T>> = {};
  if (!isRecord(v)) return out;
  for (const [k, e] of Object.entries(v)) if (isEntry(e)) out[k] = e as Entry<T>;
  return out;
}

export function parseState(v: unknown): MetaState {
  if (!isRecord(v)) return emptyState();
  return { sessions: parseSection(v.sessions), groups: parseSection(v.groups), projects: parseSection(v.projects) };
}

/** Merge `incoming` into `base`: per entry the newer `updatedAt` wins (ties keep base). Returns whether base changed. */
export function mergeState(base: MetaState, incoming: MetaState): boolean {
  let changed = false;
  for (const section of ["sessions", "groups", "projects"] as const) {
    const target = base[section] as Record<string, Entry<unknown>>;
    for (const [k, e] of Object.entries(incoming[section] as Record<string, Entry<unknown>>)) {
      const cur = target[k];
      if (!cur || e.updatedAt > cur.updatedAt) {
        target[k] = e;
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * The webapp host of a desktop host: same name (case-insensitive), or the same SSH address ("user@target:port",
 * "user@target" or "target"). null = no match (entries of that host are not synced).
 */
export function mapDesktopHost(
  desktop: { name: string; address: string },
  hosts: Pick<HostRecord, "id" | "name" | "sshTarget" | "sshUser" | "sshPort">[],
): string | null {
  const name = desktop.name.trim().toLowerCase();
  const byName = hosts.find((h) => h.name.trim().toLowerCase() === name);
  if (byName) return byName.id;
  const addr = desktop.address.trim().toLowerCase();
  if (!addr) return null;
  const forms = (h: (typeof hosts)[number]) => {
    const t = h.sshTarget.toLowerCase();
    const u = h.sshUser ? `${h.sshUser.toLowerCase()}@` : "";
    const p = h.sshPort ? `:${h.sshPort}` : "";
    return [`${u}${t}${p}`, `${u}${t}`, t];
  };
  return hosts.find((h) => forms(h).includes(addr))?.id ?? null;
}

export class MetaStore {
  state: MetaState = emptyState();
  private readonly file: string;
  private listeners = new Set<() => void>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "meta.json");
    if (existsSync(this.file)) {
      try {
        this.state = parseState(JSON.parse(readFileSync(this.file, "utf8")));
      } catch (err) {
        throw new Error(`Corrupt meta file: ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  get exists(): boolean {
    return existsSync(this.file);
  }

  /** Called after every change (WebSocket broadcast "meta/updated") */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  save() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state), { encoding: "utf8", mode: 0o644 });
    renameSync(tmp, this.file);
    for (const fn of this.listeners) fn();
  }

  /** Live entries, filtered to the hosts a user may use (groups are global) */
  view(canUse: (hostId: string) => boolean): MetaView {
    const sessionMeta: Record<string, SessionMetaValue> = {};
    for (const [k, e] of Object.entries(this.state.sessions)) if (e.value && canUse(keyHost(k))) sessionMeta[k] = e.value;
    const groups = Object.values(this.state.groups)
      .map((e) => e.value)
      .filter((g): g is GroupValue => g !== null);
    const projects = Object.values(this.state.projects)
      .map((e) => e.value)
      .filter((p): p is ProjectValue => p !== null && canUse(p.hostId));
    return { sessionMeta, groups, projects };
  }

  /** Replace the metadata of a session (null or {} deletes it) */
  setSession(key: string, value: SessionMetaValue | null, now = Date.now()) {
    const live = value && Object.keys(value).length > 0 ? value : null;
    this.state.sessions[key] = { value: live, updatedAt: now };
    this.save();
  }

  setGroup(id: string, value: GroupValue | null, now = Date.now()) {
    this.state.groups[id] = { value, updatedAt: now };
    if (value === null) {
      // sessions of a deleted group fall back to "no group"
      for (const [k, e] of Object.entries(this.state.sessions)) {
        if (e.value && e.value.group === id) {
          const { group: _g, ...rest } = e.value;
          this.state.sessions[k] = { value: Object.keys(rest).length ? rest : null, updatedAt: now };
        }
      }
    }
    this.save();
  }

  setProject(id: string, value: ProjectValue | null, now = Date.now()) {
    this.state.projects[id] = { value, updatedAt: now };
    this.save();
  }

  /** Merge another state (desktop sync); saves and notifies when something changed */
  merge(incoming: MetaState): boolean {
    const changed = mergeState(this.state, incoming);
    if (changed) this.save();
    return changed;
  }
}

/**
 * One-time import of the config the old config-exchange version received from the desktop (store.config): session
 * metadata, groups and projects with the desktop's host ids mapped to webapp hosts.
 */
export function importLegacyConfig(
  meta: MetaStore,
  payload: { sessions: { id: string; name: string; color: string; group?: string; pinned: boolean }[]; groups: { id: string; name: string; color: string; collapsed: boolean }[]; projects: { id: string; name: string; hostId: string; dir: string }[]; hosts?: { id: string; name: string; address: string }[] },
  receivedAt: string,
  hosts: HostRecord[],
) {
  const at = Date.parse(receivedAt) || Date.now();
  const map = new Map<string, string>();
  for (const dh of payload.hosts ?? []) {
    const id = mapDesktopHost(dh, hosts);
    if (id) map.set(dh.id, id);
  }
  const incoming = emptyState();
  for (const s of payload.sessions) {
    const bar = s.id.indexOf("|");
    const host = map.get(s.id.slice(0, bar));
    if (bar < 0 || !host) continue;
    const value: SessionMetaValue = {};
    if (s.name) value.name = s.name;
    if (s.color) value.color = s.color;
    if (s.group) value.group = s.group;
    if (s.pinned) value.pinned = true;
    if (Object.keys(value).length) incoming.sessions[sessionKey(host, s.id.slice(bar + 1))] = { value, updatedAt: at };
  }
  for (const g of payload.groups) incoming.groups[g.id] = { value: { ...g }, updatedAt: at };
  for (const p of payload.projects) {
    const host = map.get(p.hostId);
    if (host) incoming.projects[p.id] = { value: { ...p, hostId: host, collapsed: false }, updatedAt: at };
  }
  meta.merge(incoming);
  if (!meta.exists) meta.save();
}
