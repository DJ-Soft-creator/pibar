// Data behind the session list: session lists of all hosts, the shared organisation (meta_get: session metadata,
// groups, projects), the colour descriptions of the shared settings, which sessions Pi is working on (pi_list plus
// the "activity" socket messages) and which finished unseen, and the user's own list settings (order, sections,
// filters, collapsed blocks – saved with the account, so every device shows the same list).
import { api, type Project, type SessionGroup, type SessionInfo, type SessionMeta } from "@shared/api";
import { errMsg } from "@shared/dom";
import { COLORS } from "@shared/sessionColors";
import type { SessionGroupBy, SessionSort } from "@shared/sessionOrder";
import { invoke } from "../bridge";
import { onSocketMessage, onSocketOpen } from "../socketBus";
import { currentRoute, saveSettings, settings, state } from "../state";

/** What meta_get answers (server meta.ts MetaView) */
export interface MetaView {
  sessionMeta: Record<string, SessionMeta & { remindAt?: number; remindNote?: string; project?: string }>;
  groups: SessionGroup[];
  projects: Project[];
}

export type FilterMode = "all" | "active";

/** The user's own settings of the list (Settings.sessionList) */
export interface ListPrefs {
  sort: Exclude<SessionSort, "own">;
  sections: SessionGroupBy;
  /** Host filter: "" = all hosts */
  host: string;
  filter: FilterMode;
  /** Colour filter: colour names or "none"; empty = every colour */
  colors: string[];
  /** Closed blocks and sections: "h:<host>", "p:<project>", "s:<block>|<by>|<key>", "rem", "hits", "projects" */
  collapsed: string[];
  /** Groups opened/closed per block ("<block>|<group id>" → closed); no entry = the group's default */
  groups: Record<string, boolean>;
}

const SORTS = ["activity", "created", "name", "folder"];
const SECTIONS = ["none", "date", "folder"];

export function prefs(): ListPrefs {
  const raw = (settings().sessionList ?? {}) as Partial<Record<keyof ListPrefs, unknown>>;
  const strList = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  const groups: Record<string, boolean> = {};
  if (raw.groups && typeof raw.groups === "object") {
    for (const [k, v] of Object.entries(raw.groups)) if (typeof v === "boolean") groups[k] = v;
  }
  return {
    sort: SORTS.includes(raw.sort as string) ? (raw.sort as ListPrefs["sort"]) : "activity",
    sections: SECTIONS.includes(raw.sections as string) ? (raw.sections as SessionGroupBy) : "date",
    host: typeof raw.host === "string" && state.hosts.some((h) => h.id === raw.host) ? raw.host : "",
    filter: raw.filter === "active" ? "active" : "all",
    colors: strList(raw.colors).filter((c) => c === "none" || (COLORS as readonly string[]).includes(c)),
    collapsed: strList(raw.collapsed),
    groups,
  };
}

let saveTimer = 0;
/** Change the list settings: applied at once, saved on the server after a short pause (several taps, one save) */
export function setPrefs(patch: Partial<ListPrefs>) {
  if (!state.me) return;
  state.me.settings = { ...state.me.settings, sessionList: { ...prefs(), ...patch } };
  rerender();
  clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveSettings({}).catch(() => {}), 400);
}

export function isCollapsed(id: string): boolean {
  return prefs().collapsed.includes(id);
}

export function toggleCollapsed(id: string) {
  const c = new Set(prefs().collapsed);
  if (c.has(id)) c.delete(id);
  else c.add(id);
  setPrefs({ collapsed: [...c] });
}

/** A group is closed in this block of the list; without an own choice it starts as the group was created */
export function groupClosed(block: string, g: SessionGroup): boolean {
  return prefs().groups[`${block}|${g.id}`] ?? !!g.collapsed;
}

export function toggleGroup(block: string, g: SessionGroup) {
  setPrefs({ groups: { ...prefs().groups, [`${block}|${g.id}`]: !groupClosed(block, g) } });
}

// ---------------------------------------------------------------- shared data

export const data = {
  meta: { sessionMeta: {}, groups: [], projects: [] } as MetaView,
  metaError: "",
  /** Colour name → own description (app_config_get sessionColorLabels) */
  labels: {} as Record<string, string>,
  /** Session keys where Pi works right now (webapp processes) */
  working: new Set<string>(),
  /** Session keys whose run finished while nobody looked (until opened) */
  unseen: new Set<string>(),
  /** Hosts whose list is loading */
  loading: new Set<string>(),
};

export const keyOf = (hostId: string, path: string) => `${hostId}|${path}`;

export function splitKey(key: string): { hostId: string; path: string } {
  const i = key.indexOf("|");
  return { hostId: key.slice(0, i), path: key.slice(i + 1) };
}

export function metaOf(key: string): MetaView["sessionMeta"][string] {
  return data.meta.sessionMeta[key] ?? {};
}

export function groups(): SessionGroup[] {
  return data.meta.groups;
}

export function projects(): Project[] {
  return data.meta.projects;
}

/** Title shown in the list: own name, otherwise Pi's name or the first message */
export function titleOf(hostId: string, s: Pick<SessionInfo, "path" | "name" | "title">): string {
  return metaOf(keyOf(hostId, s.path)).name?.trim() || s.name || s.title;
}

/** The session of a key in the loaded lists */
export function sessionOf(key: string): SessionInfo | undefined {
  const { hostId, path } = splitKey(key);
  return state.sessions.get(hostId)?.find((s) => s.path === path);
}

let render: (() => void) | null = null;
/** The list view registers itself; changes of the data draw it again while it is on screen */
export function setRenderer(fn: (() => void) | null) {
  render = fn;
}

export function rerender() {
  if (render && currentRoute() === "sessions") render();
}

export async function loadMeta() {
  try {
    data.meta = await invoke<MetaView>("meta_get");
    data.metaError = "";
  } catch (e) {
    data.metaError = errMsg(e);
  }
  rerender();
}

export async function loadLabels() {
  try {
    const cfg = await invoke<{ sessionColorLabels?: Record<string, string> }>("app_config_get");
    data.labels = cfg.sessionColorLabels ?? {};
  } catch {
    data.labels = {};
  }
  rerender();
}

interface PiInfo {
  hostId: string;
  sessionPath: string | null;
  alive: boolean;
  streaming: boolean;
}

export async function loadActivity() {
  try {
    const list = await invoke<PiInfo[]>("pi_list");
    data.working = new Set(
      list.filter((p) => p.alive && p.streaming && p.sessionPath).map((p) => keyOf(p.hostId, p.sessionPath ?? "")),
    );
  } catch {
    /* without pi_list the socket messages still mark what starts from now on */
  }
  rerender();
}

export async function loadHost(hostId: string) {
  if (data.loading.has(hostId)) return;
  data.loading.add(hostId);
  rerender();
  try {
    state.sessions.set(hostId, await api.listSessions(hostId));
    state.sessionErrors.delete(hostId);
  } catch (e) {
    state.sessionErrors.set(hostId, errMsg(e));
  }
  data.loading.delete(hostId);
  rerender();
}

/** Reload everything the list shows (pull to refresh, ↻) */
export function reloadAll() {
  void loadMeta();
  void loadActivity();
  for (const h of state.hosts) void loadHost(h.id);
}

/** The chat shows this session right now (a run that ends there is seen) */
function looking(key: string): boolean {
  const c = state.chat;
  return currentRoute() === "chat" && !!c?.path && keyOf(c.hostId, c.path) === key && document.visibilityState === "visible";
}

let wired = false;
/** Listen to the socket once: organisation changes, shared settings, activity of Pi processes */
export function wireData() {
  if (wired) return;
  wired = true;
  onSocketMessage((m) => {
    if (m.type === "meta/updated") void loadMeta();
    else if (m.type === "config/app-updated") void loadLabels();
    else if (m.type === "activity" && typeof m.hostId === "string" && typeof m.sessionPath === "string") {
      const key = keyOf(m.hostId, m.sessionPath);
      const was = data.working.has(key);
      if (m.alive && m.streaming) data.working.add(key);
      else data.working.delete(key);
      // an answer finished while nobody looked at it: mark it until the session is opened
      if (was && !data.working.has(key) && !looking(key)) data.unseen.add(key);
      // a new session got its file, or a run ended: the list (order, times) changed
      if (was !== data.working.has(key)) void loadHost(m.hostId);
      rerender();
    }
  });
  onSocketOpen(() => void loadActivity());
}

// ---------------------------------------------------------------- writing the organisation

type MetaPatch = Partial<MetaView["sessionMeta"][string]>;

/** One entry with the patch applied; empty values of the patch remove the field, other fields stay as they are */
export function applyPatch(cur: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> | null {
  const m: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "" || v === false || v === 0) delete m[k];
    else m[k] = v;
  }
  return Object.keys(m).length ? m : null;
}

/**
 * Change the metadata of sessions. The current entries are read fresh from the server first, so fields another
 * device or the desktop set meanwhile (model, preset, …) are kept; then every entry is written whole.
 */
export async function setMetaMany(keys: string[], patch: MetaPatch) {
  const fresh = await invoke<MetaView>("meta_get");
  for (const key of keys) {
    const next = applyPatch((fresh.sessionMeta[key] ?? {}) as Record<string, unknown>, patch as Record<string, unknown>);
    await invoke("meta_set_session", { key, meta: next });
    if (next) fresh.sessionMeta[key] = next;
    else delete fresh.sessionMeta[key];
  }
  data.meta = fresh;
  rerender();
}

export const setMeta = (key: string, patch: MetaPatch) => setMetaMany([key], patch);

/** Put entries back as they were (undo): null = no entry */
export async function restoreMeta(before: Map<string, Record<string, unknown> | null>) {
  for (const [key, meta] of before) await invoke("meta_set_session", { key, meta });
  await loadMeta();
}

export async function saveGroup(g: SessionGroup) {
  await invoke("meta_save_group", { group: g });
  await loadMeta();
}

export async function deleteGroup(id: string) {
  await invoke("meta_delete_group", { id });
  await loadMeta();
}

export async function saveProject(p: Project) {
  await invoke("meta_save_project", { project: p });
  await loadMeta();
}

export async function deleteProject(id: string) {
  await invoke("meta_delete_project", { id });
  await loadMeta();
}

/** Session opened: its "unread" and "finished unseen" marks go away */
export function markSeen(key: string) {
  data.unseen.delete(key);
  if (metaOf(key).unread) void setMeta(key, { unread: false }).catch(() => {});
}
