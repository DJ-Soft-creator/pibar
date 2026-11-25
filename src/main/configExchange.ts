// Config exchange with the mobile webapp (webapp/): sends sessions, projects, groups and hosts there and
// imports sessions/projects/groups back (hosts stay managed in PiBar). Data comes from state.config (no file
// access in the WebView); the webapp URL and the auto-sync toggle live in localStorage. Auto-sync: a silent,
// debounced send after every config save, registered on the listener registry in src/main/configSync.ts.
// Menu entries: src/main/configExchangeMenu.ts, actions and dialogs: src/main/configExchangeTool.ts.
import type { HostCfg, SessionGroup } from "../shared/api";
import { onConfigSaved, shouldAutoSync, trailingDebounce } from "./configSync";
import { saveConfig, state } from "./state";

export interface SessionConfig {
  /** Session key "<hostId>|<sessionPath>" (key in AppConfig.sessionMeta) */
  id: string;
  name: string;
  /** Colour name, see COLORS in src/shared/sessionColors.ts; "" = none */
  color: string;
  group?: string;
  pinned: boolean;
}

export interface ProjectConfig {
  id: string;
  name: string;
  hostId: string;
  dir: string;
}

/** A host as the webapp sees it: only id, name, kind and a display address (no commands or folders) */
export interface HostInfo {
  id: string;
  name: string;
  kind: "local" | "ssh";
  /** ssh: "[user@]target[:port]"; local: "" */
  address: string;
}

export interface ConfigPayload {
  sessions: SessionConfig[];
  projects: ProjectConfig[];
  groups: SessionGroup[];
  /** Optional: older webapps and payloads without hosts stay valid */
  hosts?: HostInfo[];
  meta: { generatedAt: string };
}

const URL_KEY = "pibar.webappUrl";
const AUTO_SYNC_KEY = "pibar.webappAutoSync";
/** Quiet period after the last config save before the auto-sync sends */
const AUTO_SYNC_DELAY = 2000;

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

/** Whether the config is sent to the webapp automatically after every save */
export function autoSyncEnabled(): boolean {
  return localStorage.getItem(AUTO_SYNC_KEY) === "1";
}

/** Save the auto-sync toggle (off removes the key) */
export function setAutoSyncEnabled(on: boolean) {
  if (on) localStorage.setItem(AUTO_SYNC_KEY, "1");
  else localStorage.removeItem(AUTO_SYNC_KEY);
}

/** Map a host of the settings to the exchange shape: ssh gets "[user@]target[:port]", local an empty address */
export function hostInfo(h: Pick<HostCfg, "id" | "name" | "kind" | "sshTarget" | "sshUser" | "sshPort">): HostInfo {
  const address =
    h.kind === "ssh" ? (h.sshUser ? `${h.sshUser}@` : "") + h.sshTarget + (h.sshPort ? `:${h.sshPort}` : "") : "";
  return { id: h.id, name: h.name, kind: h.kind, address };
}

/** Sessions, projects, groups and hosts of the current config as an exchange payload */
export function loadConfig(): ConfigPayload {
  const cfg = state.config;
  const sessions: SessionConfig[] = Object.entries(cfg.sessionMeta).map(([id, m]) => ({
    id,
    name:
      m.name ??
      id
        .split("|")
        .pop()
        ?.split("/")
        .pop()
        ?.replace(/\.jsonl$/i, "") ??
      id,
    color: m.color ?? "",
    group: m.group,
    pinned: Boolean(m.pinned),
  }));
  const projects: ProjectConfig[] = (cfg.projects ?? []).map((p) => ({
    id: p.id,
    name: p.name,
    hostId: p.hostId,
    dir: p.dir,
  }));
  const hosts: HostInfo[] = cfg.hosts.map(hostInfo);
  return { sessions, projects, groups: cfg.groups, hosts, meta: { generatedAt: new Date().toISOString() } };
}

/**
 * Register the auto-sync (called once from index.ts): every config save resets a trailing-edge debounce;
 * after AUTO_SYNC_DELAY of quiet the payload is sent silently (failures only reach the console, no toasts).
 * The decision is checked again when the timer fires, so a toggle/URL change during the wait stops the send.
 */
export function wireConfigAutoSync() {
  const send = trailingDebounce(() => {
    if (!shouldAutoSync(autoSyncEnabled(), webappUrl())) return;
    sendToWebapp(loadConfig()).catch((e) => console.warn("Webapp auto-sync failed:", e));
  }, AUTO_SYNC_DELAY);
  onConfigSaved(() => {
    if (shouldAutoSync(autoSyncEnabled(), webappUrl())) send.trigger();
    else send.cancel();
  });
}

/** POST the payload to the webapp; throws when no URL is set or the webapp refuses */
export async function sendToWebapp(config: ConfigPayload): Promise<void> {
  const url = webappUrl();
  if (!url) throw new Error("no webapp URL");
  const res = await fetch(`${url}/api/config`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

/** GET the last payload the webapp received; throws when it is unreachable or has none */
export async function fetchFromWebapp(): Promise<ConfigPayload> {
  const url = webappUrl();
  if (!url) throw new Error("no webapp URL");
  const res = await fetch(`${url}/api/config`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: unknown = await res.json();
  if (!isPayload(data)) throw new Error("no config on the webapp yet");
  return data;
}

/** Shape check of a payload from the webapp (its JSON is untyped) */
function isPayload(data: unknown): data is ConfigPayload {
  if (typeof data !== "object" || data === null) return false;
  const p = data as Partial<ConfigPayload>;
  return (
    Array.isArray(p.sessions) &&
    Array.isArray(p.projects) &&
    Array.isArray(p.groups) &&
    (p.hosts === undefined || Array.isArray(p.hosts))
  );
}

/**
 * Merge a payload into the config: only entries whose id/key is still unknown are added, nothing is overwritten.
 * Returns how many sessions, groups and projects were added; saves the config when anything changed.
 */
export async function importSessionConfig(
  config: ConfigPayload,
): Promise<{ sessions: number; groups: number; projects: number }> {
  const cfg = state.config;
  const added = { sessions: 0, groups: 0, projects: 0 };
  for (const s of config.sessions) {
    if (!s.id || cfg.sessionMeta[s.id]) continue;
    cfg.sessionMeta[s.id] = {
      name: s.name,
      color: s.color || undefined,
      group: s.group,
      pinned: s.pinned || undefined,
    };
    added.sessions++;
  }
  for (const g of config.groups) {
    if (!g.id || cfg.groups.some((x) => x.id === g.id)) continue;
    cfg.groups.push(g);
    added.groups++;
  }
  cfg.projects ??= [];
  for (const p of config.projects) {
    if (!p.id || cfg.projects.some((x) => x.id === p.id)) continue;
    cfg.projects.push({ id: p.id, name: p.name, hostId: p.hostId, dir: p.dir, collapsed: false });
    added.projects++;
  }
  if (added.sessions || added.groups || added.projects) await saveConfig();
  return added;
}
