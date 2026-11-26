// Two-way sync of the session-list organisation with a PiBar desktop (task D2): the request/answer shape of
// POST /api/sync/meta (routes/tokens.ts) and the conversion between the desktop's host ids and the webapp's.
// Pure logic, no I/O. The merge itself is MetaStore.merge (per entry the newer updatedAt wins).
//
// The desktop keys sessions as "<desktop host id>|<path>" and projects carry a desktop host id; both are mapped with
// mapDesktopHost (same name or same SSH address). Entries of hosts without a match are neither taken nor answered.
// Groups are global.
import type { HostRecord } from "./hosts.js";
import { emptyState, mapDesktopHost, sessionKey, type Entry, type GroupValue, type MetaState, type ProjectValue, type SessionMetaValue } from "./meta.js";
import { isHostKind, isRecord, isString } from "./validation.js";

/** A desktop clock this far ahead is not trusted: its entries count as written now */
export const MAX_CLOCK_SKEW_MS = 5 * 60_000;
const LIMITS = { hosts: 200, sessions: 50_000, groups: 2_000, projects: 2_000, valueBytes: 32 * 1024 };

export interface DesktopHost {
  id: string;
  name: string;
  kind: "local" | "ssh";
  address: string;
}

export interface Tombstone {
  /** session key or group/project id */
  key: string;
  updatedAt: number;
}

/** Body of POST /api/sync/meta (see webapp/README.md) */
export interface SyncRequest {
  hosts: DesktopHost[];
  sessionMeta: Record<string, Record<string, unknown>>;
  groups: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  deleted: { sessions: Tombstone[]; groups: Tombstone[]; projects: Tombstone[] };
}

/** Answer: the merged state for the desktop's mapped hosts, in the desktop's ids */
export interface SyncResponse {
  sessionMeta: Record<string, Record<string, unknown>>;
  groups: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  deleted: {
    sessions: { key: string; updatedAt: number }[];
    groups: { id: string; updatedAt: number }[];
    projects: { id: string; updatedAt: number }[];
  };
  /** Per desktop host: the webapp host it was matched with (name), null = not synced */
  hosts: { id: string; webappHost: string | null }[];
  serverTime: number;
}

export interface HostMapping {
  /** desktop host id → webapp host id */
  toWeb: Map<string, string>;
  /** webapp host id → desktop host id (first desktop host wins) */
  toDesktop: Map<string, string>;
}

function tombstones(v: unknown, keyName: "key" | "id", limit: number): Tombstone[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return `deleted entries must be an array`;
  if (v.length > limit) return "too many deleted entries";
  const out: Tombstone[] = [];
  for (const t of v) {
    if (!isRecord(t) || !isString(t[keyName]) || !t[keyName] || typeof t.updatedAt !== "number") {
      return `deleted entries need ${keyName} and updatedAt`;
    }
    out.push({ key: t[keyName], updatedAt: t.updatedAt });
  }
  return out;
}

function records(v: unknown, what: string, limit: number): Record<string, unknown>[] | string {
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every(isRecord)) return `${what} must be an array of objects`;
  if (v.length > limit) return `too many ${what}`;
  return v;
}

/** Check a request body; returns the parsed request or an error text (400) */
export function parseSyncRequest(body: unknown): SyncRequest | string {
  if (!isRecord(body)) return "Expected a JSON object";
  if (!Array.isArray(body.hosts)) return "hosts must be an array";
  if (body.hosts.length > LIMITS.hosts) return "too many hosts";
  const hosts: DesktopHost[] = [];
  for (const h of body.hosts) {
    if (!isRecord(h) || !isString(h.id) || !isString(h.name) || !isString(h.address) || !isHostKind(h.kind)) {
      return "hosts need id, name, kind (local|ssh) and address";
    }
    hosts.push({ id: h.id, name: h.name, kind: h.kind, address: h.address });
  }
  const sm = body.sessionMeta ?? {};
  if (!isRecord(sm)) return "sessionMeta must be an object";
  const entries = Object.entries(sm);
  if (entries.length > LIMITS.sessions) return "too many sessions";
  const sessionMeta: Record<string, Record<string, unknown>> = {};
  for (const [k, v] of entries) {
    if (!isRecord(v)) return "sessionMeta values must be objects";
    if (JSON.stringify(v).length > LIMITS.valueBytes) return "sessionMeta entry too large";
    sessionMeta[k] = v;
  }
  const groups = records(body.groups, "groups", LIMITS.groups);
  if (typeof groups === "string") return groups;
  for (const g of groups) if (!isString(g.id) || !g.id || !isString(g.name)) return "groups need id and name";
  const projects = records(body.projects, "projects", LIMITS.projects);
  if (typeof projects === "string") return projects;
  for (const p of projects) {
    if (!isString(p.id) || !p.id || !isString(p.name) || !isString(p.hostId) || !isString(p.dir)) {
      return "projects need id, name, hostId and dir";
    }
  }
  const del = body.deleted ?? {};
  if (!isRecord(del)) return "deleted must be an object";
  const ds = tombstones(del.sessions, "key", LIMITS.sessions);
  if (typeof ds === "string") return ds;
  const dg = tombstones(del.groups, "id", LIMITS.groups);
  if (typeof dg === "string") return dg;
  const dp = tombstones(del.projects, "id", LIMITS.projects);
  if (typeof dp === "string") return dp;
  return { hosts, sessionMeta, groups, projects, deleted: { sessions: ds, groups: dg, projects: dp } };
}

export function hostMapping(hosts: DesktopHost[], webHosts: HostRecord[]): HostMapping {
  const toWeb = new Map<string, string>();
  const toDesktop = new Map<string, string>();
  for (const h of hosts) {
    const id = mapDesktopHost(h, webHosts);
    if (!id) continue;
    toWeb.set(h.id, id);
    if (!toDesktop.has(id)) toDesktop.set(id, h.id);
  }
  return { toWeb, toDesktop };
}

/** A sane timestamp: not negative, not further ahead than the allowed clock skew */
export function clampTime(t: unknown, now: number): number {
  if (typeof t !== "number" || !Number.isFinite(t) || t < 0) return 0;
  return t > now + MAX_CLOCK_SKEW_MS ? now : Math.floor(t);
}

/** Fields whose empty value means something (tools: [] = no tools, temperature: 0 is a value) */
const MEANINGFUL_EMPTY = new Set(["tools", "temperature"]);

/**
 * Session metadata as the webapp keeps it: without updatedAt and without the defaults the desktop's Rust core writes
 * for every field ("" / false / 0 / []), so both sides compare and display the same. {} = nothing left.
 */
export function cleanSessionValue(v: Record<string, unknown>): SessionMetaValue {
  const out: SessionMetaValue = {};
  for (const [k, x] of Object.entries(v)) {
    if (k === "updatedAt" || x === undefined || x === null) continue;
    if (!MEANINGFUL_EMPTY.has(k) && (x === "" || x === false || x === 0 || (Array.isArray(x) && x.length === 0))) continue;
    out[k] = x;
  }
  return out;
}

/** Split a session key "<host>|<path>" (null = no bar) */
function splitKey(key: string): [string, string] | null {
  const bar = key.indexOf("|");
  return bar > 0 ? [key.slice(0, bar), key.slice(bar + 1)] : null;
}

/** The desktop's request as a MetaState in webapp ids (entries of unmapped hosts are dropped) */
export function incomingState(req: SyncRequest, map: HostMapping, now = Date.now()): MetaState {
  const st = emptyState();
  const webKey = (deskKey: string) => {
    const parts = splitKey(deskKey);
    const host = parts && map.toWeb.get(parts[0]);
    return parts && host ? sessionKey(host, parts[1]) : null;
  };
  const put = <T>(section: Record<string, Entry<T>>, key: string, e: Entry<T>) => {
    // the same entry twice (live and deleted): the newer one counts
    const cur = section[key];
    if (!cur || e.updatedAt > cur.updatedAt) section[key] = e;
  };
  for (const [k, v] of Object.entries(req.sessionMeta)) {
    const key = webKey(k);
    if (!key) continue;
    const value = cleanSessionValue(v);
    put(st.sessions, key, { value: Object.keys(value).length ? value : null, updatedAt: clampTime(v.updatedAt, now) });
  }
  for (const t of req.deleted.sessions) {
    const key = webKey(t.key);
    if (key) put(st.sessions, key, { value: null, updatedAt: clampTime(t.updatedAt, now) });
  }
  for (const g of req.groups) {
    const { updatedAt, ...rest } = g;
    const value: GroupValue = {
      ...rest,
      id: String(g.id),
      name: String(g.name),
      color: isString(g.color) ? g.color : "",
      collapsed: g.collapsed === true,
    };
    put(st.groups, value.id, { value, updatedAt: clampTime(updatedAt, now) });
  }
  for (const t of req.deleted.groups) put(st.groups, t.key, { value: null, updatedAt: clampTime(t.updatedAt, now) });
  for (const p of req.projects) {
    const host = map.toWeb.get(String(p.hostId));
    if (!host) continue;
    const { updatedAt, ...rest } = p;
    const value: ProjectValue = {
      ...rest,
      id: String(p.id),
      name: String(p.name),
      hostId: host,
      dir: String(p.dir),
      collapsed: p.collapsed === true,
    };
    put(st.projects, value.id, { value, updatedAt: clampTime(updatedAt, now) });
  }
  for (const t of req.deleted.projects) put(st.projects, t.key, { value: null, updatedAt: clampTime(t.updatedAt, now) });
  return st;
}

/** The merged state for the desktop: its host ids, only mapped hosts (groups and project tombstones: all) */
export function outgoingPayload(state: MetaState, map: HostMapping, hosts: DesktopHost[], webHosts: HostRecord[], now = Date.now()): SyncResponse {
  const out: SyncResponse = {
    sessionMeta: {},
    groups: [],
    projects: [],
    deleted: { sessions: [], groups: [], projects: [] },
    hosts: hosts.map((h) => {
      const web = map.toWeb.get(h.id);
      return { id: h.id, webappHost: web ? (webHosts.find((w) => w.id === web)?.name ?? null) : null };
    }),
    serverTime: now,
  };
  for (const [k, e] of Object.entries(state.sessions)) {
    const parts = splitKey(k);
    const desk = parts && map.toDesktop.get(parts[0]);
    if (!parts || !desk) continue;
    const key = `${desk}|${parts[1]}`;
    if (e.value) out.sessionMeta[key] = { ...e.value, updatedAt: e.updatedAt };
    else out.deleted.sessions.push({ key, updatedAt: e.updatedAt });
  }
  for (const [id, e] of Object.entries(state.groups)) {
    if (e.value) out.groups.push({ ...e.value, updatedAt: e.updatedAt });
    else out.deleted.groups.push({ id, updatedAt: e.updatedAt });
  }
  for (const [id, e] of Object.entries(state.projects)) {
    if (!e.value) {
      out.deleted.projects.push({ id, updatedAt: e.updatedAt });
      continue;
    }
    const desk = map.toDesktop.get(e.value.hostId);
    if (desk) out.projects.push({ ...e.value, hostId: desk, updatedAt: e.updatedAt });
  }
  return out;
}
