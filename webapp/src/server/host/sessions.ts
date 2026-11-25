// A host's sessions from Pi's session folder (~/.pi/agent/sessions) – port of src-tauri/src/sessions.rs (list,
// outlines, delete; search/export/touches follow with task B4). Same shell scripts, same parsing, same answers as the
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
