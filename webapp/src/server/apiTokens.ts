// API tokens for the PiBar desktop apps: every token belongs to one user. The desktop gets one when its user signs
// in (POST /api/desktop/login, routes/tokens.ts) and syncs that user's organisation of the session list with it
// (POST /api/sync/meta). The secret is returned once; only its SHA-256 hash is stored (api-tokens.json, mode 0600).
// Such a token is good for the sync only – it is no login for the app or the command router. Tokens of the older
// admin-created kind (no user) are dropped on load: they cannot say whose data they sync.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord, isString } from "./validation.js";

/** Prefix of every API token secret: recognisable in config files and logs, never accepted as a login token */
export const API_TOKEN_PREFIX = "pbt_";
/** lastUsedAt is written at most this often (a desktop syncs every minute) */
const TOUCH_PERSIST_MS = 10 * 60_000;
export const MAX_TOKEN_NAME = 64;

export interface ApiTokenRecord {
  id: string;
  /** The user whose session organisation this token syncs */
  userId: string;
  name: string;
  /** hex SHA-256 of the secret */
  hash: string;
  /** First characters of the secret, so the admin can tell tokens apart ("pbt_AbCd…") */
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** What the admin UI sees: never the hash */
export type PublicApiToken = Omit<ApiTokenRecord, "hash">;

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** A new random secret: prefix + 32 random bytes (base64url) */
export function newSecret(): string {
  return API_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/** Trimmed token name, or an error text */
export function validateTokenName(v: unknown): string | { error: string } {
  if (!isString(v) || !v.trim()) return { error: "name required" };
  const name = v.trim();
  if (name.length > MAX_TOKEN_NAME) return { error: `name longer than ${MAX_TOKEN_NAME} characters` };
  return name;
}

/** A stored token; "legacy" = a valid record of the old kind without a user (dropped), null = damaged */
function parseRecord(v: unknown): ApiTokenRecord | "legacy" | null {
  if (!isRecord(v) || !isString(v.id) || !isString(v.name) || !isString(v.hash) || typeof v.createdAt !== "number") return null;
  if (!/^[0-9a-f]{64}$/.test(v.hash)) return null;
  if (!isString(v.userId) || !v.userId) return "legacy";
  const lastUsedAt = typeof v.lastUsedAt === "number" ? v.lastUsedAt : null;
  return {
    id: v.id,
    userId: v.userId,
    name: v.name,
    hash: v.hash,
    hint: isString(v.hint) ? v.hint : "",
    createdAt: v.createdAt,
    lastUsedAt,
  };
}

export function publicToken(r: ApiTokenRecord): PublicApiToken {
  const { hash: _h, ...pub } = r;
  return pub;
}

export class ApiTokenStore {
  private readonly tokens = new Map<string, ApiTokenRecord>();
  private readonly file: string;
  /** when lastUsedAt was last written per token (in memory only) */
  private readonly persistedTouch = new Map<string, number>();

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.file = join(dataDir, "api-tokens.json");
    if (!existsSync(this.file)) return;
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(this.file, "utf8"));
    } catch (err) {
      throw new Error(`Corrupt API token file: ${this.file}: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!Array.isArray(raw)) throw new Error(`Corrupt API token file: ${this.file}`);
    let dropped = false;
    for (const item of raw) {
      const r = parseRecord(item);
      if (!r) throw new Error(`Corrupt API token file: ${this.file}`);
      if (r === "legacy") dropped = true;
      else this.tokens.set(r.id, r);
    }
    if (dropped) this.persist();
  }

  private persist() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    // hashes only, but still nobody else's business
    writeFileSync(tmp, JSON.stringify([...this.tokens.values()], null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  /** All tokens (or those of one user), newest first */
  list(userId?: string): PublicApiToken[] {
    return [...this.tokens.values()]
      .filter((r) => userId === undefined || r.userId === userId)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(publicToken);
  }

  /** The token with this id, if it exists (and belongs to `userId` when given) */
  get(id: string, userId?: string): ApiTokenRecord | null {
    const r = this.tokens.get(id);
    return r && (userId === undefined || r.userId === userId) ? r : null;
  }

  /** Create a token of a user; the secret is returned only here */
  create(name: string, userId: string, now = Date.now()): { token: PublicApiToken; secret: string } {
    const secret = newSecret();
    const record: ApiTokenRecord = {
      id: randomUUID(),
      userId,
      name,
      hash: hashSecret(secret),
      hint: secret.slice(0, API_TOKEN_PREFIX.length + 4),
      createdAt: now,
      lastUsedAt: null,
    };
    this.tokens.set(record.id, record);
    this.persist();
    return { token: publicToken(record), secret };
  }

  rename(id: string, name: string): PublicApiToken | null {
    const r = this.tokens.get(id);
    if (!r) return null;
    r.name = name;
    this.persist();
    return publicToken(r);
  }

  /** Revoke (delete) a token; false = unknown id */
  revoke(id: string): boolean {
    if (!this.tokens.delete(id)) return false;
    this.persistedTouch.delete(id);
    this.persist();
    return true;
  }

  /** Revoke every token of a user (user deleted, password changed); returns how many */
  revokeUser(userId: string): number {
    let n = 0;
    for (const [id, r] of this.tokens) {
      if (r.userId !== userId) continue;
      this.tokens.delete(id);
      this.persistedTouch.delete(id);
      n += 1;
    }
    if (n) this.persist();
    return n;
  }

  /** The token of a secret, or null. Constant-time comparison of the hashes. */
  verify(secret: string): ApiTokenRecord | null {
    if (!secret.startsWith(API_TOKEN_PREFIX)) return null;
    const want = Buffer.from(hashSecret(secret), "hex");
    let found: ApiTokenRecord | null = null;
    for (const r of this.tokens.values()) {
      if (timingSafeEqual(want, Buffer.from(r.hash, "hex"))) found = r;
    }
    return found;
  }

  /** Remember the last use; written to disk at most every 10 minutes per token */
  touch(id: string, now = Date.now()) {
    const r = this.tokens.get(id);
    if (!r) return;
    r.lastUsedAt = now;
    const last = this.persistedTouch.get(id);
    if (last === undefined || now - last >= TOUCH_PERSIST_MS) {
      this.persistedTouch.set(id, now);
      this.persist();
    }
  }
}
