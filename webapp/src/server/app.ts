// Express app factory: health, auth, user management (admin), hosts with SSH data (admin), the command router
// (/api/cmd/<name>, see commands.ts), API tokens and the desktop sync (routes/tokens.ts), static client + SPA
// fallback.
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import express, { type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import helmet from "helmet";
import { validateSettings, type AppConfigStore } from "./appConfig.js";
import { commandRouter, type CommandDeps } from "./commands.js";
import { canUseHost, createStoreUserHelpers, isSameOrigin, SESSION_COOKIE } from "./helpers.js";
import { createToken, createUser, hashPassword, verifyPassword } from "./auth.js";
import { createLoginRateLimiter } from "./rateLimit.js";
import { TOKEN_TTL_MS, type Store, type UserRecord } from "./store.js";
import { validateHostInput, type HostRecord } from "./hosts.js";
import { tokenRoutes, type TokenRouteDeps } from "./routes/tokens.js";
import type { PublicUser } from "./types.js";
import { isRecord, isRole, isString } from "./validation.js";

declare module "express-serve-static-core" {
  interface Request {
    authUser?: UserRecord;
    authToken?: string;
  }
}

export interface AppOptions {
  /** Absolute path of the static client directory (the Vite build, webapp/dist/client). */
  clientDir: string;
  /** Secure flag of the session cookie: auto = when the request came over HTTPS (also behind the proxy) */
  cookieSecure?: "auto" | "always" | "never";
  /** Shared settings (presets, quick actions, colour profiles, voice); without it /api/app-config answers 404 */
  appConfig?: AppConfigStore;
  /** Command router (/api/cmd/<name>); without it the route answers 404 for every command */
  commands?: Omit<CommandDeps, "store" | "requireAuth">;
  /** API tokens and the desktop sync (/api/tokens*, /api/sync/meta); without it those routes answer 404 */
  sync?: Omit<TokenRouteDeps, "store" | "requireAuth" | "requireAdmin">;
}

function publicUser(u: UserRecord): PublicUser {
  return { id: u.id, username: u.username, role: u.role, hostIds: [...u.hostIds] };
}

/**
 * Host list of a user request: `hostIds` (array of strings) or the older `host` (one id, "" = none).
 * undefined = not given; null = invalid.
 */
function parseHostIds(body: Record<string, unknown>): string[] | undefined | null {
  if (body.hostIds !== undefined) {
    if (!Array.isArray(body.hostIds) || !body.hostIds.every(isString)) return null;
    return [...new Set(body.hostIds.filter((h) => h.trim() !== ""))];
  }
  if (body.host !== undefined) {
    if (!isString(body.host)) return null;
    return body.host ? [body.host] : [];
  }
  return undefined;
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

// Only the PiBar desktop Tauri WebView may call the webapp cross-origin (the sync, /api/sync/meta).
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
  // Behind Nginx Proxy Manager: req.secure / req.ip from X-Forwarded-* of proxies in private networks only
  app.set("trust proxy", "loopback, linklocal, uniquelocal");
  // The client is a Vite bundle without inline scripts. Styles: 'unsafe-inline' for style attributes in
  // rendered Markdown/highlighting. Images: data/blob URLs (read_image, previews). Frames: blob for HTML previews.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", "data:", "blob:"],
          mediaSrc: ["'self'", "data:", "blob:"],
          connectSrc: ["'self'"],
          frameSrc: ["'self'", "blob:"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          upgradeInsecureRequests: null,
        },
      },
      // the HTTPS decision belongs to the proxy (LAN access over plain HTTP must keep working)
      strictTransportSecurity: false,
    }),
  );
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

  function setSessionCookie(req: Request, res: Response, token: string) {
    const mode = opts.cookieSecure ?? "auto";
    res.cookie(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "strict",
      secure: mode === "always" || (mode === "auto" && req.secure),
      path: "/",
      maxAge: TOKEN_TTL_MS,
    });
  }

  function clearSessionCookie(res: Response) {
    res.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: "strict", path: "/" });
  }

  // ---------------------------------------------------------------- health (no auth, Docker healthcheck)
  app.get("/api/health", (_req: Request, res: Response) => {
    res.json({ status: "ok" });
  });

  // ---------------------------------------------------------------- commands
  if (opts.commands) app.use("/api/cmd", commandRouter({ ...opts.commands, store, requireAuth }));
  if (opts.sync) app.use("/api", tokenRoutes({ ...opts.sync, store, requireAuth, requireAdmin }));

  // ---------------------------------------------------------------- auth
  app.post("/api/login", asyncRoute(async (req: Request, res: Response) => {
    if (!loginLimiter.allow(req.ip ?? "unknown")) {
      res.status(429).json({ error: "Too many login attempts, try again in a minute" });
      return;
    }
    // login CSRF: a foreign page must not log the browser into another account
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: "Cross-site request refused" });
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
    // the browser uses the HttpOnly cookie; the token in the body is for non-browser clients
    setSessionCookie(req, res, token);
    res.json({ token, username: user.username, role: user.role });
  }));

  app.post("/api/logout", requireAuth, (req: Request, res: Response) => {
    if (req.authToken !== undefined) store.removeToken(req.authToken);
    clearSessionCookie(res);
    res.json({ status: "ok" });
  });

  /** Log out everywhere: every token of the user dies (other phones, browsers) */
  app.post("/api/logout-all", requireAuth, (req: Request, res: Response) => {
    if (req.authUser) store.deleteUserTokens(req.authUser.id);
    clearSessionCookie(res);
    res.json({ status: "ok" });
  });

  // ------------------------------------------------------------ own account
  app.get("/api/me", requireAuth, (req: Request, res: Response) => {
    const user = req.authUser as UserRecord;
    res.json({ user: publicUser(user), settings: user.settings });
  });

  /** Own UI settings, replaced as a whole (the client merges) */
  app.put("/api/me/settings", requireAuth, (req: Request, res: Response) => {
    const user = req.authUser as UserRecord;
    const body: unknown = req.body;
    if (!isRecord(body) || !isRecord(body.settings)) {
      res.status(400).json({ error: "settings must be an object" });
      return;
    }
    if (JSON.stringify(body.settings).length > 64 * 1024) {
      res.status(413).json({ error: "settings too large" });
      return;
    }
    user.settings = body.settings;
    store.saveUser(user);
    res.json({ settings: user.settings });
  });

  /** Change the own password: needs the current one, ends every session, logs this browser in again */
  app.post("/api/me/password", requireAuth, asyncRoute(async (req: Request, res: Response) => {
    const user = req.authUser as UserRecord;
    const body: unknown = req.body;
    if (!isRecord(body) || !isString(body.currentPassword) || !isString(body.newPassword)) {
      res.status(400).json({ error: "currentPassword and newPassword required" });
      return;
    }
    if (body.newPassword.length < 8) {
      res.status(400).json({ error: "The new password needs at least 8 characters" });
      return;
    }
    if (!(await verifyPassword(body.currentPassword, user.salt, user.hash))) {
      res.status(403).json({ error: "Current password is wrong" });
      return;
    }
    const { salt, hash } = await hashPassword(body.newPassword);
    user.salt = salt;
    user.hash = hash;
    store.saveUser(user);
    store.deleteUserTokens(user.id);
    const token = createToken();
    store.addToken(token, user.id);
    setSessionCookie(req, res, token);
    res.json({ token });
  }));

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
    const hostIds = parseHostIds(body);
    if (hostIds === null) {
      res.status(400).json({ error: "hostIds must be an array of strings" });
      return;
    }
    const username = body.username.trim();
    if (store.findUserByName(username)) {
      res.status(409).json({ error: "Username already exists" });
      return;
    }
    const user = await createUser(username, body.password, isRole(body.role) ? body.role : "user", hostIds ?? []);
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
    const hostIds = parseHostIds(body);
    if (hostIds === null) {
      res.status(400).json({ error: "hostIds must be an array of strings" });
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
    if (hostIds !== undefined) user.hostIds = hostIds;
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

  // ------------------------------------------- shared settings (admin; users read them via app_config_get)
  app.get("/api/app-config", requireAuth, requireAdmin, (_req: Request, res: Response) => {
    if (!opts.appConfig) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    res.json(opts.appConfig.publicConfig());
  });

  /** Replaces the settings; an empty apiKey next to apiKeySet=true keeps the stored key */
  app.put("/api/app-config", requireAuth, requireAdmin, (req: Request, res: Response) => {
    if (!opts.appConfig) {
      res.status(404).json({ error: "Not found" });
      return;
    }
    const parsed = validateSettings(req.body);
    if (typeof parsed === "string") {
      res.status(400).json({ error: parsed });
      return;
    }
    opts.appConfig.save(parsed);
    res.json(opts.appConfig.publicConfig());
  });

  // ------------------------------------------- hosts (admin CRUD; users see the hosts they may use)
  app.get("/api/hosts", requireAuth, (req: Request, res: Response) => {
    const user = req.authUser as UserRecord;
    res.json(store.sortedHosts().filter((h) => canUseHost(user, h.id)));
  });

  app.post("/api/hosts", requireAuth, requireAdmin, (req: Request, res: Response) => {
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "Expected a JSON object" });
      return;
    }
    const input = validateHostInput(body, false);
    if (typeof input === "string") {
      res.status(400).json({ error: input });
      return;
    }
    if (input.name && store.findHostByName(input.name)) {
      res.status(409).json({ error: "Host name already exists" });
      return;
    }
    const host: HostRecord = {
      id: randomUUID(),
      name: input.name ?? "",
      sshTarget: input.sshTarget ?? "",
      sshUser: input.sshUser ?? "",
      sshPort: input.sshPort ?? null,
      piCommand: input.piCommand ?? "",
      defaultDir: input.defaultDir ?? "",
      colorProfile: input.colorProfile ?? "",
    };
    store.saveHost(host);
    res.status(201).json(host);
  });

  app.patch("/api/hosts/:id", requireAuth, requireAdmin, (req: Request, res: Response) => {
    const host = store.hosts.get(req.params.id ?? "");
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    const body: unknown = req.body;
    if (!isRecord(body)) {
      res.status(400).json({ error: "Expected a JSON object" });
      return;
    }
    const input = validateHostInput(body, true);
    if (typeof input === "string") {
      res.status(400).json({ error: input });
      return;
    }
    if (input.name !== undefined) {
      const other = store.findHostByName(input.name);
      if (other && other.id !== host.id) {
        res.status(409).json({ error: "Host name already exists" });
        return;
      }
    }
    const updated: HostRecord = { ...host, ...input, id: host.id };
    store.saveHost(updated);
    res.json(updated);
  });

  app.delete("/api/hosts/:id", requireAuth, requireAdmin, (req: Request, res: Response) => {
    const host = store.hosts.get(req.params.id ?? "");
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    store.deleteHost(host.id);
    res.json({ status: "ok" });
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
