// REST routes of the desktop sync: API token administration for admins (tasks I3: create – secret shown once –,
// rename, revoke) and the sync endpoint the PiBar desktop calls with such a token (task D2, POST /api/sync/meta,
// shape in sync.ts and webapp/README.md). The sync accepts ONLY an API token (Bearer), no login cookie or token.
import express, { type NextFunction, type Request, type Response } from "express";
import { validateTokenName, type ApiTokenStore } from "../apiTokens.js";
import type { MetaStore } from "../meta.js";
import { createLoginRateLimiter, type RateLimiter } from "../rateLimit.js";
import type { Store } from "../store.js";
import { hostMapping, incomingState, outgoingPayload, parseSyncRequest } from "../sync.js";
import { isRecord } from "../validation.js";

export interface TokenRouteDeps {
  store: Store;
  meta: MetaStore;
  apiTokens: ApiTokenStore;
  requireAuth(req: Request, res: Response, next: NextFunction): void;
  requireAdmin(req: Request, res: Response, next: NextFunction): void;
  /** Per-IP limit of the sync endpoint (default 60 per minute; a desktop syncs every minute and after saves) */
  syncLimiter?: RateLimiter;
}

export function tokenRoutes(deps: TokenRouteDeps): express.Router {
  const router = express.Router();
  const { requireAuth, requireAdmin, apiTokens, meta, store } = deps;
  const limiter = deps.syncLimiter ?? createLoginRateLimiter({ limit: 60, windowMs: 60_000 });

  // ---------------------------------------------------------- token administration (admin)
  router.get("/tokens", requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.json(apiTokens.list());
  });

  router.post("/tokens", requireAuth, requireAdmin, (req: Request, res: Response) => {
    const body: unknown = req.body;
    const name = validateTokenName(isRecord(body) ? body.name : undefined);
    if (typeof name !== "string") {
      res.status(400).json(name);
      return;
    }
    res.status(201).json(apiTokens.create(name));
  });

  router.patch("/tokens/:id", requireAuth, requireAdmin, (req: Request, res: Response) => {
    const body: unknown = req.body;
    const name = validateTokenName(isRecord(body) ? body.name : undefined);
    if (typeof name !== "string") {
      res.status(400).json(name);
      return;
    }
    const token = apiTokens.rename(req.params.id ?? "", name);
    if (!token) {
      res.status(404).json({ error: "Token not found" });
      return;
    }
    res.json(token);
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
    const match = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    const token = match?.[1] ? apiTokens.verify(match[1].trim()) : null;
    if (!token) {
      res.status(401).json({ error: "Invalid or revoked API token" });
      return;
    }
    apiTokens.touch(token.id);
    const parsed = parseSyncRequest(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    const now = Date.now();
    const webHosts = store.sortedHosts();
    const map = hostMapping(parsed.hosts, webHosts);
    // last writer wins per entry; saves and broadcasts meta/updated only when something changed
    meta.merge(incomingState(parsed, map, now));
    res.json(outgoingPayload(meta.state, map, parsed.hosts, webHosts, now));
  });

  return router;
}
