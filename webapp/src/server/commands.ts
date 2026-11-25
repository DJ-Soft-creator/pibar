// Command router: `POST /api/cmd/<name>` with the same names and arguments as the Tauri commands of the desktop
// app (src-tauri/src/lib.rs, called from src/shared/api.ts). The client adapter (webapp/client/src/webApi.ts)
// mirrors api.ts, so shared code runs unchanged against the webapp. Every command needs a login; commands that
// work on a host get `hostId` as an argument, the router checks the user may use that host and hands the
// resolved HostTarget to the handler.
import express, { type NextFunction, type Request, type Response } from "express";
import type { HostExec, HostTarget } from "./host/hostexec.js";
import type { Store, UserRecord } from "./store.js";
import { isRecord } from "./validation.js";

export interface CommandContext {
  user: UserRecord;
  store: Store;
  exec: HostExec;
  /** The host of a `host: true` command (checked: exists and the user may use it) */
  host: HostTarget;
}

export interface CommandSpec {
  /** Only admins may call it */
  admin?: boolean;
  /** The command works on a host: args.hostId is required, checked and resolved into ctx.host */
  host?: boolean;
  run(ctx: CommandContext, args: Record<string, unknown>): unknown;
}

/** Error with an HTTP status; the message reaches the client like a Tauri error string */
export class CommandError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export class CommandRegistry {
  private readonly specs = new Map<string, CommandSpec>();

  register(name: string, spec: CommandSpec): this {
    if (this.specs.has(name)) throw new Error(`Command ${name} registered twice`);
    this.specs.set(name, spec);
    return this;
  }

  get(name: string): CommandSpec | undefined {
    return this.specs.get(name);
  }

  names(): string[] {
    return [...this.specs.keys()].sort();
  }
}

export interface CommandDeps {
  registry: CommandRegistry;
  store: Store;
  exec: HostExec;
  /** Host by id (null = unknown) */
  resolveHost(hostId: string): HostTarget | null;
  /** Whether the user may work on the host (admins: every host) */
  canUseHost(user: UserRecord, hostId: string): boolean;
  /** Auth middleware that sets req.authUser */
  requireAuth(req: Request, res: Response, next: NextFunction): void;
}

const NAME_RE = /^[a-z][a-z0-9_]*$/;

export function commandRouter(deps: CommandDeps): express.Router {
  const router = express.Router();
  router.post("/:name", deps.requireAuth, (req: Request, res: Response, next: NextFunction) => {
    const name = req.params.name ?? "";
    const spec = NAME_RE.test(name) ? deps.registry.get(name) : undefined;
    if (!spec) {
      res.status(404).json({ error: `Unknown command: ${name}` });
      return;
    }
    const user = req.authUser;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    const body: unknown = req.body ?? {};
    if (!isRecord(body)) {
      res.status(400).json({ error: "Arguments must be a JSON object" });
      return;
    }
    if (spec.admin && user.role !== "admin") {
      res.status(403).json({ error: "Forbidden" });
      return;
    }
    let host: HostTarget | null = null;
    if (spec.host) {
      const hostId = body.hostId;
      if (typeof hostId !== "string" || !hostId) {
        res.status(400).json({ error: "hostId required" });
        return;
      }
      if (!deps.canUseHost(user, hostId)) {
        res.status(403).json({ error: "No access to this host" });
        return;
      }
      host = deps.resolveHost(hostId);
      if (!host) {
        res.status(404).json({ error: "Host not found" });
        return;
      }
    }
    const ctx: CommandContext = {
      user,
      store: deps.store,
      exec: deps.exec,
      // only `host: true` commands read ctx.host; for the others it is an unusable placeholder
      host: host ?? NO_HOST,
    };
    Promise.resolve()
      .then(() => spec.run(ctx, body))
      .then((result: unknown) => {
        res.json({ result: result ?? null });
      })
      .catch((e: unknown) => {
        if (e instanceof CommandError) {
          res.status(e.status).json({ error: e.message });
          return;
        }
        if (e instanceof Error) {
          // errors of host scripts (stderr) are meant for the user, like the desktop's Tauri errors
          res.status(500).json({ error: e.message });
          return;
        }
        next(e);
      });
  });
  return router;
}

const NO_HOST: HostTarget = { id: "", name: "", sshTarget: "", sshUser: "", sshPort: null, piCommand: "" };

// ------------------------------------------------------------------ argument helpers

/** Required string argument */
export function argString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string") throw new CommandError(400, `${key} must be a string`);
  return v;
}

/** Optional string argument (undefined/null → fallback) */
export function argOptString(args: Record<string, unknown>, key: string, fallback = ""): string {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "string") throw new CommandError(400, `${key} must be a string`);
  return v;
}

/** Required array of strings */
export function argStringArray(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) {
    throw new CommandError(400, `${key} must be an array of strings`);
  }
  return v as string[];
}

/** Optional array of strings (undefined/null → null) */
export function argOptStringArray(args: Record<string, unknown>, key: string): string[] | null {
  const v = args[key];
  if (v === undefined || v === null) return null;
  return argStringArray(args, key);
}

/** Optional finite number (undefined/null → fallback) */
export function argOptNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v)) throw new CommandError(400, `${key} must be a number`);
  return v;
}

/** Optional boolean (undefined/null → fallback) */
export function argOptBool(args: Record<string, unknown>, key: string, fallback: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "boolean") throw new CommandError(400, `${key} must be a boolean`);
  return v;
}
