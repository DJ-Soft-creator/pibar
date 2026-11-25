// Auth: token from a Bearer header (desktop, tests) or the HttpOnly session cookie (browser); cross-site guard
// for cookie requests; admin gate; host access rule of the command router.
import type { IncomingMessage } from "node:http";
import type { NextFunction, Request, Response } from "express";
import type { Store, UserRecord } from "./store.js";

/** Name of the HttpOnly session cookie the browser client uses */
export const SESSION_COOKIE = "pibar_session";

/** Parse a Cookie header into name → value (first one wins, values URI-decoded) */
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const name = part.slice(0, i).trim();
    if (!name || name in out) continue;
    const raw = part.slice(i + 1).trim();
    try {
      out[name] = decodeURIComponent(raw);
    } catch {
      out[name] = raw;
    }
  }
  return out;
}

export interface RequestToken {
  token: string;
  /** bearer: explicit header (no browser sends it by itself); cookie: needs the cross-site guard */
  via: "bearer" | "cookie";
}

export function tokenFromRequest(req: IncomingMessage): RequestToken | null {
  const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
  if (match?.[1]) return { token: match[1], via: "bearer" };
  const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  return cookie ? { token: cookie, via: "cookie" } : null;
}

/**
 * Whether a request comes from our own pages. Browsers send Origin on cross-site requests, POSTs and WebSocket
 * upgrades; it must name the host the request went to (Nginx Proxy Manager passes the Host header through).
 * Without Origin, Sec-Fetch-Site (if sent) must not say cross-site.
 */
export function isSameOrigin(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin !== undefined) {
    if (origin === "null") return false;
    try {
      return new URL(origin).host === req.headers.host;
    } catch {
      return false;
    }
  }
  const site = req.headers["sec-fetch-site"];
  return site === undefined || site === "same-origin" || site === "none";
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** User of a request (Bearer or cookie; cookie only when the cross-site guard allows it); for WebSocket upgrades */
export function userForRequest(store: Store, req: IncomingMessage, safe: boolean): RequestToken & { user: UserRecord } | null {
  const t = tokenFromRequest(req);
  if (!t) return null;
  if (t.via === "cookie" && !safe && !isSameOrigin(req)) return null;
  const user = store.userForToken(t.token);
  return user ? { ...t, user } : null;
}

export function createStoreUserHelpers(store: Store) {
  function requireAuth(req: Request, res: Response, next: NextFunction): void {
    const t = tokenFromRequest(req);
    const user = t ? store.userForToken(t.token) : undefined;
    if (!t || !user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    // CSRF: a cookie request that changes something must come from our own pages
    if (t.via === "cookie" && !SAFE_METHODS.has(req.method) && !isSameOrigin(req)) {
      res.status(403).json({ error: "Cross-site request refused" });
      return;
    }
    req.authUser = user;
    req.authToken = t.token;
    next();
  }

  function requireAdmin(req: Request, res: Response, next: NextFunction): void {
    if (req.authUser?.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    next();
  }

  return { requireAuth, requireAdmin };
}

/** Whether a user may work on a host: admins on every host, users on the ones assigned to them */
export function canUseHost(user: UserRecord, hostId: string): boolean {
  return user.role === "admin" || user.hostIds.includes(hostId);
}
