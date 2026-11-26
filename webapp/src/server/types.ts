// Shared types of the webapp backend. ConfigPayload is the payload of the old config-exchange version (desktop
// before the token sync); it is only read from an old config.json for the one-time import (meta.ts).

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

/** Host entry of the old config payload (also the host shape of the token sync, sync.ts DesktopHost) */
export interface HostInfo {
  id: string;
  name: string;
  kind: HostKind;
  /** ssh: "user@target[:port]", local: "" */
  address: string;
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
