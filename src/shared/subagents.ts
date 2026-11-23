// Subagents of a session, pure logic (src/main/subagents.ts renders them): the runs of a "subagent" tool call
// (Pi's subagent extension) from its arguments and from the details of its partial/final results, and the model
// a subagent session of PiBar runs with (the agent's, the parent session's or an explicit choice).

/** Status of one subagent run, as the extension reports it */
export type SubagentStatus = "pending" | "running" | "completed" | "failed" | "aborted";

/** One delegated task: an agent with its task text and current status */
export interface SubagentRun {
  agent: string;
  task: string;
  status: SubagentStatus;
  /** Step number in a chain (1-based), undefined for single/parallel */
  step?: number;
}

/** A "subagent" tool call of a session: single, parallel or chain, with its runs */
export interface SubagentCall {
  mode: "single" | "parallel" | "chain";
  runs: SubagentRun[];
  /** The tool call ended (result is final) */
  done: boolean;
  isError: boolean;
}

const STATUSES: SubagentStatus[] = ["pending", "running", "completed", "failed", "aborted"];

function cleanRun(x: unknown, fallbackStatus: SubagentStatus): SubagentRun | null {
  if (!x || typeof x !== "object") return null;
  const r = x as Record<string, unknown>;
  const agent = typeof r.agent === "string" ? r.agent.trim() : "";
  const task = typeof r.task === "string" ? r.task : "";
  if (!agent) return null;
  const status = STATUSES.includes(r.status as SubagentStatus) ? (r.status as SubagentStatus) : fallbackStatus;
  const step = typeof r.step === "number" && r.step > 0 ? r.step : undefined;
  return { agent, task, status, step };
}

/** Mode and runs from the arguments of a subagent tool call (single {agent,task}, parallel {tasks}, chain {chain}) */
export function subagentFromArgs(args: unknown): SubagentCall | null {
  if (!args || typeof args !== "object") return null;
  const a = args as Record<string, unknown>;
  const list = Array.isArray(a.tasks) ? a.tasks : Array.isArray(a.chain) ? a.chain : null;
  if (list) {
    const mode = Array.isArray(a.chain) ? "chain" : "parallel";
    const runs = list.map((x) => cleanRun(x, "pending")).filter((r): r is SubagentRun => !!r);
    if (mode === "chain") runs.forEach((r, i) => (r.step = i + 1));
    return runs.length ? { mode, runs, done: false, isError: false } : null;
  }
  const one = cleanRun(a, "running");
  return one ? { mode: "single", runs: [one], done: false, isError: false } : null;
}

/** Runs from the details of a partial or final result ({mode, results:[{agent,task,status,…}], isError}) */
export function subagentFromDetails(details: unknown): Omit<SubagentCall, "done"> | null {
  if (!details || typeof details !== "object") return null;
  const d = details as Record<string, unknown>;
  if (!Array.isArray(d.results)) return null;
  const mode = d.mode === "parallel" || d.mode === "chain" ? d.mode : "single";
  const runs = d.results.map((x) => cleanRun(x, "running")).filter((r): r is SubagentRun => !!r);
  if (!runs.length) return null;
  return { mode, runs, isError: !!d.isError };
}

/** Is one of the runs still going (pending or running)? */
export function subagentWorking(call: SubagentCall): boolean {
  return !call.done && call.runs.some((r) => r.status === "pending" || r.status === "running");
}

/**
 * Model a subagent session runs with – never Pi's default: the explicit choice of the dialog ("provider/id"),
 * "session" = the parent session's model, "agent"/"" = the agent's model ("provider/id" or a bare id looked up
 * in the model list). An agent without a model – or with one the host does not know – falls back to the parent's.
 * null = nothing known (the parent has no model either); the caller then leaves Pi as it started.
 */
export function resolveAgentModel(
  choice: string,
  agentModel: string,
  parentModel: { provider: string; id: string } | null,
  models: { provider: string; id: string }[],
): { provider: string; id: string } | null {
  if (choice === "session") return parentModel;
  const want = choice === "agent" || choice === "" ? agentModel : choice;
  if (!want) return parentModel;
  const i = want.indexOf("/");
  if (i > 0) return { provider: want.slice(0, i), id: want.slice(i + 1) };
  return models.find((m) => m.id === want) ?? parentModel;
}

/**
 * Does a new subagent have to wait its turn? In sequential mode (the default, also when the setting is unset) it
 * waits while another one is running; in parallel mode it never waits. Only PiBar's own child sessions are gated.
 */
export function subagentWaits(mode: "sequential" | "parallel" | undefined, activeCount: number): boolean {
  return mode !== "parallel" && activeCount > 0;
}
