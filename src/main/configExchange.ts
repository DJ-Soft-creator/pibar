// Config exchange with the mobile webapp (webapp/): sends sessions, projects and groups there and imports them
// back. Data comes from state.config (no file access in the WebView); the webapp URL lives in localStorage.
// Menu entries: src/main/configExchangeMenu.ts, actions and dialogs: src/main/configExchangeTool.ts.
import type { SessionGroup } from "../shared/api";
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

export interface ConfigPayload {
  sessions: SessionConfig[];
  projects: ProjectConfig[];
  groups: SessionGroup[];
  meta: { generatedAt: string };
}

const URL_KEY = "pibar.webappUrl";

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

/** Sessions, projects and groups of the current config as an exchange payload */
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
  return { sessions, projects, groups: cfg.groups, meta: { generatedAt: new Date().toISOString() } };
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
  return Array.isArray(p.sessions) && Array.isArray(p.projects) && Array.isArray(p.groups);
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
