// HTTP routes of the file view next to the command router: GET /api/files/download streams a file of a host to the
// browser (Content-Disposition attachment; `inline=1` only for PDFs and pictures, e.g. a PDF in a new tab), with the
// same login, host rights and host-side path guard as the commands. uploadJson gives the upload_file command a body
// limit that fits MAX_UPLOAD_MB (base64 is a third bigger than the file) instead of the router's global 10 MB.
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import express, { type NextFunction, type Request, type RequestHandler, type Response } from "express";
import type { CommandDeps } from "../commands.js";
import { tokenFromRequest } from "../helpers.js";
import { checkPathShape, DL_MARK, downloadScript, maxUploadBytes } from "../host/files.js";
import { sessionRoots } from "../host/pathGuard.js";
import type { HostExec, HostTarget } from "../host/hostexec.js";
import type { Store } from "../store.js";

/** MIME types by extension; anything else downloads as octet-stream */
const TYPES: Record<string, string> = {
  pdf: "application/pdf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  txt: "text/plain; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8",
  json: "application/json",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  zip: "application/zip",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mov: "video/quicktime",
};

/**
 * Only these may open in the browser itself: they cannot run scripts in our origin. HTML, SVG and the rest always
 * download, since they would run with the webapp's cookies.
 */
const INLINE = new Set(["pdf", "png", "jpg", "jpeg", "gif", "webp"]);

const ext = (name: string) => (/\.([a-z0-9]+)$/i.exec(name)?.[1] ?? "").toLowerCase();

/** Content-Disposition with an ASCII fallback and the UTF-8 name (RFC 6266/5987) */
export function disposition(kind: "attachment" | "inline", name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_") || "file";
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Most bytes a login shell may print before the marker */
const MAX_NOISE = 64 * 1024;

interface Started {
  child: ChildProcessWithoutNullStreams;
  /** Bytes of the file that came with the marker chunk */
  head: Buffer;
  size: number;
}

/** Start the download script; resolves once the marker with the size arrived, rejects with the script's error */
function startDownload(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<Started> {
  return new Promise((resolve, reject) => {
    let child: ChildProcessWithoutNullStreams;
    try {
      child = exec.runner.spawnShell(host, downloadScript(path, roots));
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
      return;
    }
    child.stdin.end();
    let buf = Buffer.alloc(0);
    const err: Buffer[] = [];
    let done = false;
    const mark = Buffer.from(DL_MARK);
    const onErr = (d: Buffer) => err.push(d);
    const onData = (d: Buffer) => {
      if (done) return;
      buf = Buffer.concat([buf, d]);
      const at = buf.indexOf(mark);
      const nl = at >= 0 ? buf.indexOf(10, at) : -1;
      if (nl >= 0) {
        done = true;
        child.stdout.off("data", onData);
        child.stdout.pause();
        const size = Number(buf.subarray(at + mark.length, nl).toString("latin1"));
        resolve({ child, head: buf.subarray(nl + 1), size: Number.isFinite(size) ? size : -1 });
      } else if (buf.length > MAX_NOISE) {
        done = true;
        child.kill("SIGKILL");
        reject(new Error("Unexpected answer from the host"));
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onErr);
    child.on("error", (e) => {
      if (done) return;
      done = true;
      reject(e);
    });
    child.on("close", (code) => {
      if (done) return;
      done = true;
      const msg = Buffer.concat(err).toString("utf8").trim();
      reject(new Error(msg || `Exit code ${code ?? "?"}`));
    });
  });
}

export type FileRouteDeps = Pick<CommandDeps, "store" | "exec" | "resolveHost" | "canUseHost" | "requireAuth">;

export function fileRoutes(deps: FileRouteDeps): express.Router {
  const router = express.Router();
  router.get("/download", deps.requireAuth, (req: Request, res: Response, next: NextFunction) => {
    const user = req.authUser;
    const hostId = req.query.hostId;
    const path = req.query.path;
    if (!user) {
      res.status(401).json({ error: "Unauthorized" });
      return;
    }
    if (typeof hostId !== "string" || !hostId || typeof path !== "string") {
      res.status(400).json({ error: "hostId and path required" });
      return;
    }
    if (!deps.canUseHost(user, hostId)) {
      res.status(403).json({ error: "No access to this host" });
      return;
    }
    const host = deps.resolveHost(hostId);
    if (!host) {
      res.status(404).json({ error: "Host not found" });
      return;
    }
    try {
      checkPathShape(path);
      if (path.endsWith("/")) throw new Error(`Not a file path: ${path}`);
    } catch (e) {
      res.status(400).json({ error: (e as Error).message });
      return;
    }
    const name = path.slice(path.lastIndexOf("/") + 1) || "file";
    const e = ext(name);
    const inline = req.query.inline === "1" && INLINE.has(e);
    const extra = deps.store.hosts.get(hostId)?.defaultDir.trim();
    sessionRoots(deps.exec)
      .run(host, extra ? [extra] : [], (roots) => startDownload(deps.exec, host, path, roots))
      .then(({ child, head, size }) => {
        res.status(200);
        res.setHeader("Content-Type", TYPES[e] ?? "application/octet-stream");
        res.setHeader("Content-Disposition", disposition(inline ? "inline" : "attachment", name));
        res.setHeader("Cache-Control", "no-store");
        if (size >= 0) res.setHeader("Content-Length", String(size));
        // the phone went away: stop reading the file on the host
        res.on("close", () => {
          if (child.exitCode === null) child.kill("SIGKILL");
        });
        child.on("close", (code) => {
          // a failure after the headers can only cut the answer short; the browser sees an incomplete download
          if (code !== 0 && !res.writableEnded) res.destroy();
        });
        if (head.length) res.write(head);
        child.stdout.pipe(res);
        child.stdout.resume();
      })
      .catch((err: unknown) => {
        if (res.headersSent) return next(err);
        const msg = err instanceof Error ? err.message : String(err);
        const status = /^Path not allowed/.test(msg) ? 403 : /^Not a file/.test(msg) ? 404 : 500;
        res.status(status).json({ error: msg });
      });
  });
  return router;
}

/**
 * Body parser for /api/cmd/upload_file with room for a base64 file of MAX_UPLOAD_MB. Only for logged-in requests:
 * anonymous ones fall through to the global 10 MB parser (and get the router's 401), so nobody can make the
 * server parse big bodies without a login. The exact file size is checked again when decoding (decodeUpload).
 */
export function uploadJson(store: Store, maxBytes = maxUploadBytes()): RequestHandler {
  const parse = express.json({ limit: Math.ceil((maxBytes * 4) / 3) + 1_000_000 });
  return (req, res, next) => {
    const t = tokenFromRequest(req);
    if (!t || !store.userForToken(t.token)) return next();
    parse(req, res, next);
  };
}
