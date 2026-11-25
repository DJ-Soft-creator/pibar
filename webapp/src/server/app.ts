// Express app factory: auth, user management (admin), config sync (no auth — LAN/reverse-proxy
// internal, PiBar sends no token), sessions for the UI, static client + SPA fallback.
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { createStoreUserHelpers } from "./helpers.js";
import { createToken, createUser, hashPassword, verifyPassword } from "./auth.js";
import { createLoginRateLimiter } from "./rateLimit.js";
import type { Store, UserRecord } from "./store.js";
import type { PublicUser } from "./types.js";
import { isConfigPayload, isRecord, isRole, isString } from "./validation.js";

declare module "express-serve-static-core" {
  interface Request {
    authUser?: UserRecord;
    authToken?: string;
  }
}

export interface AppOptions {
  /** Absolute path of the static client directory (webapp/src/client). */
  clientDir: string;
  /** Called after a config payload was persisted (WebSocket broadcast). */
  onConfigUpdated?: (receivedAt: string) => void;
}

function publicUser(u: UserRecord): PublicUser {
  return { id: u.id, username: u.username, role: u.role, host: u.host };
}

function adminCount(store: Store): number {
  let n = 0;
  for (const u of store.users.values()) if (u.role === "admin") n += 1;
  return n;
}

/** Express 4 does not catch rejected promises — forward them to the error handler. */
type AsyncHandler = (req: Request, res: Response) => Promise<void>;
function asyncRoute(fn: AsyncHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };
}

// Only the PiBar desktop Tauri WebView may read /api/config cross-origin.
// Same-origin requests (the webapp client itself) need no CORS headers at all.
const TAURI_ORIGINS = new Set([
  "tauri://localhost",
  "http://tauri.localhost",
  "https://tauri.localhost",
  // Dev mode: the Tauri WebView loads the Vite dev server (src-tauri/tauri.conf.json devUrl)
  "http://localhost:1420",
]);

export function createApp(store: Store, opts: AppOptions): express.Express {
  const app = express();
  // CSP disabled so the static client (inline scripts/styles) keeps working.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(
    cors({
      origin: (origin, callback) => {
        callback(null, origin !== undefined && TAURI_ORIGINS.has(origin));
      },
    }),
  );
  app.use(express.json({ limit: "10mb" }));

  const { requireAuth, requireAdmin } = createStoreUserHelpers(store);
  const loginLimiter = createLoginRateLimiter();

  // ---------------------------------------------------------------- auth
  app.post("/api/login", asyncRoute(async (req: Request, res: Response) => {
    if (!loginLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many login attempts, try again in a minute" });
      return;
    }
    const body: unknown = req.body;
    if (!isRecord(body) || !isString(body.username) || !isString(body.password)) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    const user = store.findUserByName(body.username);
    if (!user || !(await verifyPassword(body.password, user.salt, user.hash))) {
      res.status(401).json({ error: "Invalid credentials" });
      return;
    }
    const token = createToken();
    store.addToken(token, user.id);
    res.json({ token, username: user.username, role: user.role });
  }));

  app.post("/api/logout", requireAuth, (req: Request, res: Response) => {
    if (req.authToken !== undefined) store.removeToken(req.authToken);
    res.json({ status: "ok" });
  });

  // ------------------------------------------------- user management (admin)
  app.get("/api/users", requireAuth, requireAdmin, (_req: Request, res: Response) => {
    res.json([...store.users.values()].map(publicUser));
  });

  app.post("/api/users", requireAuth, requireAdmin, asyncRoute(async (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body) || !isString(body.username) || !body.username.trim() || !isString(body.password) || !body.password) {
      res.status(400).json({ error: "username and password required" });
      return;
    }
    if (body.role !== undefined && !isRole(body.role)) {
      res.status(400).json({ error: "role must be admin or user" });
      return;
    }
    if (body.host !== undefined && !isString(body.host)) {
      res.status(400).json({ error: "host must be a string" });
      return;
    }
    const username = body.username.trim();
    if (store.findUserByName(username)) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }
    const user = await createUser(username, body.password, isRole(body.role) ? body.role : "user", isString(body.host) ? body.host : "");
    store.saveUser(user);
    res.status(201).json(publicUser(user));
  }));

  app.patch("/api/users/:id", requireAuth, requireAdmin, asyncRoute(async (req: Request, res: Response) => {
    const user = store.users.get(req.params.id ?? "");
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "Expected a JSON object" });
      return;
    }
    if (body.host !== undefined && !isString(body.host)) {
      res.status(400).json({ error: "host must be a string" });
      return;
    }
    if (body.role !== undefined && !isRole(body.role)) {
      res.status(400).json({ error: "role must be admin or user" });
      return;
    }
    if (body.password !== undefined && (!isString(body.password) || !body.password)) {
      res.status(400).json({ error: "password must be a non-empty string" });
      return;
    }
    if (body.role === "user" && user.role === "admin" && adminCount(store) === 1) {
      res.status(409).json({ error: "Cannot demote the last admin" });
      return;
    }
    if (isString(body.host)) user.host = body.host;
    if (isRole(body.role)) user.role = body.role;
    if (isString(body.password) && body.password) {
      const { salt, hash } = await hashPassword(body.password);
      user.salt = salt;
      user.hash = hash;
      // A password reset revokes all existing sessions of that user.
      store.deleteUserTokens(user.id);
    }
    store.saveUser(user);
    res.json(publicUser(user));
  }));

  app.delete("/api/users/:id", requireAuth, requireAdmin, (req: Request, res: Response) => {
    const user = store.users.get(req.params.id ?? "");
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    if (user.role === "admin" && adminCount(store) === 1) {
      res.status(409).json({ error: "Cannot delete the last admin" });
      return;
    }
    if (req.authUser && user.id === req.authUser.id) {
      res.status(400).json({ error: "Cannot delete yourself" });
      return;
    }
    store.deleteUser(user.id);
    res.json({ status: "ok" });
  });

  // --------------------------------------- config sync (NO auth, see README)
  app.post("/api/config", (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isConfigPayload(body)) {
      res.status(400).json({ error: "Expected a ConfigPayload with sessions, projects and groups arrays and string ids" });
      return;
    }
    const receivedAt = new Date().toISOString();
    store.setConfig(body, receivedAt);
    opts.onConfigUpdated?.(receivedAt);
    res.json({ status: "ok" });
  });

  app.get("/api/config", (_req: Request, res: Response) => {
    if (!store.config) {
      res.status(404).json({ error: "No config received yet" });
      return;
    }
    res.json(store.config.payload);
  });

  app.get("/api/config/status", (_req: Request, res: Response) => {
    const cfg = store.config;
    res.json({
      hasConfig: cfg !== null,
      receivedAt: cfg?.receivedAt ?? null,
      counts: {
        sessions: cfg?.payload.sessions.length ?? 0,
        projects: cfg?.payload.projects.length ?? 0,
        groups: cfg?.payload.groups.length ?? 0,
      },
    });
  });

  // ----------------------------------------------------- sessions for the UI
  app.get("/api/sessions", requireAuth, (_req: Request, res: Response) => {
    res.json(store.config?.payload.sessions ?? []);
  });

  // ------------------------------------------------ static client + fallback
  app.use(express.static(opts.clientDir));
  app.use("/api", (_req: Request, res: Response) => {
    res.status(404).json({ error: "Not found" });
  });
  app.get("*", (req: Request, res: Response, next: NextFunction) => {
    if (req.path === "/ws" || req.path.startsWith("/ws/")) return next();
    res.sendFile(join(opts.clientDir, "index.html"), (err) => {
      if (err && !res.headersSent) res.status(404).end();
    });
  });

  // ---------------------------------------------------------- error handling
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (res.headersSent) return next(err);
    if (err instanceof SyntaxError && "body" in err) {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    console.error("[pibar-webapp] Unhandled error:", err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
