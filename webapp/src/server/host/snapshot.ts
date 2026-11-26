// File states for "go back" (port of src-tauri/src/snapshot.rs): before every own message the working tree of the
// session folder is recorded as a Git commit below `refs/pibar/<session id>/<entry id>` – the same refs as the desktop,
// so states are shared between desktop and webapp. Only objects and those refs are written; the index, the history
// and the branch of the user stay untouched. Same shell scripts and parsing as the Rust module.
import { hash as pathHash } from "./bg.js";
import { shellPath, sq, type HostExec, type HostTarget } from "./hostexec.js";

const NOGIT = "__PIBAR_NOGIT__";
const NONE = "__PIBAR_NONE__";
/** Identity of the snapshot commits: never taken from the Git config of the user */
const IDENT =
  "GIT_AUTHOR_NAME=PiBar GIT_AUTHOR_EMAIL=pibar@localhost GIT_COMMITTER_NAME=PiBar GIT_COMMITTER_EMAIL=pibar@localhost";
/** Snapshots and backups older than this go away with the next one (seconds) */
const KEEP = 14 * 24 * 3600;

export interface Taken {
  repo: string;
  commit: string;
  tag: string;
}
export interface Change {
  path: string;
  status: "M" | "A" | "D";
}
export interface Preview {
  repo: string | null;
  commit: string | null;
  changes: Change[];
  skipped: string[];
}
export interface Restored {
  backup: string;
  restored: string[];
  deleted: string[];
  failed: string[];
}

const emptyPreview = (): Preview => ({ repo: null, commit: null, changes: [], skipped: [] });
const emptyRestored = (): Restored => ({ backup: "", restored: [], deleted: [], failed: [] });

/** Absolute or "~/…", no control characters, no ".." (files.rs: check_path_shape) */
export function checkPathShape(path: string) {
  const bad = (why: string) => new Error(`Path not allowed (${why}): ${path}`);
  if (/[\0-\x1f\x7f]/.test(path)) throw bad("control character");
  if (!(path.startsWith("/") || path.startsWith("~/") || path === "~")) throw bad("not absolute");
  if (path.split("/").includes("..")) throw bad("..");
}

/** Session ids and message entry ids end up in a ref name: only what a ref may contain */
export function checkRefPart(id: string) {
  const ok = id.length >= 4 && id.length <= 64 && !id.startsWith("-") && /^[A-Za-z0-9_-]+$/.test(id);
  if (!ok) throw new Error(`Not an id: ${id}`);
}

/** Commit ids only: hex, 4–40 characters (nothing else reaches the shell) */
export function checkCommit(commit: string) {
  if (!(commit.length >= 4 && commit.length <= 40 && /^[0-9a-fA-F]+$/.test(commit))) throw new Error(`Not a commit: ${commit}`);
}

/** Refs to look for: the state may live under any session of the family (a Pi fork keeps the history) */
export function refsFor(sessionIds: string[], tag: string): string[] {
  if (!sessionIds.length) throw new Error("No session for this point");
  checkRefPart(tag);
  // the ids end up in the ref name as well (the Rust core checks only the tag here; the webapp is stricter)
  for (const id of sessionIds) checkRefPart(id);
  return sessionIds.map((id) => `refs/pibar/${id}/${tag}`);
}

export function probeScript(dir: string): string {
  return (
    `cd ${shellPath(dir)} || exit 1; cwd=$(pwd -P) || exit 1; ` +
    `root=$(git rev-parse --show-toplevel 2>/dev/null) || { printf '${NOGIT}\\n'; exit 0; }; ` +
    `printf '%s\\t%s\\t%s\\n' "$root" "$cwd" "$HOME"`
  );
}

/** Expand `~` and keep absolute paths */
function absolute(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return `${home}/${path.slice(2)}`;
  return path;
}

/** Where the session folder sits in a repository */
export class Layout {
  constructor(
    readonly root: string,
    /** The same root as the session folder was named (may differ through symlinks), never with a trailing "/" */
    readonly alias: string,
    readonly home: string,
    readonly cwd: string,
  ) {}

  /** Path as Pi reported it → relative to the repository root; null if outside the repository or in its `.git` */
  repoPath(path: string): string | null {
    const p = path.trim();
    if (!p || /[\0-\x1f\x7f]/.test(p)) return null;
    const cwd = absolute(this.cwd, this.home).replace(/\/+$/, "");
    const full = p.startsWith("/") || p.startsWith("~") ? absolute(p, this.home) : `${cwd}/${p}`;
    let rest: string | null = null;
    for (const base of [this.root, this.alias]) {
      if (full.startsWith(base)) {
        const r = full.slice(base.length);
        if (r === "" || r.startsWith("/")) {
          rest = r;
          break;
        }
      }
    }
    if (rest === null) return null;
    const parts: string[] = [];
    for (const seg of rest.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") return null;
      parts.push(seg);
    }
    if (!parts.length || parts[0] === ".git") return null;
    return parts.join("/");
  }
}

/** Answer of probeScript (root, resolved working folder, home: tab separated) → Layout; null if not in a repository */
export function parseProbe(out: string, dir: string): Layout | null {
  const line = (out.split("\n")[0] ?? "").trim();
  if (!line || line.startsWith(NOGIT)) return null;
  const [root, cwd, home] = line.split("\t");
  if (root === undefined || cwd === undefined || home === undefined) return null;
  if (!root.startsWith("/") || !cwd.startsWith("/")) return null;
  const cwdRel = (cwd.startsWith(root) ? cwd.slice(root.length) : "").replace(/^\/+/, "");
  const given = absolute(dir, home.trim()).replace(/\/+$/, "");
  let alias = given;
  if (cwdRel && given.endsWith(`/${cwdRel}`)) alias = given.slice(0, given.length - cwdRel.length - 1);
  return new Layout(root, alias, home.trim(), cwd);
}

async function probe(exec: HostExec, host: HostTarget, dir: string): Promise<Layout | null> {
  return parseProbe(await exec.runShell(host, probeScript(dir)), dir);
}

/** Index file of the snapshots: a copy kept by PiBar, so the index of the user is never touched */
function indexFile(root: string): string {
  return `"$HOME"/.pibar/snap-index/${pathHash(root)}`;
}

function pruneSnippet(): string {
  return (
    "now=$(date +%s); git for-each-ref --format='%(refname) %(committerdate:unix)' refs/pibar " +
    `| while read -r r t; do [ -n "$t" ] && [ $((now - t)) -gt ${KEEP} ] && git update-ref -d "$r"; done`
  );
}

export function takeScript(root: string, index: string, refname: string): string {
  return (
    `cd ${shellPath(root)} || exit 1; mkdir -p "$(dirname ${index})"; ` +
    `tree=$( ( export GIT_INDEX_FILE=${index}; git add -A >/dev/null 2>&1 || exit 1; git write-tree ) ) || exit 1; ` +
    `commit=$( ${IDENT} git commit-tree "$tree" -m 'PiBar: files before a message' ) || exit 1; ` +
    `git update-ref ${sq(refname)} "$commit" || exit 1; printf '%s\\n' "$commit"; ` +
    `{ ${pruneSnippet()}; } >/dev/null 2>&1 || true`
  );
}

/** Record the current files of the session folder; null if the folder is not in a Git repository */
export async function snapshotTake(exec: HostExec, host: HostTarget, dir: string, sessionId: string, tag: string): Promise<Taken | null> {
  checkPathShape(dir);
  checkRefPart(sessionId);
  const layout = await probe(exec, host, dir);
  if (!layout) return null;
  const refname = refsFor([sessionId], tag)[0] as string;
  const out = await exec.runShell(host, takeScript(layout.root, indexFile(layout.root), refname));
  const commit = out.trim();
  checkCommit(commit);
  return { repo: layout.root, commit, tag };
}

export function previewScript(root: string, refs: string[], rels: string[]): string {
  return (
    `cd ${shellPath(root)} || exit 1; commit=; for ref in ${refs.map(sq).join(" ")}; do commit=$(git rev-parse -q --verify "$ref" 2>/dev/null) && break; done; ` +
    `[ -n "$commit" ] || { printf '${NONE}\\n'; exit 0; }; printf 'COMMIT\\t%s\\n' "$commit"; ` +
    `for rel in ${rels.map(sq).join(" ")}; do [ -n "$rel" ] || continue; ` +
    `if git cat-file -e "$commit:$rel" 2>/dev/null; then ` +
    `if [ ! -e "$rel" ] && [ ! -L "$rel" ]; then printf 'D\\t%s\\n' "$rel"; ` +
    `elif git diff --quiet "$commit" -- "$rel" 2>/dev/null; then printf '=\\t%s\\n' "$rel"; ` +
    `else printf 'M\\t%s\\n' "$rel"; fi; ` +
    `elif [ -e "$rel" ] || [ -L "$rel" ]; then printf 'A\\t%s\\n' "$rel"; ` +
    `else printf -- '-\\t%s\\n' "$rel"; fi; ` +
    `done`
  );
}

export function parsePreview(out: string): { commit: string | null; changes: Change[] } {
  let commit: string | null = null;
  const changes: Change[] = [];
  for (const line of out.split("\n")) {
    const i = line.indexOf("\t");
    if (i < 0) continue;
    const kind = line.slice(0, i);
    const path = line.slice(i + 1);
    if (kind === "COMMIT") commit = path.trim();
    else if (kind === "M" || kind === "A" || kind === "D") changes.push({ path, status: kind });
  }
  return { commit, changes };
}

function repoPaths(paths: string[], layout: Layout): { rels: string[]; skipped: string[] } {
  const rels: string[] = [];
  const skipped: string[] = [];
  for (const p of paths) {
    const rel = layout.repoPath(p);
    if (rel !== null && !rels.includes(rel)) rels.push(rel);
    else skipped.push(p);
  }
  return { rels, skipped };
}

export async function rewindPreview(
  exec: HostExec,
  host: HostTarget,
  dir: string,
  sessionIds: string[],
  tag: string,
  paths: string[],
): Promise<Preview> {
  checkPathShape(dir);
  const layout = await probe(exec, host, dir);
  if (!layout) return emptyPreview();
  const { rels, skipped } = repoPaths(paths, layout);
  const refs = refsFor(sessionIds, tag);
  const { commit, changes } = parsePreview(await exec.runShell(host, previewScript(layout.root, refs, rels)));
  return { repo: layout.root, commit, changes, skipped };
}

export function restoreLoop(rels: string[]): string {
  return (
    `for rel in ${rels.map(sq).join(" ")}; do [ -n "$rel" ] || continue; ` +
    `if git cat-file -e "$commit:$rel" 2>/dev/null; then ` +
    `if git restore --source="$commit" --worktree -- "$rel" 2>/dev/null ` +
    `|| { mkdir -p "$(dirname "$rel")"; git cat-file -p "$commit:$rel" > "$rel"; }; then ` +
    `printf 'R\\t%s\\n' "$rel"; else printf '!\\t%s\\n' "$rel"; fi; ` +
    `elif rm -f -- "$rel" 2>/dev/null; then printf 'X\\t%s\\n' "$rel"; ` +
    `else printf '!\\t%s\\n' "$rel"; fi; done`
  );
}

export function parseRestore(out: string): Restored | null {
  const lines = out.split("\n");
  if (lines.some((l) => l.trim() === NONE)) return null;
  const r = emptyRestored();
  for (const line of lines) {
    const i = line.indexOf("\t");
    if (i < 0) continue;
    const kind = line.slice(0, i);
    const path = line.slice(i + 1);
    if (kind === "BACKUP") r.backup = path.trim();
    else if (kind === "R") r.restored.push(path);
    else if (kind === "X") r.deleted.push(path);
    else if (kind === "!") r.failed.push(path);
  }
  return r;
}

export function restoreScript(root: string, index: string, undoRef: string, refs: string[], rels: string[]): string {
  return (
    `cd ${shellPath(root)} || exit 1; commit=; for ref in ${refs.map(sq).join(" ")}; do commit=$(git rev-parse -q --verify "$ref" 2>/dev/null) && break; done; ` +
    `[ -n "$commit" ] || { printf '${NONE}\\n'; exit 0; }; printf 'COMMIT\\t%s\\n' "$commit"; ` +
    `mkdir -p "$(dirname ${index})"; ` +
    `tree=$( ( export GIT_INDEX_FILE=${index}; git add -A >/dev/null 2>&1 || exit 1; git write-tree ) ) || exit 1; ` +
    `backup=$( ${IDENT} git commit-tree "$tree" -m 'PiBar: files before going back' ) || exit 1; ` +
    `git update-ref ${sq(undoRef)} "$backup" || exit 1; printf 'BACKUP\\t%s\\n' "$backup"; ${restoreLoop(rels)}`
  );
}

export async function rewindRestore(
  exec: HostExec,
  host: HostTarget,
  dir: string,
  sessionIds: string[],
  tag: string,
  paths: string[],
): Promise<Restored | null> {
  checkPathShape(dir);
  const layout = await probe(exec, host, dir);
  if (!layout) return null;
  const { rels } = repoPaths(paths, layout);
  if (!rels.length) return emptyRestored();
  const refs = refsFor(sessionIds, tag);
  const stamp = Math.floor(Date.now() / 1000);
  const undoRef = `refs/pibar/undo/${sessionIds[0] ?? ""}-${stamp}`;
  const out = await exec.runShell(host, restoreScript(layout.root, indexFile(layout.root), undoRef, refs, rels));
  return parseRestore(out);
}

/** Undo a restore: put the same files back to the state recorded right before it (its `backup`) */
export async function rewindUndo(exec: HostExec, host: HostTarget, dir: string, commit: string, paths: string[]): Promise<Restored> {
  checkPathShape(dir);
  checkCommit(commit);
  const layout = await probe(exec, host, dir);
  if (!layout) return emptyRestored();
  const { rels } = repoPaths(paths, layout);
  if (!rels.length) return emptyRestored();
  const script = `cd ${shellPath(layout.root)} || exit 1; commit=${sq(commit)}; printf 'COMMIT\\t%s\\n' "$commit"; ${restoreLoop(rels)}`;
  return parseRestore(await exec.runShell(host, script)) ?? emptyRestored();
}
