// Agent definitions for subagent sessions (port of src-tauri/src/agents.rs): read `~/.pi/agent/agents/*.md` and the
// nearest `.pi/agents/*.md` above the working folder on the host, parse their frontmatter, and write an agent's system
// prompt (the body without the frontmatter) to a file below `~/.pibar` that Pi gets via `--append-system-prompt`.
import { hash } from "./bg.js";
import { shellPath, sq, type HostExec, type HostTarget } from "./hostexec.js";

/** One agent definition (AgentInfo of src/shared/api.ts) */
export interface AgentInfo {
  name: string;
  description: string;
  /** Tool allowlist, null = Pi's default */
  tools: string[] | null;
  /** "provider/id" or a bare id, "" = the parent session's model */
  model: string;
  /** "user" (~/.pi/agent/agents) or "project" (.pi/agents) */
  source: string;
  path: string;
}

/** Marker lines around each file in the listing script's output */
const BEGIN = "===PIBAR-AGENT ";
const END = "===PIBAR-END";

/** Shell script that prints every agent file with its source and path, user agents first (project ones override) */
export function listScript(cwd: string): string {
  return `cd ${shellPath(cwd)} 2>/dev/null || exit 0
emit() {
  [ -d "$1" ] || return 0
  for f in "$1"/*.md; do
    [ -f "$f" ] || continue
    printf '${BEGIN}%s %s\\n' "$2" "$f"
    cat "$f"
    printf '\\n${END}\\n'
  done
}
emit "$HOME/.pi/agent/agents" user
d=$PWD
while :; do
  if [ -d "$d/.pi/agents" ]; then emit "$d/.pi/agents" project; break; fi
  [ "$d" = "/" ] && break
  d=$(dirname "$d")
done`;
}

/** Frontmatter value: a bare scalar, quotes removed */
function fmValue(v: string): string {
  return v
    .trim()
    .replace(/^["']+|["']+$/g, "")
    .trim();
}

/** Split a Markdown file into its frontmatter (between the first two "---" lines) and its body */
export function splitFrontmatter(content: string): { fm: string; body: string } | null {
  let rest: string;
  if (content.startsWith("---\n")) rest = content.slice(4);
  else if (content.startsWith("---\r\n")) rest = content.slice(5);
  else return null;
  const end = rest.indexOf("\n---");
  if (end < 0) return null;
  const fm = rest.slice(0, end);
  const after = rest.slice(end + 4);
  const body = after.startsWith("\n") ? after.slice(1) : after.startsWith("\r\n") ? after.slice(2) : after;
  return { fm, body };
}

/** Parse one agent file: frontmatter (name and description required) */
export function parseAgent(content: string, source: string, path: string): AgentInfo | null {
  const split = splitFrontmatter(content);
  if (!split) return null;
  let name = "";
  let description = "";
  let tools: string[] | null = null;
  let model = "";
  for (const line of split.fm.split("\n")) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    const value = fmValue(line.slice(i + 1));
    if (key === "name") name = value;
    else if (key === "description") description = value;
    else if (key === "model") model = value;
    else if (key === "tools") {
      const list = value
        .replace(/^\[+/, "")
        .replace(/\]+$/, "")
        .split(",")
        .map(fmValue)
        .filter(Boolean);
      if (list.length) tools = list;
    }
  }
  if (!name || !description) return null;
  return { name, description, tools, model, source, path };
}

/** Parse the listing script's output; a project agent overrides a user agent with the same name */
export function parseListing(out: string): AgentInfo[] {
  const agents: AgentInfo[] = [];
  let cur: { source: string; path: string; lines: string[] } | null = null;
  const flush = () => {
    if (!cur) return;
    const a = parseAgent(cur.lines.join("\n"), cur.source, cur.path);
    cur = null;
    if (!a) return;
    const old = agents.findIndex((x) => x.name === a.name);
    if (old >= 0) agents[old] = a;
    else agents.push(a);
  };
  for (const line of out.split("\n")) {
    if (line.startsWith(BEGIN)) {
      flush();
      const rest = line.slice(BEGIN.length);
      const sp = rest.indexOf(" ");
      cur = sp < 0 ? { source: "user", path: rest, lines: [] } : { source: rest.slice(0, sp), path: rest.slice(sp + 1), lines: [] };
    } else if (line === END) {
      flush();
    } else if (cur) {
      cur.lines.push(line);
    }
  }
  return agents;
}

export async function listAgents(exec: HostExec, host: HostTarget, cwd: string): Promise<AgentInfo[]> {
  return parseListing(await exec.runShell(host, listScript(cwd)));
}

/**
 * An agent definition as list_agents reports it: a Markdown file in an agents folder. Stricter than agents.rs (which
 * only wants ".md"): webapp users are remote, so the command must not read any Markdown file of the host.
 */
export function isAgentPath(path: string): boolean {
  if (!path.endsWith(".md") || /[\0-\x1f]/.test(path) || path.split("/").includes("..")) return false;
  return /\/\.pi\/agent\/agents\/[^/]+\.md$/.test(path) || /\/\.pi\/agents\/[^/]+\.md$/.test(path);
}

/**
 * Write an agent's system prompt (the body of its file) below `~/.pibar/agent-prompts` on the host and return the
 * absolute path. The file stays there, so a child session opened again later keeps its agent prompt.
 */
export async function agentPromptFile(exec: HostExec, host: HostTarget, path: string): Promise<string> {
  if (!isAgentPath(path)) throw new Error("not an agent file");
  const content = await exec.runShell(host, `cat ${sq(path)}`);
  const split = splitFrontmatter(content);
  if (!split) throw new Error("agent file has no frontmatter");
  const file = `prompt-${hash(path)}.md`;
  const script = `mkdir -p "$HOME/.pibar/agent-prompts" && cat > "$HOME/.pibar/agent-prompts/${file}" && printf '%s\\n' "$HOME/.pibar/agent-prompts/${file}"`;
  return (await exec.runShell(host, script, { stdin: split.body })).trim();
}
