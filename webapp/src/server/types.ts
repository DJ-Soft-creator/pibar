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

export type HostKind = "local" | "ssh";

/** Host entry of the sync contract (PiBar -> webapp). address is a display string. */
export interface HostInfo {
  id: string;
  name: string;
  kind: HostKind;
  /** ssh: "user@target[:port]", local: "" */
  address: string;
}

export type HostSource = "pibar" | "manual";

/** Host as stored and exposed by the webapp API (hosts.json). */
export interface HostRecord extends HostInfo {
  source: HostSource;
}

export interface ConfigPayload {
  sessions: SessionConfig[];
  projects: ProjectConfig[];
  groups: GroupConfig[];
  /** Optional since the hosts contract — payloads without hosts stay valid. */
  hosts?: HostInfo[];
  meta: { generatedAt: string };
}

/** User shape exposed over the API — never includes salt/hash/tokens. */
export interface PublicUser {
  id: string;
  username: string;
  role: Role;
  /** Hosts the user may work on (ignored for admins) */
  hostIds: string[];
}
