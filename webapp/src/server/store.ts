// JSON-file persistence under DATA_DIR. Every write is atomic (tmp file + rename). config.json (what the old
// config-exchange version received from the desktop) is only read, for the one-time import into meta.json.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { parseHostRecord, type HostRecord } from "./hosts.js";
import type { ConfigPayload, Role } from "./types.js";
import { isConfigPayload, isRecord, isRole, isString } from "./validation.js";

export interface UserRecord {
  id: string;
  username: string;
  /** hex-encoded per-user salt */
  salt: string;
  /** hex-encoded scrypt hash */
  hash: string;
  role: Role;
  /** Hosts the user may work on (admins: every host, the list is ignored) */
  hostIds: string[];
  /** Own UI settings (theme, language, chat mode, text size …), the same on every device */
  settings: Record<string, unknown>;
}

export interface StoredConfig {
  payload: ConfigPayload;
  receivedAt: string;
}

export interface TokenRecord {
  userId: string;
  /** Epoch ms when the token was issued (TTL pruning). */
  createdAt: number;
}

/** Tokens expire after 30 days; pruned on load and on every save. */
export const TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Check a persisted user and bring older formats up to date: `host: string` (one assigned host) becomes
 * `hostIds`, missing `settings` become {}. Returns null for a broken entry.
 */
export function parseUserRecord(value: unknown): { user: UserRecord; migrated: boolean } | null {
  if (
    !isRecord(value) ||
    !isString(value.id) ||
    !isString(value.username) ||
    !isString(value.salt) ||
    !isString(value.hash) ||
    !isRole(value.role)
  ) {
    return null;
  }
  let migrated = false;
  let hostIds: string[];
  if (Array.isArray(value.hostIds) && value.hostIds.every(isString)) {
    hostIds = value.hostIds;
  } else if (value.hostIds === undefined && (value.host === undefined || isString(value.host))) {
    hostIds = isString(value.host) && value.host ? [value.host] : [];
    migrated = true;
  } else {
    return null;
  }
  let settings: Record<string, unknown> = {};
  if (isRecord(value.settings)) settings = value.settings;
  else if (value.settings === undefined) migrated = true;
  else return null;
  const { id, username, salt, hash, role } = value;
  return { user: { id, username, salt, hash, role, hostIds, settings }, migrated };
}

function readJson(file: string): unknown {
  if (!existsSync(file)) return null;
  const raw = readFileSync(file, "utf8");
  try {
    return JSON.parse(raw) as unknown;
  } catch (err) {
    throw new Error(`Corrupt JSON in ${file}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function writeJsonAtomic(file: string, data: unknown, mode: number): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: "utf8", mode });
  renameSync(tmp, file);
}

export class Store {
  readonly users = new Map<string, UserRecord>();
  /** token -> { userId, createdAt } */
  readonly tokens = new Map<string, TokenRecord>();
  readonly hosts = new Map<string, HostRecord>();
  /** config.json of the old config-exchange version, read once for importLegacyConfig (meta.ts); never written */
  legacyConfig: StoredConfig | null = null;

  private readonly usersFile: string;
  private readonly tokensFile: string;
  private readonly configFile: string;
  private readonly hostsFile: string;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.usersFile = join(dataDir, "users.json");
    this.tokensFile = join(dataDir, "tokens.json");
    this.configFile = join(dataDir, "config.json");
    this.hostsFile = join(dataDir, "hosts.json");
    this.load();
  }

  private load(): void {
    const users = readJson(this.usersFile);
    if (users !== null) {
      if (!Array.isArray(users)) throw new Error(`Corrupt users file: ${this.usersFile}`);
      let migrated = false;
      for (const raw of users) {
        const parsed = parseUserRecord(raw);
        if (!parsed) throw new Error(`Corrupt users file: ${this.usersFile}`);
        this.users.set(parsed.user.id, parsed.user);
        migrated ||= parsed.migrated;
      }
      if (migrated) this.persistUsers();
    }
    const tokens = readJson(this.tokensFile);
    if (tokens !== null) {
      if (!isRecord(tokens)) {
        throw new Error(`Corrupt tokens file: ${this.tokensFile}`);
      }
      for (const [token, value] of Object.entries(tokens)) {
        let record: TokenRecord;
        if (isString(value)) {
          // Legacy format (token -> userId): grant a fresh TTL on migration.
          record = { userId: value, createdAt: Date.now() };
        } else if (
          isRecord(value) &&
          isString(value.userId) &&
          typeof value.createdAt === "number" &&
          Number.isFinite(value.createdAt)
        ) {
          record = { userId: value.userId, createdAt: value.createdAt };
        } else {
          throw new Error(`Corrupt tokens file: ${this.tokensFile}`);
        }
        if (this.users.has(record.userId)) this.tokens.set(token, record);
      }
      this.pruneTokens();
    }
    const config = readJson(this.configFile);
    if (config !== null) {
      if (!isRecord(config) || !isString(config.receivedAt) || !isConfigPayload(config.payload)) {
        throw new Error(`Corrupt config file: ${this.configFile}`);
      }
      this.legacyConfig = { payload: config.payload, receivedAt: config.receivedAt };
    }
    const hosts = readJson(this.hostsFile);
    if (hosts !== null) {
      if (!Array.isArray(hosts)) throw new Error(`Corrupt hosts file: ${this.hostsFile}`);
      let migrated = false;
      for (const raw of hosts) {
        const parsed = parseHostRecord(raw);
        if (!parsed) throw new Error(`Corrupt hosts file: ${this.hostsFile}`);
        this.hosts.set(parsed.host.id, parsed.host);
        migrated ||= parsed.migrated;
      }
      if (migrated) this.persistHosts();
    }
  }

  private persistUsers(): void {
    // Secrets: owner-only read/write.
    writeJsonAtomic(this.usersFile, [...this.users.values()], 0o600);
  }

  private persistTokens(): void {
    this.pruneTokens();
    writeJsonAtomic(this.tokensFile, Object.fromEntries(this.tokens), 0o600);
  }

  private pruneTokens(): void {
    const now = Date.now();
    for (const [token, record] of this.tokens) {
      if (now - record.createdAt >= TOKEN_TTL_MS) this.tokens.delete(token);
    }
  }

  findUserByName(username: string): UserRecord | undefined {
    for (const u of this.users.values()) if (u.username === username) return u;
    return undefined;
  }

  saveUser(user: UserRecord): void {
    this.users.set(user.id, user);
    this.persistUsers();
  }

  deleteUser(id: string): void {
    this.users.delete(id);
    this.persistUsers();
    this.deleteUserTokens(id);
  }

  /** Revoke every token of a user (delete, password reset). */
  deleteUserTokens(id: string): void {
    for (const [token, record] of this.tokens) {
      if (record.userId === id) this.tokens.delete(token);
    }
    this.persistTokens();
  }

  addToken(token: string, userId: string): void {
    this.tokens.set(token, { userId, createdAt: Date.now() });
    this.persistTokens();
  }

  removeToken(token: string): void {
    this.tokens.delete(token);
    this.persistTokens();
  }

  userForToken(token: string): UserRecord | undefined {
    const record = this.tokens.get(token);
    if (record === undefined) return undefined;
    if (Date.now() - record.createdAt >= TOKEN_TTL_MS) {
      this.tokens.delete(token);
      return undefined;
    }
    return this.users.get(record.userId);
  }

  // ---------------------------------------------------------------- hosts

  sortedHosts(): HostRecord[] {
    return [...this.hosts.values()].sort((a, b) => a.name.localeCompare(b.name, "de"));
  }

  /** Case-insensitive name lookup (host names are unique). */
  findHostByName(name: string): HostRecord | undefined {
    const needle = name.toLowerCase();
    for (const h of this.hosts.values()) if (h.name.toLowerCase() === needle) return h;
    return undefined;
  }

  saveHost(host: HostRecord): void {
    this.hosts.set(host.id, host);
    this.persistHosts();
  }

  /** Delete a host and take it out of every user's host list. */
  deleteHost(id: string): void {
    this.hosts.delete(id);
    this.persistHosts();
    // nobody keeps a right on a host that is gone
    let changed = false;
    for (const u of this.users.values()) {
      if (u.hostIds.includes(id)) {
        u.hostIds = u.hostIds.filter((h) => h !== id);
        changed = true;
      }
    }
    if (changed) this.persistUsers();
  }

  private persistHosts(): void {
    // Host metadata is not secret.
    writeJsonAtomic(this.hostsFile, [...this.hosts.values()], 0o644);
  }
}
