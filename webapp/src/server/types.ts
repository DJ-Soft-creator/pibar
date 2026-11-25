// Shared types of the webapp backend. ConfigPayload mirrors the desktop contract
// in src/main/configExchange.ts — do not change the shape.

export type Role = "admin" | "user";

export interface SessionConfig {
  /** Session key "<hostId>|<sessionPath>" */
  id: string;
  name: string;
  /** Colour NAME (red, orange, yellow, green, teal, blue, purple, pink) or "" */
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

export interface GroupConfig {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

export interface ConfigPayload {
  sessions: SessionConfig[];
  projects: ProjectConfig[];
  groups: GroupConfig[];
  meta: { generatedAt: string };
}

/** User shape exposed over the API — never includes salt/hash/tokens. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  host: string;
}
