// Two-way sync of the session-list organisation (session metadata, groups, projects) with the mobile webapp: the
// desktop signs in with a webapp user's name and password (POST /api/desktop/login) and gets an API token of that
// user; with it, it syncs that user's organisation (POST /api/sync/meta, webapp/src/server/routes/tokens.ts). All
// requests go through the Rust core (api.webappRequest, src-tauri/src/webapp.rs). Runs at start, debounced after
// every config save, every 60 s and on "Sync now". Webapp URL, token, user name and the on/off switch live in
// localStorage (never in the config file or the repository; the password is not kept). The merge rules (updatedAt
// per entry, tombstones, newer wins) are in src/shared/metaSync.ts; the stamping hook runs before every save
// (configSync.ts).
// Menu entries: src/main/configExchangeMenu.ts, dialogs and feedback: src/main/configExchangeTool.ts.
import {
  applyResponse,
  buildRequest,
  hostInfo,
  isSyncResponse,
  snapshot,
  stampChanges,
  type Snapshot,
} from "../shared/metaSync";
import { api } from "../shared/api";
import { onBeforeConfigSave, onConfigSaved, shouldAutoSync, trailingDebounce } from "./configSync";
import { saveConfig, state } from "./state";

const URL_KEY = "pibar.webappUrl";
const TOKEN_KEY = "pibar.webappToken";
const USER_KEY = "pibar.webappUser";
const AUTO_SYNC_KEY = "pibar.webappAutoSync";
const LAST_KEY = "pibar.webappLastSync";
/** Quiet period after the last config save before the sync runs */
const AUTO_SYNC_DELAY = 2000;
/** Regular sync, so changes from the phone arrive without a local change */
const SYNC_INTERVAL = 60_000;

/** Outcome of the last sync, shown in the settings */
export interface SyncResult {
  at: number;
  ok: boolean;
  error?: string;
  /** entries taken over from the webapp / removed because the webapp deleted them */
  updated?: number;
  removed?: number;
  /** names of desktop hosts without a matching webapp host (their sessions are not synced) */
  unmatched?: string[];
}

/** Base URL of the webapp, e.g. "http://192.168.1.20:8787"; "" = not configured */
export function webappUrl(): string {
  return localStorage.getItem(URL_KEY) ?? "";
}

/** Save the webapp URL (trimmed, without trailing slash); empty removes it */
export function setWebappUrl(url: string) {
  const clean = url.trim().replace(/\/+$/, "");
  if (clean) localStorage.setItem(URL_KEY, clean);
  else localStorage.removeItem(URL_KEY);
}

/** API token of this desktop, received at sign-in (the webapp lists it under More → Desktop apps) */
export function webappToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

/** Name of the webapp user this desktop is signed in as ("" = not signed in) */
export function webappUser(): string {
  return webappToken() ? (localStorage.getItem(USER_KEY) ?? "") : "";
}

/** Signed in: address and token are there */
export function signedIn(): boolean {
  return webappUrl() !== "" && webappToken() !== "";
}

function setSignIn(token: string, user: string) {
  if (token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(USER_KEY, user);
  } else {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
  }
}

/** The webapp's error text of an answer, or "HTTP <status>" */
function answerError(status: number, data: unknown): string {
  const err = (data as { error?: unknown } | null)?.error;
  return typeof err === "string" ? err : `HTTP ${status}`;
}

function parseBody(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

/**
 * Sign in to the webapp as one of its users: saves the address, receives an API token of that user (the password is
 * only sent, never kept). Returns the user name; throws with the webapp's error text.
 */
export async function signIn(url: string, username: string, password: string): Promise<string> {
  setWebappUrl(url);
  const base = webappUrl();
  const res = await api.webappRequest(
    base,
    "/api/desktop/login",
    "",
    JSON.stringify({ username: username.trim(), password }),
  );
  const data = parseBody(res.body) as { token?: unknown; username?: unknown } | null;
  if (res.status !== 201 || typeof data?.token !== "string") throw new Error(answerError(res.status, data));
  const user = typeof data.username === "string" ? data.username : username.trim();
  setSignIn(data.token, user);
  localStorage.removeItem(LAST_KEY);
  return user;
}

/** Sign out: the webapp revokes this desktop's token (when reachable); the token is forgotten here in any case */
export async function signOut(): Promise<void> {
  const token = webappToken();
  const base = webappUrl();
  setSignIn("", "");
  localStorage.removeItem(LAST_KEY);
  if (token && base) {
    try {
      await api.webappRequest(base, "/api/desktop/logout", token);
    } catch {
      /* offline: the token stays valid in the webapp until it is signed out there (More → Desktop apps) */
    }
  }
}

/** Whether the sync runs by itself (start, after saves, every minute) */
export function autoSyncEnabled(): boolean {
  return localStorage.getItem(AUTO_SYNC_KEY) === "1";
}

export function setAutoSyncEnabled(on: boolean) {
  if (on) localStorage.setItem(AUTO_SYNC_KEY, "1");
  else localStorage.removeItem(AUTO_SYNC_KEY);
}

export function lastSync(): SyncResult | null {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(LAST_KEY) ?? "null");
    return v && typeof v === "object" && typeof (v as SyncResult).at === "number" ? (v as SyncResult) : null;
  } catch {
    return null;
  }
}

const resultListeners = new Set<(r: SyncResult) => void>();

/** Follow the sync results (the settings dialog shows the last one); returns the unsubscribe function */
export function onSyncResult(cb: (r: SyncResult) => void): () => void {
  resultListeners.add(cb);
  return () => resultListeners.delete(cb);
}

function report(r: SyncResult): SyncResult {
  localStorage.setItem(LAST_KEY, JSON.stringify(r));
  for (const cb of resultListeners) cb(r);
  return r;
}

/** Snapshot of the organisation at the last stamp (null until wireConfigAutoSync ran) */
let snap: Snapshot | null = null;
/** True while a sync saves what it received: that save is no local change and needs no new sync */
let applying = false;
let running: Promise<SyncResult> | null = null;
let refreshUi: () => void = () => {};

/** Stamp local changes since the last look (updatedAt, tombstones); called before every config save */
export function stampConfig(): boolean {
  const r = stampChanges(state.config, snap);
  snap = r.snap;
  return r.changed;
}

async function runSync(): Promise<SyncResult> {
  const url = webappUrl();
  const token = webappToken();
  if (!url || !token) return report({ at: Date.now(), ok: false, error: "not signed in to the webapp" });
  try {
    stampConfig();
    const hosts = state.config.hosts.map(hostInfo);
    const res = await api.webappRequest(
      url,
      "/api/sync/meta",
      token,
      JSON.stringify(buildRequest(state.config, hosts)),
    );
    const data = parseBody(res.body);
    // the sign-in was revoked (signed out in the webapp, password changed, user deleted): forget it
    if (res.status === 401) setSignIn("", "");
    if (res.status !== 200) throw new Error(answerError(res.status, data));
    if (!isSyncResponse(data)) throw new Error("unexpected answer from the webapp");
    const user = (data as { user?: unknown }).user;
    if (typeof user === "string" && user) localStorage.setItem(USER_KEY, user);
    // changes made while the request was on its way are stamped first, so the answer cannot hide them
    stampConfig();
    const applied = applyResponse(state.config, data);
    snap = applied.snap;
    if (applied.updated || applied.removed) {
      applying = true;
      try {
        await saveConfig();
      } finally {
        applying = false;
      }
      refreshUi();
    }
    const names = new Map(state.config.hosts.map((h) => [h.id, h.name]));
    const unmatched = data.hosts.filter((h) => h.webappHost === null).map((h) => names.get(h.id) ?? h.id);
    return report({ at: Date.now(), ok: true, updated: applied.updated, removed: applied.removed, unmatched });
  } catch (e) {
    return report({ at: Date.now(), ok: false, error: e instanceof Error ? e.message : String(e) });
  }
}

/** Sync now (one at a time: a call during a running sync gets that sync's result) */
export function syncNow(): Promise<SyncResult> {
  running ??= runSync().finally(() => (running = null));
  return running;
}

/**
 * Register the sync (called once from index.ts after the config was loaded): stamps before every save, a debounced
 * sync after every save, one at the start and one every minute while it is switched on. Silent: results only reach
 * the settings (lastSync / onSyncResult) and the console.
 */
export function wireConfigAutoSync(refresh: () => void = () => {}) {
  refreshUi = refresh;
  // entries of the old config without a stamp count as current (see metaSync.stampChanges)
  snap = null;
  if (stampConfig()) void saveConfig();
  snap ??= snapshot(state.config);
  onBeforeConfigSave(() => {
    stampConfig();
  });
  const enabled = () => shouldAutoSync(autoSyncEnabled(), webappUrl()) && webappToken() !== "";
  const quiet = (r: SyncResult) => {
    if (!r.ok) console.warn("Webapp sync failed:", r.error);
  };
  const debounced = trailingDebounce(() => {
    if (enabled()) void syncNow().then(quiet);
  }, AUTO_SYNC_DELAY);
  onConfigSaved(() => {
    if (applying) return;
    if (enabled()) debounced.trigger();
    else debounced.cancel();
  });
  window.setInterval(() => {
    if (enabled()) void syncNow().then(quiet);
  }, SYNC_INTERVAL);
  if (enabled()) void syncNow().then(quiet);
}
