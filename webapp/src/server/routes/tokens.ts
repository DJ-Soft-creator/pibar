// REST routes of the desktop sync. A PiBar desktop signs in with a user's name and password
// (POST /api/desktop/login) and gets an API token of that user; with it, it syncs the user's organisation of the
// session list (POST /api/sync/meta, shape in sync.ts and webapp/README.md) and signs out again
// (POST /api/desktop/logout). Users see and revoke their own desktop tokens (/api/me/tokens*), admins every token
// (/api/tokens*). The desktop routes accept ONLY an API token (Bearer), no login cookie or login token.
import express, { type NextFunction, type Request, type Response } from "express";
import { validateTokenName, type ApiTokenRecord, type ApiTokenStore } from "../apiTokens.js";
import { verifyPassword } from "../auth.js";
import { canUseHost } from "../helpers.js";
import type { UserMetaStores } from "../meta.js";
import { createLoginRateLimiter, type RateLimiter } from "../rateLimit.js";
import type { Store, UserRecord } from "../store.js";
import { hostMapping, incomingState, outgoingPayload, parseSyncRequest } from "../sync.js";
import { isRecord, isString } from "../validation.js";

export interface TokenRouteDeps {
  store: Store;
  metas: UserMetaStores;
  apiTokens: ApiTokenStore;
  requireAuth(req: Request, res: Response, next: NextFunction): void;
  requireAdmin(req: Request, res: Response, next: NextFunction): void;
  /** Per-IP limit of the sync endpoint (default 60 per minute; a desktop syncs every minute and after saves) */
  syncLimiter?: RateLimiter;
  /** Per-IP limit of the desktop sign-in (default 10 per minute, like the browser login) */
  loginLimiter?: RateLimiter;
}

/** Name of a desktop token when the desktop sends none */
export const DEFAULT_DESKTOP_NAME = "PiBar desktop";

/** Async handlers: Express 4 does not catch rejected promises */
function asyncRoute(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

export function tokenRoutes(deps: TokenRouteDeps): express.Router {
  const router = express.Router();
  const { requireAuth, requireAdmin, apiTokens, metas, store } = deps;
  const limiter = deps.syncLimiter ?? createLoginRateLimiter({ limit: 60, windowMs: 60_000 });
  const loginLimiter = deps.loginLimiter ?? createLoginRateLimiter();

  /** The API token of a desktop request and its user; answers 401 itself and returns null when there is none */
  function desktopAuth(req: Request, res: Response): { token: ApiTokenRecord; user: UserRecord } | null {
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const token = match?.[1] ? apiTokens.verify(match[1].trim()) : null;
    const user = token ? store.users.get(token.userId) : undefined;
    if (!token || !user) {
      res.status(401).json({ error: "Not signed in or the sign-in was revoked – please sign in again" });
      return null;
    }
    return { token, user };
  }

  // ---------------------------------------------------------- desktop sign-in / sign-out
  router.post("/desktop/login", asyncRoute(async (req: Request, res: Response) => {
    if (!loginLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many login attempts, try again in a minute" });
      return;
    }
    const body: unknown = req.body;
    if (!isRecord(body) || !isString(body.username) || !isString(body.password)) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    const user = store.findUserByName(body.username.trim());
    if (!user || !(await verifyPassword(body.password, user.salt, user.hash))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const named = body.device === undefined ? DEFAULT_DESKTOP_NAME : validateTokenName(body.device);
    const name = typeof named === "string" ? named : DEFAULT_DESKTOP_NAME;
    const { token, secret } = apiTokens.create(name, user.id);
    res.status(201).json({ token: secret, tokenId: token.id, username: user.username, role: user.role });
  }));

  /** Sign out: the desktop's own token is revoked */
  router.post("/desktop/logout", (req: Request, res: Response) => {
    const auth = desktopAuth(req, res);
    if (!auth) return;
    apiTokens.revoke(auth.token.id);
    res.json({ status: "ok" });
  });

  // ---------------------------------------------------------- own desktop tokens (every user)
  router.get("/me/tokens", requireAuth, (req: Request, res: Response) => {
    res.json(apiTokens.list((req.authUser as UserRecord).id));
  });

  router.patch("/me/tokens/:id", requireAuth, (req: Request, res: Response) => {
    const user = req.authUser as UserRecord;
    const body: unknown = req.body;
    const name = validateTokenName(isRecord(body) ? body.name : undefined);
    if (typeof name !== "string") {
      res.status(400).json(name);
      return;
    }
    const id = req.params.id ?? "";
    if (!apiTokens.get(id, user.id)) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.json(apiTokens.rename(id, name));
  });

  router.delete("/me/tokens/:id", requireAuth, (req: Request, res: Response) => {
    const user = req.authUser as UserRecord;
    const id = req.params.id ?? "";
    if (!apiTokens.get(id, user.id) || !apiTokens.revoke(id)) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.json({ status: "ok" });
  });

  // ---------------------------------------------------------- every token (admin)
  router.get("/tokens", requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.json(apiTokens.list().map((tok) => ({ ...tok, username: store.users.get(tok.userId)?.username ?? "" })));
  });

  router.delete("/tokens/:id", requireAuth, requireAdmin, (req: Request, res: Response) => {
    if (!apiTokens.revoke(req.params.id ?? "")) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.json({ status: "ok" });
  });

  // ---------------------------------------------------------- desktop sync (API token only)
  router.post("/sync/meta", (req: Request, res: Response) => {
    if (!limiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many sync requests, try again in a minute" });
      return;
    }
    const auth = desktopAuth(req, res);
    if (!auth) return;
    const { token, user } = auth;
    apiTokens.touch(token.id);
    const parsed = parseSyncRequest(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    const now = Date.now();
    // only the hosts this user may use: sessions and projects of other hosts are neither taken nor answered
    const webHosts = store.sortedHosts().filter((h) => canUseHost(user, h.id));
    const map = hostMapping(parsed.hosts, webHosts);
    const meta = metas.of(user.id);
    // last writer wins per entry; saves and broadcasts meta/updated only when something changed
    meta.merge(incomingState(parsed, map, now));
    res.json({ ...outgoingPayload(meta.state, map, parsed.hosts, webHosts, now), user: user.username });
  });

  return router;
}
