// Context mode of a session (Pi extension `mode-guard`): private sends the whole context, public leaves out the
// sections in `stripped` (project context, skills, MCP servers, …). The extension reports its state through a footer
// status; these pure helpers read that line and build the commands Pi understands.

/** "private" = full context, "public" = reduced context, "" = the extension has not reported a mode yet */
export type ContextMode = "private" | "public" | "";

/** Sections Pi can send; the extension strips them by name (see /strip and /keep) */
export const CONTEXT_SECTIONS = [
  "preamble",
  "tools",
  "rules",
  "docs",
  "project_context",
  "skills",
  "cwd",
  "mcp_servers",
  "addendum",
] as const;

export interface ContextStatus {
  mode: ContextMode;
  /** Sections the extension leaves out in public mode */
  stripped: string[];
}

/**
 * Read the status line of the mode-guard extension. It looks like
 * "🔒 private · voller Kontext" or "☁ public · ohne project_context, skills, mcp_servers".
 * Unknown text yields no mode, so the UI stays out of the way.
 */
export function parseContextStatus(text: string | undefined | null): ContextStatus {
  const line = (text ?? "").trim();
  if (!line) return { mode: "", stripped: [] };
  const mode: ContextMode = /\bpublic\b/i.test(line) ? "public" : /\bprivate\b/i.test(line) ? "private" : "";
  // the extension names the stripped sections after "ohne" (German) or "without"
  const rest = line.match(/\b(?:ohne|without)\s+(.+)$/i)?.[1] ?? "";
  const stripped = rest
    .split(/[,\u00b7]/)
    .map((s) => s.trim())
    .filter((s) => /^[a-z][a-z0-9_]*$/i.test(s));
  // keep the names also when the extension currently runs in public: switching back keeps its section choice
  return { mode, stripped: [...new Set(stripped)] };
}

/** RPC prompt text that switches the extension to private or public */
export function contextModeCommand(mode: "private" | "public"): string {
  return `/mode ${mode}`;
}

/** RPC prompt text that takes one section out of public mode (`keep` = put it back in) */
export function contextSectionCommand(name: string, keep: boolean): string {
  return `/${keep ? "keep" : "strip"} ${name}`;
}

/** RPC prompt text that makes Pi list the sections it sends right now (arrives as a notice) */
export const CONTEXT_SECTIONS_COMMAND = "/sections";

/** Is `mode` one of the two modes of the extension? (for data from the settings file) */
export function isContextMode(mode: unknown): mode is "private" | "public" {
  return mode === "private" || mode === "public";
}

/**
 * Mode a session starts with: the mode fixed for its project, else PiBar's default from the settings; "" = the
 * extension decides. A session switched in the header keeps its own mode (SessionMeta.contextMode).
 */
export function startContextMode(projectMode?: string, settingsMode?: string): ContextMode {
  if (isContextMode(projectMode)) return projectMode;
  return isContextMode(settingsMode) ? settingsMode : "";
}
