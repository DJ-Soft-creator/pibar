// Files of a session's folders – port of src-tauri/src/files.rs: list (optionally with the Git status), read text and
// images, the Git HEAD version, write, create, upload, download, folder picker, create folder, delete. Same shell
// scripts and parsing as the desktop. The webapp adds the host-side path guard of ./pathGuard.ts in front of the
// scripts (`roots`): every path is resolved on the host and must lie inside the allowed folders. Paths are quoted
// with shellPath instead of sq, so the "~/…" paths check_path_shape allows really mean the home folder.
import { guardPrefix, type GuardCheck } from "./pathGuard.js";
import { shellPath, sq, type HostExec, type HostTarget } from "./hostexec.js";

/** Error for a path that must not reach the shell; the message goes to the user */
function bad(why: string, path: string): Error {
  return new Error(`Path not allowed (${why}): ${path}`);
}

/**
 * Paths for the file commands: absolute (or "~/"), without ".." segments or control characters, so nothing can be
 * smuggled into the shell commands or out of the given folder by ".." (files.rs: check_path_shape)
 */
export function checkPathShape(path: string): void {
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is refused
  if (/[\u0000-\u001f\u007f-\u009f]/.test(path)) throw bad("control character", path);
  if (!(path.startsWith("/") || path.startsWith("~/"))) throw bad("not absolute", path);
  if (path.split("/").some((seg) => seg === "..")) throw bad("..", path);
}

export interface GitChange {
  /** Relative to the listed folder; folders end with "/" */
  path: string;
  /** Two-letter porcelain code, e.g. " M", "A ", "??" */
  code: string;
}

/** Branch, sync state with the upstream and changed files (from `git status --porcelain --branch`) */
export interface GitInfo {
  /** Repository folder relative to the listed folder; "" = the listed folder itself (or a parent of it) */
  dir: string;
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
}

export interface FolderListing {
  /** Folder as given (e.g. "~/notes") */
  folder: string;
  /** Resolved absolute path */
  root: string;
  /** Files relative to root; folders end with "/" */
  files: string[];
  /** The folder does not exist on the host */
  missing: boolean;
  error: string | null;
  git: GitInfo[];
}

/** First output line when the folder does not exist */
export const MISSING = "__PIBAR_MISSING__";

/** files.rs: LIST – absolute path, files (optionally only documents and images), then folders with a trailing "/" */
export const LIST = String.raw`pwd
find . -maxdepth 6 \( -name node_modules -o -name .git -o -name target -o -name dist -o -name build -o -name '.*' ! -name . \) -prune -o -type f __FILTER__ -print | sed 's|^\./||' | sort | head -n 3000
find . -mindepth 1 -maxdepth 4 \( -name node_modules -o -name target -o -name '.*' \) -prune -o -type d -print | sed 's|^\./||; s|$|/|' | sort | head -n 500`;

/** files.rs: DOCS_FILTER – only documents and images ("Markdown, HTML and images only") */
export const DOCS_FILTER = String.raw`\( -name '*.md' -o -name '*.markdown' -o -name '*.html' -o -name '*.htm' -o -iname '*.png' -o -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.gif' -o -iname '*.webp' \)`;

/** Marks the start of the Git part of the output */
export const GIT_MARK = "__PIBAR_GIT__";

/** files.rs: GIT – one block per repository: marker, folder, prefix of the listed folder, then `git status` */
export const GIT = `
if p=$(git rev-parse --show-prefix 2>/dev/null); then
  echo __PIBAR_GIT__; echo ""; echo "$p"
  git -c core.quotePath=false status --porcelain=v1 --branch --untracked-files=all 2>/dev/null | head -n 2000
fi
find . -mindepth 2 -maxdepth 5 \\( -name node_modules -o -name target \\) -prune -o -name .git -prune -print 2>/dev/null | head -n 30 | while IFS= read -r g; do
  d=$(dirname "$g"); d=\${d#./}
  echo __PIBAR_GIT__; echo "$d"; echo ""
  git -C "$d" -c core.quotePath=false status --porcelain=v1 --branch --untracked-files=all 2>/dev/null | head -n 500
done`;

/** "## main...origin/main [ahead 2, behind 1]" → branch, upstream, ahead, behind (files.rs: parse_branch) */
export function parseBranch(line: string): [string, string | null, number, number] {
  const rest = line.replace(/^(## )+/, "").trim();
  const i = rest.indexOf(" [");
  let names = i >= 0 ? rest.slice(0, i) : rest;
  const counts = i >= 0 ? rest.slice(i + 2).replace(/\]+$/, "") : "";
  names = names.replace(/^(No commits yet on )+/, "");
  const dots = names.indexOf("...");
  const branch = dots >= 0 ? names.slice(0, dots) : names;
  const upstream = dots >= 0 ? names.slice(dots + 3) : null;
  let ahead = 0;
  let behind = 0;
  for (const raw of counts.split(",")) {
    const part = raw.trim();
    if (part.startsWith("ahead ")) ahead = toCount(part.slice(6));
    else if (part.startsWith("behind ")) behind = toCount(part.slice(7));
  }
  return [branch, upstream, ahead, behind];
}

function toCount(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : 0;
}

/** One Git block: folder line, prefix line, branch line, then "XY path" lines (files.rs: parse_git) */
export function parseGit(lines: string[]): GitInfo | null {
  if (lines.length < 2) return null;
  const dir = (lines[0] ?? "").trim();
  const prefix = (lines[1] ?? "").trim();
  const info: GitInfo = { dir, branch: "", upstream: null, ahead: 0, behind: 0, changes: [] };
  for (const line of lines.slice(2)) {
    if (line.startsWith("## ")) {
      [info.branch, info.upstream, info.ahead, info.behind] = parseBranch(line);
    } else if (Buffer.byteLength(line) > 3) {
      const code = line.slice(0, 2);
      let path = line.slice(3);
      // renames: "R  old -> new"
      const arrow = path.indexOf(" -> ");
      if (arrow >= 0) path = path.slice(arrow + 4);
      path = path.replace(/^"+|"+$/g, "");
      if (path.startsWith(prefix)) {
        const rel = path.slice(prefix.length);
        info.changes.push({ path: dir ? `${dir}/${rel}` : rel, code });
      }
    }
  }
  return info;
}

/** Turn the output of the list script into a listing (files.rs: parse_listing) */
export function parseListing(folder: string, out: string): FolderListing {
  const all = out.split("\n");
  if (all[all.length - 1] === "") all.pop();
  const blocks: string[][] = [[]];
  for (const l of all) {
    if (l === GIT_MARK) blocks.push([]);
    else (blocks[blocks.length - 1] as string[]).push(l);
  }
  const main = blocks[0] ?? [];
  const git = blocks
    .slice(1)
    .map(parseGit)
    .filter((g): g is GitInfo => g !== null);
  const first = (main[0] ?? "").trim();
  if (first === MISSING) return { folder, root: "", files: [], missing: true, error: null, git: [] };
  const files = main.slice(1).filter((l) => l !== "");
  return { folder, root: first, files, missing: false, error: null, git };
}

/** Script of one folder: guard, cd (missing → marker), list, optionally the Git status */
export function listScript(folder: string, withGit: boolean, docsOnly: boolean, roots: string[]): string {
  const list = LIST.replace("__FILTER__", docsOnly ? DOCS_FILTER : "");
  const git = withGit ? GIT : "";
  return `${guardPrefix(roots, [{ path: folder }])}if ! cd ${shellPath(folder)} 2>/dev/null; then echo ${MISSING}; exit 0; fi; ${list}${git}`;
}

export async function listFiles(
  exec: HostExec,
  host: HostTarget,
  folders: string[],
  withGit: boolean,
  docsOnly: boolean,
  roots: string[],
): Promise<FolderListing[]> {
  return Promise.all(
    folders.map(async (folder): Promise<FolderListing> => {
      try {
        checkFolderShape(folder);
        return parseListing(folder, await exec.runShell(host, listScript(folder, withGit, docsOnly, roots)));
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        return { folder, root: "", files: [], missing: false, error, git: [] };
      }
    }),
  );
}

/** Folders of the tree and the picker may also be "~" itself (the home folder) */
function checkFolderShape(folder: string): void {
  const f = folder.trim();
  if (f === "~" || f === "") return;
  checkPathShape(f);
}

/** Images the file panel shows (read only): extension → MIME type */
const IMAGE_TYPES: [string, string][] = [
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
];

/** Largest image the panel loads (it travels base64-encoded through the UI) */
export const MAX_IMAGE = 20_000_000;

/** MIME type of an image path the panel may show; same path rules as checkPathShape otherwise */
export function imageType(path: string): string {
  const lower = path.toLowerCase();
  const hit = IMAGE_TYPES.find(([ext]) => lower.endsWith(ext));
  if (!hit) throw new Error(`Not an image: ${path}`);
  checkPathShape(path);
  return hit[1];
}

export interface ImageData {
  mimeType: string;
  /** base64 */
  data: string;
}

export async function readImage(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<ImageData> {
  const mime = imageType(path);
  const p = shellPath(path);
  const script = `${guardPrefix(roots, [{ path }])}s=$(wc -c < ${p} | tr -d ' ') && [ -n "$s" ] || exit 1; if [ "$s" -gt ${MAX_IMAGE} ]; then echo TOO_LARGE; exit 0; fi; base64 < ${p} | tr -d '\\n'`;
  const out = await exec.runShell(host, script);
  if (out.trim() === "TOO_LARGE") throw new Error("Image too large (max. 20 MB)");
  return { mimeType: mime, data: out.trim() };
}

/** Largest text file the panel opens */
export const MAX_TEXT = 2_000_000;
const BINARY = "__PIBAR_BINARY__";
const TOO_LARGE = "__PIBAR_TOO_LARGE__";

/** Read a text file for the editor (binary files and files over 2 MB are refused) */
export async function readFile(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<string> {
  checkPathShape(path);
  const p = shellPath(path);
  const script =
    `${guardPrefix(roots, [{ path }])}s=$(wc -c < ${p} | tr -d ' ') && [ -n "$s" ] || exit 1; ` +
    `if [ "$s" -gt ${MAX_TEXT} ]; then echo ${TOO_LARGE}; elif [ "$s" -gt 0 ] && ! grep -Iq '' ${p}; then echo ${BINARY}; ` +
    `else printf x; cat ${p}; fi`;
  const out = await exec.runShell(host, script);
  const trimmed = out.trimEnd();
  if (trimmed === TOO_LARGE) throw new Error("File too large to show (max. 2 MB)");
  if (trimmed === BINARY) throw new Error("Binary file – cannot be shown");
  // "x" in front keeps content that happens to look like a marker apart from the markers
  return out.startsWith("x") ? out.slice(1) : out;
}

export interface HeadVersion {
  inGit: boolean;
  /** Content in HEAD; null if the file is new (not yet committed) */
  text: string | null;
}

const HEAD_MARK = "__PIBAR_HEAD__";
const NOGIT_MARK = "__PIBAR_NOGIT__";
const NEW_MARK = "__PIBAR_NEW__";

/** First line: marker; with HEAD_MARK the rest is the file content in HEAD (files.rs: parse_head) */
export function parseHead(out: string): HeadVersion {
  const i = out.indexOf("\n");
  const first = i >= 0 ? out.slice(0, i) : out;
  const rest = i >= 0 ? out.slice(i + 1) : "";
  switch (first.trim()) {
    case HEAD_MARK:
      return { inGit: true, text: rest };
    case NEW_MARK:
      return { inGit: true, text: null };
    default:
      return { inGit: false, text: null };
  }
}

export async function readHead(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<HeadVersion> {
  checkPathShape(path);
  const i = path.lastIndexOf("/");
  const dir = i > 0 ? path.slice(0, i) : i === 0 ? "/" : ".";
  const name = i >= 0 ? path.slice(i + 1) : path;
  const n = sq(name);
  const script =
    `${guardPrefix(roots, [{ path }])}cd ${shellPath(dir)} 2>/dev/null && git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo ${NOGIT_MARK}; exit 0; }; ` +
    `if git cat-file -e HEAD:./${n} 2>/dev/null; then echo ${HEAD_MARK}; git show HEAD:./${n}; else echo ${NEW_MARK}; fi`;
  return parseHead(await exec.runShell(host, script));
}

export async function writeFile(
  exec: HostExec,
  host: HostTarget,
  path: string,
  content: string,
  roots: string[],
): Promise<void> {
  checkPathShape(path);
  const p = shellPath(path);
  // write to a temp file, then rename: no half-written files on failure
  await exec.runShell(host, `${guardPrefix(roots, [{ path }])}cat > ${p}.pibar-tmp && mv ${p}.pibar-tmp ${p}`, {
    stdin: content,
  });
}

const EXISTS = "__PIBAR_EXISTS__";

/** Default of MAX_UPLOAD_MB: largest upload in MB (it travels base64-encoded through the command router) */
export const DEFAULT_MAX_UPLOAD_MB = 25;

/** Upload limit in bytes from MAX_UPLOAD_MB (invalid or unset → 25 MB) */
export function maxUploadBytes(env: string | undefined = process.env.MAX_UPLOAD_MB): number {
  const n = Number(env);
  const mb = env !== undefined && env.trim() !== "" && Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_UPLOAD_MB;
  return Math.floor(mb * 1_000_000);
}

/** Decode and check the base64 payload of an upload before anything runs on the host (files.rs: decode_upload) */
export function decodeUpload(data: string, maxBytes: number): Buffer {
  const clean = data.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean) || clean.length % 4 === 1) throw new Error("Invalid upload data");
  // check the size before decoding, so an oversized payload never becomes a second big buffer
  if (Math.floor((clean.length * 3) / 4) - (clean.match(/=+$/)?.[0].length ?? 0) > maxBytes) {
    throw new Error(`File too large to upload (max. ${Math.round(maxBytes / 1_000_000)} MB)`);
  }
  return Buffer.from(clean, "base64");
}

/** Shell script that writes stdin to `path` (temp file, then rename); without `overwrite` an existing file is kept */
export function uploadScript(path: string, overwrite: boolean): string {
  const p = shellPath(path);
  const guard = overwrite ? "" : `if [ -e ${p} ]; then echo ${EXISTS}; exit 0; fi; `;
  return `${guard}cat > ${p}.pibar-tmp && mv ${p}.pibar-tmp ${p}`;
}

/** Upload a file of any type; returns false when the file exists and `overwrite` is off (the UI asks, then retries) */
export async function uploadFile(
  exec: HostExec,
  host: HostTarget,
  path: string,
  data: string,
  overwrite: boolean,
  maxBytes: number,
  roots: string[],
): Promise<boolean> {
  checkPathShape(path);
  if (path.endsWith("/")) throw new Error(`Not a file path: ${path}`);
  const bytes = decodeUpload(data, maxBytes);
  const out = await exec.runShell(host, guardPrefix(roots, [{ path }]) + uploadScript(path, overwrite), {
    stdin: bytes,
    timeoutMs: 300_000,
  });
  return out.trim() !== EXISTS;
}

/** Marker in front of a streamed download: "__PIBAR_DL__<size>" on its own line, then the raw bytes */
export const DL_MARK = "__PIBAR_DL__";

/**
 * Script of a download: guard, a regular file only, then the marker with the size and the bytes. Raw bytes instead
 * of the desktop's base64 (files.rs: download_script) – the webapp streams them to the browser; the marker keeps
 * anything a login shell prints before the script apart from the file.
 */
export function downloadScript(path: string, roots: string[]): string {
  const p = shellPath(path);
  return (
    `${guardPrefix(roots, [{ path }])}if [ ! -f ${p} ]; then echo "Not a file: "${p} >&2; exit 4; fi; ` +
    `s=$(wc -c < ${p} | tr -d ' ') && [ -n "$s" ] || exit 1; printf '${DL_MARK}%s\\n' "$s"; exec cat -- ${p}`
  );
}

/** Check a download before the browser fetches it: guard, regular file; returns the size in bytes */
export async function checkDownload(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<number> {
  checkPathShape(path);
  if (path.endsWith("/")) throw new Error(`Not a file path: ${path}`);
  const p = shellPath(path);
  const out = await exec.runShell(
    host,
    `${guardPrefix(roots, [{ path }])}if [ ! -f ${p} ]; then echo "Not a file: "${p} >&2; exit 4; fi; wc -c < ${p} | tr -d ' '`,
  );
  const n = Number(out.trim().split("\n").pop());
  return Number.isFinite(n) ? n : 0;
}

export async function createFile(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<void> {
  checkPathShape(path);
  const p = shellPath(path);
  await exec.runShell(host, `${guardPrefix(roots, [{ path }])}mkdir -p "$(dirname ${p})" && [ ! -e ${p} ] && : > ${p}`);
}

/** Subfolders of a folder on the host, for the folder picker */
export interface DirListing {
  /** Resolved absolute path */
  path: string;
  /** Home folder of the host */
  home: string;
  /** Names of the subfolders, sorted */
  dirs: string[];
}

/** Output: absolute path, home folder, then one subfolder name per line (files.rs: parse_dirs) */
export function parseDirs(out: string): DirListing | null {
  const lines = out.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  if (lines.length < 2) return null;
  const path = (lines[0] ?? "").trim();
  const home = (lines[1] ?? "").trim();
  const dirs = lines.slice(2).filter((l) => l !== "");
  dirs.sort((a, b) => {
    const x = a.toLowerCase();
    const y = b.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  });
  return { path, home, dirs };
}

/**
 * Folder picker (list_dirs): no root guard – a new session may start in any folder of the host, as on the desktop,
 * and the answer holds only folder names. The shape is checked so nothing odd reaches the shell.
 */
export async function listDirs(exec: HostExec, host: HostTarget, folder: string, hidden: boolean): Promise<DirListing> {
  checkFolderShape(folder);
  const filter = hidden ? "" : "! -name '.*'";
  const script = `cd ${shellPath(folder)} && pwd && echo "$HOME" && find . -mindepth 1 -maxdepth 1 -type d ${filter} 2>/dev/null | sed 's|^\\./||' | head -n 2000`;
  const d = parseDirs(await exec.runShell(host, script));
  if (!d) throw new Error("empty answer");
  return d;
}

/** Create a folder (with parents), e.g. a session folder that does not exist yet */
export async function createDir(exec: HostExec, host: HostTarget, path: string, roots: string[]): Promise<void> {
  checkFolderShape(path);
  await exec.runShell(host, `${guardPrefix(roots, [{ path }])}mkdir -p ${shellPath(path)}`);
}

/** Paths that may be deleted: the usual shape, and never a root ("/", "~", "~/") or a "." segment */
export function checkDeletePath(path: string): void {
  checkPathShape(path);
  const trimmed = path.replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "~") throw bad("root folder", path);
  if (path.split("/").some((seg) => seg === ".")) throw bad(".", path);
}

/** May `path` be deleted under these session folders? Strictly inside one of them, never the folder itself */
export function deletableUnder(path: string, roots: string[]): boolean {
  const p = path.replace(/\/+$/, "");
  return roots.some((root) => {
    const r = root.replace(/\/+$/, "");
    return r !== "" && p.length > r.length + 1 && p.startsWith(`${r}/`);
  });
}

/** First output line when the path does not exist (anymore) */
const GONE = "__PIBAR_GONE__";

/**
 * Delete a file or folder (with its content). Only paths strictly inside one of the tree's folders (`treeRoots`,
 * from the UI) go through, and the guard checks the folder it lies in on the host; a symlink loses only the link.
 */
export async function deletePath(
  exec: HostExec,
  host: HostTarget,
  path: string,
  treeRoots: string[],
  roots: string[],
): Promise<void> {
  checkDeletePath(path);
  if (!deletableUnder(path, treeRoots)) {
    throw new Error(`Only files and folders inside the session folders can be deleted: ${path}`);
  }
  const p = shellPath(path);
  // -h first: a symlink to a folder must lose only the link, not its target
  const script = `if [ -h ${p} ]; then rm -f -- ${p}; elif [ -d ${p} ]; then rm -rf -- ${p}; elif [ -e ${p} ]; then rm -f -- ${p}; else echo ${GONE}; fi`;
  // the tree roots themselves are resolved too: a path that is a root after resolving (a link to it) stays
  const checks: GuardCheck[] = [{ path, parent: true }];
  const guard = guardPrefix(roots, checks) + rootCheck(path, treeRoots);
  const out = await exec.runShell(host, guard + script);
  if (out.trim() === GONE) throw new Error("File or folder does not exist (anymore)");
}

/** Refuse a path that resolves to one of the tree roots or above one (e.g. "~/notes/sub/.." spelled differently) */
function rootCheck(path: string, treeRoots: string[]): string {
  const roots = treeRoots.filter((r) => r.trim()).map(shellPath);
  if (!roots.length) return "";
  return (
    `__t=$(pibar_real ${shellPath(path)}) || __t=; for __r in ${roots.join(" ")}; do __r=$(pibar_real "$__r") || continue; ` +
    `case $__r/ in "$__t"/*) echo "Path not allowed (root folder): "${sq(path)} >&2; exit 3 ;; esac; done\n`
  );
}
