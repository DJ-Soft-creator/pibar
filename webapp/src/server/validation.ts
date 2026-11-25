// Runtime validation at the JSON boundaries (request bodies, persisted files).
import type { ConfigPayload, HostInfo, HostKind, HostRecord } from "./types.js";

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isString(value: unknown): value is string {
  return typeof value === "string";
}

function hasStrings(obj: Record<string, unknown>, keys: string[]): boolean {
  return keys.every((k) => isString(obj[k]));
}

/**
 * Full shape check of a ConfigPayload (contract of src/main/configExchange.ts):
 * arrays present, entries have string ids and the required fields.
 */
export function isConfigPayload(data: unknown): data is ConfigPayload {
  if (!isRecord(data)) return false;
  const { sessions, projects, groups, hosts, meta } = data;
  if (!Array.isArray(sessions) || !Array.isArray(projects) || !Array.isArray(groups)) return false;
  if (!isRecord(meta) || !isString(meta.generatedAt)) return false;
  for (const s of sessions) {
    if (!isRecord(s) || !hasStrings(s, ["id", "name", "color"])) return false;
    if (typeof s.pinned !== "boolean") return false;
    if (s.group !== undefined && !isString(s.group)) return false;
  }
  for (const p of projects) {
    if (!isRecord(p) || !hasStrings(p, ["id", "name", "hostId", "dir"])) return false;
  }
  for (const g of groups) {
    if (!isRecord(g) || !hasStrings(g, ["id", "name", "color"])) return false;
    if (typeof g.collapsed !== "boolean") return false;
  }
  // hosts is optional (older PiBar versions do not send it).
  if (hosts !== undefined && (!Array.isArray(hosts) || !hosts.every(isHostInfo))) return false;
  return true;
}

export function isHostKind(value: unknown): value is HostKind {
  return value === "local" || value === "ssh";
}

export function isHostInfo(value: unknown): value is HostInfo {
  return isRecord(value) && hasStrings(value, ["id", "name", "address"]) && isHostKind(value.kind);
}

export function isHostRecord(value: unknown): value is HostRecord {
  return (
    isRecord(value) &&
    (value.source === "pibar" || value.source === "manual") &&
    isHostInfo(value)
  );
}

export function isRole(value: unknown): value is "admin" | "user" {
  return value === "admin" || value === "user";
}
