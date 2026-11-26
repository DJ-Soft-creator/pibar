// Two-way sync of the session-list organisation (session metadata, groups, projects) with the mobile webapp
// (task D3): POST /api/sync/meta with the webapp's API token (webapp/src/server/routes/tokens.ts). Runs at start,
// debounced after every config save, every 60 s and on "Sync now". Webapp URL, token and the on/off switch live in
// localStorage (never in the config file or the repository). The merge rules (updatedAt per entry, tombstones,
// newer wins) are in src/shared/metaSync.ts; the stamping hook runs before every save (configSync.ts).
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
import { onBeforeConfigSave, onConfigSaved, shouldAutoSync, trailingDebounce } from "./configSync";
import { saveConfig, state } from "./state";

const URL_KEY = "pibar.webappUrl";
const TOKEN_KEY = "pibar.webappToken";
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

/** API token of this desktop (created by an admin in the webapp: More → Desktop app tokens) */
export function webappToken(): string {
  return localStorage.getItem(TOKEN_KEY) ?? "";
}

export function setWebappToken(token: string) {
  const clean = token.trim();
  if (clean) localStorage.setItem(TOKEN_KEY, clean);
  else localStorage.removeItem(TOKEN_KEY);
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
  if (!url || !token) return report({ at: Date.now(), ok: false, error: "no webapp URL or token" });
  try {
    stampConfig();
    const hosts = state.config.hosts.map(hostInfo);
    const res = await fetch(`${url}/api/sync/meta`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(buildRequest(state.config, hosts)),
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* no JSON */
    }
    if (!res.ok) {
      const err = (data as { error?: unknown } | null)?.error;
      throw new Error(typeof err === "string" ? err : `HTTP ${res.status}`);
    }
    if (!isSyncResponse(data)) throw new Error("unexpected answer from the webapp");
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
