// Client state and routing: who is logged in, own settings (saved on the server), the hosts the user may use,
// the session lists per host, and the hash route (#/sessions, #/more, #/admin/hosts …) so the back button works.
import type { SessionInfo } from "@shared/api";
import { setLang } from "@shared/i18n";
import { applyTheme } from "@shared/theme";
import { account, type HostRecord, type Me, type Settings } from "./rest";

export type Route =
  | "sessions"
  | "chat"
  | "files"
  | "more"
  | "admin/hosts"
  | "admin/users"
  | "admin/presets"
  | "admin/quick-actions"
  | "admin/colors"
  | "admin/voice"
  | "admin/tokens";

/** The session shown in the chat tab; path null = a new session (Pi creates the file with the first message) */
export interface ChatTarget {
  hostId: string;
  hostName: string;
  path: string | null;
  cwd: string;
  title: string;
}

const ROUTES: Route[] = [
  "sessions",
  "chat",
  "files",
  "more",
  "admin/hosts",
  "admin/users",
  "admin/presets",
  "admin/quick-actions",
  "admin/colors",
  "admin/voice",
  "admin/tokens",
];

export const state = {
  me: null as Me | null,
  hosts: [] as HostRecord[],
  /** Session lists per host id, null = not loaded yet */
  sessions: new Map<string, SessionInfo[]>(),
  /** Errors of the last load per host id */
  sessionErrors: new Map<string, string>(),
  /** WebSocket connected */
  online: true,
  /** The open chat */
  chat: null as ChatTarget | null,
};

const CHAT_KEY = "pibar.chat";

/** Open a session in the chat tab (remembered in this browser, so a reload opens it again) */
export function openChat(target: ChatTarget) {
  state.chat = target;
  rememberChat();
  if (currentRoute() === "chat") window.dispatchEvent(new HashChangeEvent("hashchange"));
  else go("chat");
}

/** Keep the open chat for the next visit of this browser */
export function rememberChat() {
  try {
    if (state.chat) localStorage.setItem(CHAT_KEY, JSON.stringify(state.chat));
  } catch {
    /* private mode: only until the reload */
  }
}

/** The chat of the last visit, if its host is still allowed */
export function restoreChat() {
  try {
    const raw = localStorage.getItem(CHAT_KEY);
    const c = raw ? (JSON.parse(raw) as ChatTarget) : null;
    if (c && state.hosts.some((h) => h.id === c.hostId)) state.chat = c;
  } catch {
    /* nothing remembered */
  }
}

export function isAdmin(): boolean {
  return state.me?.user.role === "admin";
}

export function settings(): Settings {
  return state.me?.settings ?? {};
}

/** Apply theme, language and text size of the settings to the page */
export function applySettings() {
  const s = settings();
  setLang(s.language);
  applyTheme(s.theme);
  document.documentElement.style.fontSize = `${Math.round((s.textScale ?? 100) * 0.16)}px`;
}

/** Change own settings: applied at once, saved on the server */
export async function saveSettings(patch: Partial<Settings>) {
  if (!state.me) return;
  state.me.settings = { ...state.me.settings, ...patch };
  applySettings();
  await account.saveSettings(state.me.settings);
}

/** The host shown in the session list: the saved one if still allowed, else the first */
export function currentHost(): HostRecord | null {
  const id = settings().hostId;
  return state.hosts.find((h) => h.id === id) ?? state.hosts[0] ?? null;
}

export function currentRoute(): Route {
  const r = location.hash.replace(/^#\/?/, "") as Route;
  return ROUTES.includes(r) ? r : "sessions";
}

export function go(route: Route) {
  if (currentRoute() === route && location.hash) return;
  location.hash = `#/${route}`;
}
