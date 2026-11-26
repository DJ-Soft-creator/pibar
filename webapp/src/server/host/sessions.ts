// A host's sessions from Pi's session folder (~/.pi/agent/sessions) – port of src-tauri/src/sessions.rs (list,
// outlines, delete, search, touches, export). Same shell scripts, same parsing, same answers as the
// desktop (types SessionInfo/SessionOutline in src/shared/api.ts and src/shared/branches.ts).
import { sq, type HostExec, type HostTarget } from "./hostexec.js";

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  timestamp: string;
  title: string;
  name: string | null;
  /** Session this one was branched from (header parentSession, set by Pi's fork) */
  parent: string | null;
  /** Last change of the file, seconds since the epoch; 0 = unknown */
  modified: number;
}

export interface UserEntry {
  id: string;
  text: string;
}

export interface SessionOutline {
  path: string;
  /** Last change, seconds since the epoch (0 = unknown) */
  mtime: number;
  users: UserEntry[];
}

/** Newest 300 session files: path, mtime, header line, first own message, last session_info (tab separated) */
export const LIST_SCRIPT = `
dir="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$dir" ] || exit 0
ls -t "$dir"/*/*.jsonl 2>/dev/null | head -n 300 | while IFS= read -r f; do
  printf '%s\\t%s\\t' "$f" "$(date -r "$f" +%s 2>/dev/null)"
  head -n 1 "$f" | tr -d '\\t\\n'
  printf '\\t'
  grep -m1 '"role":"user"' "$f" | cut -c1-2000 | tr -d '\\t\\n'
  printf '\\t'
  grep '"type":"session_info"' "$f" | tail -n 1 | tr -d '\\t\\n'
  printf '\\n'
done
`;

/** The first text of a (possibly cut) JSON line: escapes resolved, whitespace collapsed, about 120 characters */
export function firstText(raw: string): string {
  const key = '"text":"';
  const start = raw.indexOf(key);
  if (start < 0) return "";
  const chars = [...raw.slice(start + key.length)];
  let out = "";
  let count = 0;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c === '"') break;
    if (c === "\\") {
      const next = chars[++i];
      if (next === undefined) break;
      out += next === "n" || next === "t" || next === "r" ? " " : next;
    } else {
      out += c;
    }
    count++;
    if (count > 120) break;
  }
  return out.split(/\s+/).filter(Boolean).join(" ");
}

function parseJson(text: string | undefined): Record<string, unknown> | null {
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** Lines of LIST_SCRIPT → sessions (empty sessions without an own message are skipped, like on the desktop) */
export function parseList(out: string): SessionInfo[] {
  const result: SessionInfo[] = [];
  for (const line of out.split("\n")) {
    // splitn(5, '\t'): the last part keeps any further tabs
    const parts = line.split("\t");
    if (parts.length < 4) continue;
    const [path = "", mtime = "", headerRaw, userRaw = ""] = parts;
    const infoRaw = parts.length > 4 ? parts.slice(4).join("\t") : undefined;
    const title = firstText(userRaw);
    if (!title) continue;
    const header = parseJson(headerRaw) ?? {};
    const info = parseJson(infoRaw);
    const modified = Number.parseInt(mtime.trim(), 10);
    result.push({
      path,
      id: str(header.id),
      cwd: str(header.cwd),
      timestamp: str(header.timestamp),
      title,
      name: info && typeof info.name === "string" ? info.name : null,
      parent: typeof header.parentSession === "string" ? header.parentSession : null,
      modified: Number.isFinite(modified) ? modified : 0,
    });
  }
  return result;
}

export async function listSessions(exec: HostExec, host: HostTarget): Promise<SessionInfo[]> {
  return parseList(await exec.runShell(host, LIST_SCRIPT));
}

/** Only absolute paths of .jsonl files inside a "sessions" folder, without . or .. segments */
export function isSessionFile(path: string): boolean {
  return (
    path.startsWith("/") &&
    path.endsWith(".jsonl") &&
    path.includes("/sessions/") &&
    !path.split("/").some((seg) => seg === ".." || seg === ".")
  );
}

function checkSessionFiles(paths: string[]) {
  const bad = paths.find((p) => !isSessionFile(p));
  if (bad !== undefined) throw new Error(`Not a Pi session file: ${bad}`);
}

/** Delete session files on the host; returns how many paths were handed over */
export async function deleteSessions(exec: HostExec, host: HostTarget, paths: string[]): Promise<number> {
  checkSessionFiles(paths);
  if (paths.length === 0) return 0;
  await exec.runShell(host, `rm -f -- ${paths.map(sq).join(" ")}`);
  return paths.length;
}

export const OUTLINE_MARK = "__PIBAR_OUTLINE__";

/** The value of the first "id":"…" of a JSON line (for a message entry: the entry id) */
export function entryId(line: string): string | null {
  const key = '"id":"';
  const start = line.indexOf(key);
  if (start < 0) return null;
  const end = line.indexOf('"', start + key.length);
  return end < 0 ? null : line.slice(start + key.length, end);
}

export function parseOutlines(out: string): SessionOutline[] {
  const result: SessionOutline[] = [];
  for (const line of out.split("\n")) {
    if (line.startsWith(OUTLINE_MARK)) {
      const rest = line.slice(OUTLINE_MARK.length).replace(/^\t+/, "");
      const tab = rest.indexOf("\t");
      const path = tab < 0 ? rest : rest.slice(0, tab);
      const mtime = tab < 0 ? NaN : Number.parseInt(rest.slice(tab + 1).trim(), 10);
      result.push({ path, mtime: Number.isFinite(mtime) ? mtime : 0, users: [] });
      continue;
    }
    const cur = result.at(-1);
    const id = entryId(line);
    if (cur && id !== null) cur.users.push({ id, text: firstText(line) });
  }
  return result;
}

function outlineScript(paths: string[]): string {
  return (
    `for f in ${paths.map(sq).join(" ")}; do [ -f "$f" ] || continue; ` +
    `printf '${OUTLINE_MARK}\\t%s\\t%s\\n' "$f" "$(date -r "$f" +%s 2>/dev/null)"; ` +
    `grep -F '"type":"message"' "$f" | grep -F '"role":"user"' | cut -c1-3000; done`
  );
}

/** User messages per session file (entry id + start of the text): where branches part (src/shared/branches.ts) */
export async function sessionOutlines(exec: HostExec, host: HostTarget, paths: string[]): Promise<SessionOutline[]> {
  checkSessionFiles(paths);
  if (paths.length === 0) return [];
  return parseOutlines(await exec.runShell(host, outlineScript(paths)));
}

// ---------------------------------------------------------------- search in the messages of all sessions (B4)

/**
 * A session file with a message that contains the search text. Title and folder come from the file itself, so a hit
 * also works for a session that is no longer in the list of the newest ones (sessions.rs: SearchHit).
 */
export interface SearchHit {
  path: string;
  cwd: string;
  /** Name from Pi (session_info) or the first own message; empty if the file has neither */
  title: string;
  /** Role of that message: "user", "assistant" or a tool result */
  role: string;
  /** Text around the match (JSON escapes removed, leading and trailing "…" where it was cut) */
  snippet: string;
}

/** Session files one host reports per search: the newest matches are enough to pick one */
export const SEARCH_MAX_FILES = 40;
/** Characters of a matching line that cross the wire (a tool result can be megabytes) */
export const SEARCH_LINE_CHARS = 4000;
/** Characters of the message kept around the match */
export const SNIPPET_CHARS = 160;

/**
 * One `grep` over all session files of the host, first matching line per file, plus the header line and the first
 * own message of each hit (path, header, first message, matching line – separated by tabs). Same script as Rust.
 */
export function searchScript(query: string): string {
  return `dir="\${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions"
[ -d "$dir" ] || exit 0
grep -i -H -m1 -F -- ${sq(query)} "$dir"/*/*.jsonl 2>/dev/null | head -n ${SEARCH_MAX_FILES} | while IFS= read -r hit; do
  f="\${hit%%:*}"
  printf '%s\\t%s\\t%s\\t%s\\n' "$f" \\
    "$(head -n 1 "$f" | cut -c1-2000 | tr -d '\\t')" \\
    "$(grep -m1 -F '"role":"user"' "$f" | cut -c1-2000 | tr -d '\\t')" \\
    "$(printf '%s' "\${hit#*:}" | cut -c1-${SEARCH_LINE_CHARS})"
done || true
`;
}

/** Every string inside a JSON value in reading order; object keys sorted like serde_json's map */
function textsOf(v: unknown, out: string[]) {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) textsOf(x, out);
  else if (typeof v === "object" && v !== null) {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o).sort()) textsOf(o[k], out);
  }
}

const TRIM_CHARS = new Set(['"', ":", ",", "{", "}", "[", "]"]);

function trimJsonChars(s: string): string {
  const chars = [...s];
  let a = 0;
  let b = chars.length;
  while (a < b && TRIM_CHARS.has(chars[a] as string)) a++;
  while (b > a && TRIM_CHARS.has(chars[b - 1] as string)) b--;
  return chars.slice(a, b).join("");
}

/** Text around the (case insensitive) match, whitespace collapsed; null if the text does not contain it */
export function snippetWindow(text: string, qLower: string): string | null {
  const lower = text.toLowerCase();
  const at = lower.indexOf(qLower);
  if (at < 0) return null;
  const cut = SNIPPET_CHARS / 2;
  const chars = [...text];
  // the lowercase copy can have other char counts (İ, ß …): stay near the match, that is enough for a snippet
  const hit = Math.min([...lower.slice(0, at)].length, Math.max(0, chars.length - 1));
  const start = Math.max(0, hit - cut);
  const end = Math.min(start + SNIPPET_CHARS, chars.length);
  const body = chars.slice(start, end).join("").split(/\s+/).filter(Boolean).join(" ");
  return `${start > 0 ? "…" : ""}${trimJsonChars(body)}${end < chars.length ? "…" : ""}`;
}

/** JSON escapes of a raw line as readable text (for a line the shell cut short, which no longer parses) */
export function unescapeJson(raw: string): string {
  let out = "";
  const chars = [...raw];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i] as string;
    if (c !== "\\") {
      out += c;
      continue;
    }
    const next = chars[++i];
    if (next === undefined) break;
    if (next === "n" || next === "t" || next === "r") out += " ";
    else if (next === "u") {
      i += 4;
      out += " ";
    } else out += next;
  }
  return out;
}

/** Role from the raw line, for a line the shell cut short (it no longer parses as JSON) */
function rawRole(raw: string): string {
  const key = '"role":"';
  const start = raw.indexOf(key);
  if (start < 0) return "";
  const rest = raw.slice(start + key.length);
  const end = rest.indexOf('"');
  return end < 0 ? "" : rest.slice(0, end);
}

/**
 * Role of the matching message and the text around the match. The line is parsed as JSON when it is whole (a tool
 * result can be cut by the shell); then the snippet is clean text instead of the raw JSON around the match.
 */
export function snippetFor(raw: string, qLower: string): [string, string] {
  let entry: unknown = null;
  try {
    entry = JSON.parse(raw);
  } catch {
    /* cut by the shell */
  }
  const message =
    typeof entry === "object" && entry !== null && !Array.isArray(entry) ? (entry as Record<string, unknown>).message : undefined;
  const m = typeof message === "object" && message !== null ? (message as Record<string, unknown>) : null;
  const role = m && typeof m.role === "string" ? m.role : rawRole(raw);
  const found: string[] = [];
  if (m) textsOf(m.content ?? m, found);
  for (const text of found) {
    const s = snippetWindow(text, qLower);
    if (s !== null) return [role, s];
  }
  return [role, snippetWindow(unescapeJson(raw), qLower) ?? ""];
}

/** Lines of searchScript: path, header, first message and the matching line, separated by tabs */
export function parseHits(out: string, query: string): SearchHit[] {
  const qLower = query.toLowerCase();
  const hits: SearchHit[] = [];
  for (const line of out.split("\n")) {
    const parts = line.split("\t");
    // shell chatter before the first hit (a greeting, a prompt)
    if (parts.length < 4) continue;
    const [path = "", headerRaw = "", firstRaw = ""] = parts;
    const raw = parts.slice(3).join("\t");
    if (!isSessionFile(path) || hits.some((h) => h.path === path)) continue;
    const header = parseJson(headerRaw) ?? {};
    const cwd = str(header.cwd);
    let [role, snippet] = snippetFor(raw, qLower);
    // a line cut by the shell can hide the match behind the cut: the session still counts as a hit, shown with the
    // beginning of the message instead of the text around the match
    if (!snippet) snippet = snippetWindow(unescapeJson(raw), "") ?? "";
    if (!snippet) continue;
    hits.push({ path, cwd, title: firstText(firstRaw), role, snippet });
  }
  return hits;
}

/** The query as the hosts get it: single spaces, at most 200 characters */
export function searchQuery(query: string): string {
  return [...query.split(/\s+/).filter(Boolean).join(" ")].slice(0, 200).join("");
}

/** Sessions of a host whose messages contain `query` (one file per hit; the UI orders them by its session list) */
export async function searchSessions(exec: HostExec, host: HostTarget, query: string): Promise<SearchHit[]> {
  const q = searchQuery(query);
  // one letter matches everything and would ask the host on every keystroke
  if ([...q].length < 2) return [];
  return parseHits(await exec.runShell(host, searchScript(q)), q);
}

// ---------------------------------------------------------------- files Pi changed per own message (B4)

/** Tools that change files: the `path` (or `file_path`) of their call is the file Pi wrote */
export const FILE_TOOLS = ["edit", "write", "multi_edit", "create"];

/** The files Pi changed after one own message: its entry id and the paths as Pi named them */
export interface MessageTouches {
  id: string;
  paths: string[];
}

/**
 * Files per own message of a session file, in file order like parseOutlines: the tool calls of an assistant message
 * belong to the user message before them.
 */
export function touchedByMessage(text: string): MessageTouches[] {
  const result: MessageTouches[] = [];
  for (const line of text.split("\n")) {
    const entry = parseJson(line);
    const message = entry?.message;
    if (!entry || typeof message !== "object" || message === null || Array.isArray(message)) continue;
    const m = message as Record<string, unknown>;
    if (m.role === "user") {
      result.push({ id: str(entry.id), paths: [] });
    } else if (m.role === "assistant") {
      const parts = Array.isArray(m.content) ? m.content : [];
      for (const part of parts) {
        if (typeof part !== "object" || part === null) continue;
        const p = part as Record<string, unknown>;
        if (p.type !== "toolCall" || typeof p.name !== "string" || !FILE_TOOLS.includes(p.name)) continue;
        const a = typeof p.arguments === "object" && p.arguments !== null ? (p.arguments as Record<string, unknown>) : {};
        // like Rust: `path` if present, otherwise `file_path`; only strings count
        const path = "path" in a ? a.path : a.file_path;
        const bucket = result.at(-1);
        if (typeof path === "string" && bucket && !bucket.paths.includes(path)) bucket.paths.push(path);
      }
    }
  }
  return result;
}

function notSessionFile(path: string): Error {
  return new Error(`Not a Pi session file: ${path}`);
}

export function touchesScript(path: string): string {
  return `grep -F -e '"role":"user"' -e '"type":"toolCall"' -- ${sq(path)} || true`;
}

/** Files Pi changed per own message of the session file `path` */
export async function sessionTouches(exec: HostExec, host: HostTarget, path: string): Promise<MessageTouches[]> {
  if (!isSessionFile(path)) throw notSessionFile(path);
  return touchedByMessage(await exec.runShell(host, touchesScript(path)));
}

// ---------------------------------------------------------------- whole session file for the export (B4)

/** Largest file that is read (files.rs MAX_DOWNLOAD: it travels base64-encoded) */
export const MAX_DOWNLOAD = 50_000_000;
export const DL_TOO_LARGE = "__PIBAR_DL_TOO_LARGE__";

/** files.rs download_script: the file as base64 on one line; a file over the limit comes back as a marker */
export function downloadScript(path: string): string {
  const p = sq(path);
  return `s=$(wc -c < ${p} | tr -d ' ') && [ -n "$s" ] || exit 1; if [ "$s" -gt ${MAX_DOWNLOAD} ]; then echo ${DL_TOO_LARGE}; exit 0; fi; base64 < ${p} | tr -d '\\n'`;
}

/** files.rs parse_download: decode the base64 answer; the too-large marker becomes an error */
export function parseDownload(out: string): Buffer {
  const s = out.trim();
  if (s === DL_TOO_LARGE) throw new Error("File too large to download (max. 50 MB)");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) throw new Error("Invalid download data");
  return Buffer.from(s, "base64");
}

/**
 * Whole session file as JSONL text (read_session_file: export dialog, sessions.rs export). Only Pi session files,
 * read through the same download script as files.rs, so it works over SSH too (max. 50 MB).
 */
export async function readSessionFile(exec: HostExec, host: HostTarget, path: string): Promise<string> {
  if (!isSessionFile(path)) throw notSessionFile(path);
  const bytes = parseDownload(await exec.runShell(host, downloadScript(path), { timeoutMs: 120_000 }));
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("Session file is not valid UTF-8 text");
  }
}
