// Pi hosts of the webapp: the fields of HostCfg (src/shared/api.ts) the webapp needs, managed by the admin
// (hosts.json). Every host is reached over SSH from the container. Older hosts.json entries of the config-exchange
// version ({kind, address: "[user@]target[:port]", source}) are migrated on load.
import type { HostTarget } from "./host/hostexec.js";
import { isRecord, isString } from "./validation.js";

export interface HostRecord {
  id: string;
  name: string;
  /** SSH target: host name, IP or an alias of the container's ssh config */
  sshTarget: string;
  sshUser: string;
  sshPort: number | null;
  /** Command that starts Pi (default "pi") */
  piCommand: string;
  /** Preselected folder for new sessions ("" = home) */
  defaultDir: string;
  /** Colour profile of the chat on this host ("" = default) */
  colorProfile: string;
}

/** The fields an admin may set (everything but the id) */
export type HostInput = Omit<HostRecord, "id">;

export function toTarget(h: HostRecord): HostTarget {
  return { id: h.id, name: h.name, sshTarget: h.sshTarget, sshUser: h.sshUser, sshPort: h.sshPort, piCommand: h.piCommand };
}

/** "[user@]target[:port]" → parts (the address string of the old format) */
export function parseAddress(address: string): { sshUser: string; sshTarget: string; sshPort: number | null } {
  let rest = address.trim();
  let sshUser = "";
  const at = rest.lastIndexOf("@");
  if (at >= 0) {
    sshUser = rest.slice(0, at);
    rest = rest.slice(at + 1);
  }
  let sshPort: number | null = null;
  const m = /^(.*):(\d{1,5})$/.exec(rest);
  if (m && !rest.includes("]") && Number(m[2]) >= 1 && Number(m[2]) <= 65535) {
    rest = m[1] ?? "";
    sshPort = Number(m[2]);
  }
  return { sshUser, sshTarget: rest, sshPort };
}

/** A persisted host, or one of the old format migrated; null = broken */
export function parseHostRecord(value: unknown): { host: HostRecord; migrated: boolean } | null {
  if (!isRecord(value) || !isString(value.id) || !isString(value.name)) return null;
  if (isString(value.sshTarget)) {
    const port = value.sshPort;
    if (port !== null && port !== undefined && !(typeof port === "number" && Number.isInteger(port))) return null;
    const str = (k: string) => (isString(value[k]) ? (value[k] as string) : "");
    return {
      host: {
        id: value.id,
        name: value.name,
        sshTarget: value.sshTarget,
        sshUser: str("sshUser"),
        sshPort: typeof port === "number" ? port : null,
        piCommand: str("piCommand"),
        defaultDir: str("defaultDir"),
        colorProfile: str("colorProfile"),
      },
      migrated: false,
    };
  }
  // old format: { kind: "local" | "ssh", address, source }
  if (!isString(value.address)) return null;
  const parts = value.kind === "ssh" ? parseAddress(value.address) : { sshUser: "", sshTarget: "", sshPort: null };
  return {
    host: { id: value.id, name: value.name, ...parts, piCommand: "", defaultDir: "", colorProfile: "" },
    migrated: true,
  };
}

const USER_RE = /^[A-Za-z0-9._][A-Za-z0-9._-]*$/;
const TARGET_RE = /^[A-Za-z0-9._:[\]%-]+$/;

/**
 * Check a host request body. `partial` (PATCH): missing fields stay as they are. Returns the cleaned fields or an
 * error text. The SSH fields are checked strictly, because they end up on the ssh command line.
 */
export function validateHostInput(body: Record<string, unknown>, partial: boolean): Partial<HostInput> | string {
  const out: Partial<HostInput> = {};
  const has = (k: string) => body[k] !== undefined;
  if (has("name") || !partial) {
    if (!isString(body.name) || !body.name.trim()) return "name required";
    out.name = body.name.trim();
  }
  if (has("sshTarget") || !partial) {
    if (!isString(body.sshTarget) || !body.sshTarget.trim()) return "sshTarget required";
    const t = body.sshTarget.trim();
    if (t.startsWith("-") || !TARGET_RE.test(t)) return "sshTarget must be a host name, IP address or ssh alias";
    out.sshTarget = t;
  }
  if (has("sshUser")) {
    if (!isString(body.sshUser)) return "sshUser must be a string";
    const u = body.sshUser.trim();
    if (u && !USER_RE.test(u)) return "sshUser contains invalid characters";
    out.sshUser = u;
  } else if (!partial) out.sshUser = "";
  if (has("sshPort")) {
    const p = body.sshPort;
    if (p === null || p === "") out.sshPort = null;
    else if (typeof p === "number" && Number.isInteger(p) && p >= 1 && p <= 65535) out.sshPort = p;
    else return "sshPort must be a number between 1 and 65535";
  } else if (!partial) out.sshPort = null;
  for (const key of ["piCommand", "defaultDir", "colorProfile"] as const) {
    if (has(key)) {
      const v = body[key];
      if (!isString(v)) return `${key} must be a string`;
      out[key] = v.trim();
    } else if (!partial) out[key] = "";
  }
  return out;
}
