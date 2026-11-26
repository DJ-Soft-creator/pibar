// REST calls of the webapp outside the command router: login, own account, hosts and users (admin).
// Errors reject with the server's error text (like bridge.ts); 401 calls the handler (→ login screen).
import type { HostRecord } from "../../src/server/hosts";
import { setUnauthorizedHandler } from "./bridge";

export type { HostRecord };

export type Role = "admin" | "user";

export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  hostIds: string[];
}

/** Own UI settings, stored on the server (the same on every device) */
export interface Settings {
  theme?: "auto" | "light" | "dark";
  language?: string;
  /** Host shown in the session list */
  hostId?: string;
  /** Text size in percent */
  textScale?: number;
  /** Session list: order, sections, filters, collapsed blocks (checked in views/sessionsData.ts) */
  sessionList?: Record<string, unknown>;
}

export interface Me {
  user: PublicUser;
  settings: Settings;
}

let unauthorized: (() => void) | null = null;

/** One handler for REST and command calls */
export function onUnauthorized(fn: () => void) {
  unauthorized = fn;
  setUnauthorizedHandler(fn);
}

export async function rest<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { "Content-Type": "application/json" } : {},
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new Error("Server not reachable");
  }
  let data: unknown = null;
  try {
    data = await res.json();
  } catch {
    /* no JSON */
  }
  if (res.status === 401 && path !== "/api/login") unauthorized?.();
  if (!res.ok) {
    const err = (data as { error?: unknown } | null)?.error;
    throw new Error(typeof err === "string" ? err : `HTTP ${res.status}`);
  }
  return data as T;
}

export const account = {
  login: (username: string, password: string) =>
    rest<{ username: string; role: Role }>("POST", "/api/login", { username, password }),
  logout: () => rest("POST", "/api/logout"),
  logoutAll: () => rest("POST", "/api/logout-all"),
  me: () => rest<Me>("GET", "/api/me"),
  saveSettings: (settings: Settings) => rest<{ settings: Settings }>("PUT", "/api/me/settings", { settings }),
  changePassword: (currentPassword: string, newPassword: string) =>
    rest("POST", "/api/me/password", { currentPassword, newPassword }),
};

export const hosts = {
  list: () => rest<HostRecord[]>("GET", "/api/hosts"),
  create: (h: Omit<HostRecord, "id">) => rest<HostRecord>("POST", "/api/hosts", h),
  update: (id: string, h: Partial<Omit<HostRecord, "id">>) => rest<HostRecord>("PATCH", `/api/hosts/${id}`, h),
  remove: (id: string) => rest("DELETE", `/api/hosts/${id}`),
};

export const users = {
  list: () => rest<PublicUser[]>("GET", "/api/users"),
  create: (u: { username: string; password: string; role: Role; hostIds: string[] }) =>
    rest<PublicUser>("POST", "/api/users", u),
  update: (id: string, u: { role?: Role; hostIds?: string[]; password?: string }) =>
    rest<PublicUser>("PATCH", `/api/users/${id}`, u),
  remove: (id: string) => rest("DELETE", `/api/users/${id}`),
};
