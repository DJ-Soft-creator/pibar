// Password hashing (node:crypto scrypt, per-user salt), token creation and admin bootstrap.
// scrypt runs ASYNC so an unauthenticated /api/login cannot block the event loop.
import { randomBytes, randomUUID, scrypt, timingSafeEqual } from "node:crypto";
import type { Store, UserRecord } from "./store.js";
import type { Role } from "./types.js";

// Typed async scrypt (promisify picks the wrong overload of the options variant).
function scryptAsync(password: string, salt: string, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, (err, derivedKey) => {
      if (err) reject(err);
      else resolve(derivedKey);
    });
  });
}

const KEYLEN = 64;

export async function hashPassword(password: string): Promise<{ salt: string; hash: string }> {
  const salt = randomBytes(16).toString("hex");
  const hash = (await scryptAsync(password, salt, KEYLEN)).toString("hex");
  return { salt, hash };
}

export async function verifyPassword(password: string, salt: string, hash: string): Promise<boolean> {
  const expected = Buffer.from(hash, "hex");
  const candidate = await scryptAsync(password, salt, expected.length || KEYLEN);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export async function createUser(
  username: string,
  password: string,
  role: Role,
  hostIds: string[] = [],
): Promise<UserRecord> {
  const { salt, hash } = await hashPassword(password);
  return { id: randomUUID(), username, salt, hash, role, hostIds, settings: {} };
}

export function createToken(): string {
  return randomUUID();
}

export interface BootstrapResult {
  username: string;
  password: string;
  generated: boolean;
}

/**
 * On first start (no users persisted) create an admin from ADMIN_USERNAME / ADMIN_PASSWORD.
 * If ADMIN_PASSWORD is unset, generate a random password and print it ONCE via `log`.
 */
export async function bootstrapAdmin(
  store: Store,
  env: { ADMIN_USERNAME?: string; ADMIN_PASSWORD?: string },
  log: (message: string) => void,
): Promise<BootstrapResult | null> {
  if (store.users.size > 0) return null;
  const username = env.ADMIN_USERNAME?.trim() || "admin";
  const generated = !env.ADMIN_PASSWORD;
  const password = env.ADMIN_PASSWORD || randomBytes(12).toString("base64url");
  store.saveUser(await createUser(username, password, "admin"));
  if (generated) {
    log(`[pibar-webapp] Bootstrap admin "${username}" created. Generated password: ${password}`);
  } else {
    log(`[pibar-webapp] Bootstrap admin "${username}" created from ADMIN_USERNAME/ADMIN_PASSWORD.`);
  }
  return { username, password, generated };
}
