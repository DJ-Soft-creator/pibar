// Git history for the file view – port of src-tauri/src/gitlog.rs: commits of a repository or of one file, the
// files of a commit and the diff of a file in a commit (same scripts and parsing). The webapp adds a commit of
// selected changes with a message (task G6; the desktop leaves committing to Pi or the terminal). Every folder goes
// through the host-side path guard of ./pathGuard.ts.
import { checkPathShape } from "./files.js";
import { guardPrefix } from "./pathGuard.js";
import { shellPath, sq, type HostExec, type HostTarget } from "./hostexec.js";

const NOGIT = "__PIBAR_NOGIT__";
const UNPUSHED = "__PIBAR_UNPUSHED__";
const LOG = "__PIBAR_LOG__";
/** Field and record separators in `git log --pretty` (cannot appear in subjects) */
const FS = "\u001f";
const RS = "\u001e";
/** Largest diff handed to the UI */
export const MAX_DIFF = 400_000;

export interface Commit {
  hash: string;
  short: string;
  author: string;
  /** Seconds since the epoch */
  time: number;
  /** Branches and tags pointing here ("HEAD -> main, origin/main") */
  refs: string;
  subject: string;
  /** Not pushed to the upstream branch yet */
  unpushed: boolean;
}

export interface ChangedFile {
  /** Status letter (A, M, D, R …) */
  status: string;
  /** Relative to the repository root */
  path: string;
}

export interface CommitDetail {
  message: string;
  files: ChangedFile[];
}

/** Commit ids only: hex, 4–40 characters (nothing else reaches the shell) */
export function checkHash(hash: string): void {
  if (!/^[0-9a-fA-F]{4,40}$/.test(hash)) throw new Error(`invalid commit: ${hash}`);
}

const notARepo = () => new Error("Not in a Git repository");

/** Output of the log script: unpushed hashes, then the log records (gitlog.rs: parse_log) */
export function parseLog(out: string): Commit[] {
  if (out.trimStart().startsWith(NOGIT)) throw notARepo();
  const at = out.indexOf(LOG);
  const head = at >= 0 ? out.slice(0, at) : "";
  const log = at >= 0 ? out.slice(at + LOG.length) : out;
  const u = head.indexOf(UNPUSHED);
  const unpushed =
    u >= 0
      ? head
          .slice(u + UNPUSHED.length)
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];
  const commits: Commit[] = [];
  for (const rec of log.split(RS)) {
    const f = rec.replace(/^\n+/, "").split(FS);
    if (f.length < 6 || !f[0]) continue;
    const time = Number(f[3]);
    commits.push({
      hash: f[0],
      short: f[1] ?? "",
      author: f[2] ?? "",
      time: /^-?\d+$/.test(f[3] ?? "") ? time : 0,
      refs: f[4] ?? "",
      subject: (f[5] ?? "").trimEnd(),
      unpushed: unpushed.includes(f[0]),
    });
  }
  return commits;
}

export function logScript(dir: string, file: string | null, limit: number): string {
  const follow = file !== null ? ` --follow -- ${sq(file)}` : "";
  const n = Math.min(1000, Math.max(1, Math.floor(limit)));
  return (
    `cd ${shellPath(dir)} || exit 1; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo ${NOGIT}; exit 0; }; ` +
    `echo ${UNPUSHED}; git rev-list '@{u}..HEAD' 2>/dev/null | head -n 1000; echo ${LOG}; ` +
    `git log --no-color --max-count=${n} --pretty=format:'%H%x1f%h%x1f%an%x1f%at%x1f%D%x1f%s%x1e'${follow}`
  );
}

/** Commits of the repository `dir` is in, newest first; with `file`: only that file's commits (following renames) */
export async function gitLog(
  exec: HostExec,
  host: HostTarget,
  dir: string,
  file: string | null,
  limit: number,
  roots: string[],
): Promise<Commit[]> {
  checkPathShape(dir);
  return parseLog(await exec.runShell(host, guardPrefix(roots, [{ path: dir }]) + logScript(dir, file, limit)));
}

/** Output of `git show --format=… --name-status`: message record, then "status<TAB>path[<TAB>new]" lines */
export function parseDetail(out: string): CommitDetail {
  const at = out.indexOf(RS);
  const msg = at >= 0 ? out.slice(0, at) : out;
  const rest = at >= 0 ? out.slice(at + 1) : "";
  const files: ChangedFile[] = [];
  for (const l of rest.split("\n")) {
    const status = (l.split("\t")[0] ?? "").trim();
    const path = l.slice(l.lastIndexOf("\t") + 1);
    if (status && path && status !== path) files.push({ status: [...status][0] ?? "", path });
  }
  return { message: msg.trim(), files };
}

export function commitScript(dir: string, hash: string): string {
  return `cd ${shellPath(dir)} || exit 1; git -c core.quotePath=false show --no-color --format='%B%x1e' --name-status ${hash}`;
}

/** Message and changed files of a commit */
export async function gitCommit(
  exec: HostExec,
  host: HostTarget,
  dir: string,
  hash: string,
  roots: string[],
): Promise<CommitDetail> {
  checkPathShape(dir);
  checkHash(hash);
  return parseDetail(await exec.runShell(host, guardPrefix(roots, [{ path: dir }]) + commitScript(dir, hash)));
}

export function diffScript(dir: string, hash: string, path: string, top: boolean): string {
  const spec = top ? sq(`:(top)${path}`) : sq(path);
  return `cd ${shellPath(dir)} || exit 1; git show --no-color --format= ${hash} -- ${spec} | head -c ${MAX_DIFF}`;
}

/** Diff of one file in a commit; `top`: path relative to the repository root, otherwise relative to `dir` */
export async function gitDiff(
  exec: HostExec,
  host: HostTarget,
  dir: string,
  hash: string,
  path: string,
  top: boolean,
  roots: string[],
): Promise<string> {
  checkPathShape(dir);
  checkHash(hash);
  return exec.runShell(host, guardPrefix(roots, [{ path: dir }]) + diffScript(dir, hash, path, top));
}

// ------------------------------------------------------------------ commit (webapp only)

/** Paths of a commit: relative to the folder, no "..", no control characters (they become literal pathspecs) */
export function checkCommitPath(path: string): void {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (!path || /[\u0000-\u001f\u007f]/.test(path)) throw new Error(`Path not allowed: ${path}`);
  if (path.startsWith("/") || path.split("/").some((s) => s === "..")) {
    throw new Error(`Path not allowed: ${path}`);
  }
}

const COMMITTED = "__PIBAR_COMMITTED__";

/**
 * Stage the given paths (new, changed and deleted files; relative to `dir`) and commit only them, with the message
 * from stdin. `--literal-pathspecs`: a name with "*" or ":" means that file, nothing else. Author and committer
 * come from the host's Git config, like Pi's own commits.
 */
export function createCommitScript(dir: string, paths: string[]): string {
  const specs = paths.map(sq).join(" ");
  return (
    `cd ${shellPath(dir)} || exit 1; git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo ${NOGIT}; exit 0; }; ` +
    `git --literal-pathspecs add -A -- ${specs} && git --literal-pathspecs commit -q -F - -- ${specs} && ` +
    `echo ${COMMITTED} && git rev-parse HEAD && git rev-parse --short HEAD`
  );
}

export interface Created {
  hash: string;
  short: string;
}

export function parseCreated(out: string): Created {
  if (out.trimStart().startsWith(NOGIT)) throw notARepo();
  const at = out.indexOf(COMMITTED);
  if (at < 0) throw new Error("Commit failed");
  const [hash = "", short = ""] = out
    .slice(at + COMMITTED.length)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return { hash, short };
}

export async function createCommit(
  exec: HostExec,
  host: HostTarget,
  dir: string,
  paths: string[],
  message: string,
  roots: string[],
): Promise<Created> {
  checkPathShape(dir);
  if (!message.trim()) throw new Error("Commit message is empty");
  if (!paths.length) throw new Error("No files selected");
  paths.forEach(checkCommitPath);
  const out = await exec.runShell(host, guardPrefix(roots, [{ path: dir }]) + createCommitScript(dir, paths), {
    stdin: message.endsWith("\n") ? message : `${message}\n`,
  });
  return parseCreated(out);
}
