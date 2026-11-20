// Plan mode of a session (src/main/sessionTab.ts): read-only tools while planning and the hint sent with each
// message. Build mode is Pi's normal work; the toggle lives in the header (src/main/chatView.ts).

/** Tools Pi may use while planning: it can look at everything but change nothing (no bash, edit or write) */
export const PLAN_TOOLS = ["read", "grep", "find", "ls"];

const PLAN_HINT =
  "Plan mode: read and analyse only. Do not modify files and do not run commands that change anything. " +
  "Reply with a short analysis and a numbered plan under a heading 'Plan:'. " +
  "Implementation happens only after the user approves the plan and switches to Build mode.";

const PLAN_RE = /\s*<plan-mode>[\s\S]*?<\/plan-mode>\s*/g;

/** Append the plan hint; slash commands (/skill:…, extension commands) stay unchanged */
export function withPlanMode(text: string, on: boolean): string {
  if (!on || text.trimStart().startsWith("/")) return text;
  return `${text}\n\n<plan-mode>${PLAN_HINT}</plan-mode>`;
}

/** Counterpart of withPlanMode: the message without the hint (for display and editing) */
export function stripPlanMode(text: string): string {
  return text.replace(PLAN_RE, "\n").trim();
}
