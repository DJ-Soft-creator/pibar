// Tests for the subagent parsing and model resolution (shared/subagents.ts)
import { describe, expect, it } from "vitest";
import { resolveAgentModel, subagentFromArgs, subagentFromDetails, subagentWaits, subagentWorking } from "./subagents";

describe("subagentFromArgs", () => {
  it("reads a single task", () => {
    const c = subagentFromArgs({ agent: "scout", task: "find auth" });
    expect(c).toEqual({
      mode: "single",
      runs: [{ agent: "scout", task: "find auth", status: "running", step: undefined }],
      done: false,
      isError: false,
    });
  });

  it("reads parallel tasks as pending", () => {
    const c = subagentFromArgs({
      tasks: [
        { agent: "scout", task: "a" },
        { agent: "reviewer", task: "b" },
      ],
    });
    expect(c?.mode).toBe("parallel");
    expect(c?.runs.map((r) => r.status)).toEqual(["pending", "pending"]);
  });

  it("numbers the steps of a chain", () => {
    const c = subagentFromArgs({
      chain: [
        { agent: "scout", task: "a" },
        { agent: "worker", task: "b {previous}" },
      ],
    });
    expect(c?.mode).toBe("chain");
    expect(c?.runs.map((r) => r.step)).toEqual([1, 2]);
  });

  it("rejects what is not a subagent call", () => {
    expect(subagentFromArgs(undefined)).toBeNull();
    expect(subagentFromArgs({ command: "ls" })).toBeNull();
    expect(subagentFromArgs({ tasks: [] })).toBeNull();
  });
});

describe("subagentFromDetails", () => {
  it("reads the results of the extension", () => {
    const c = subagentFromDetails({
      mode: "parallel",
      isError: false,
      results: [
        { agent: "scout", task: "a", status: "completed" },
        { agent: "worker", task: "b", status: "running" },
      ],
    });
    expect(c?.mode).toBe("parallel");
    expect(c?.runs.map((r) => r.status)).toEqual(["completed", "running"]);
  });

  it("ignores foreign details and empty results", () => {
    expect(subagentFromDetails({})).toBeNull();
    expect(subagentFromDetails({ results: [] })).toBeNull();
    expect(subagentFromDetails(undefined)).toBeNull();
  });
});

describe("subagentWorking", () => {
  it("is true while a run is pending or running, false when done", () => {
    const call = {
      mode: "single" as const,
      runs: [{ agent: "x", task: "", status: "running" as const }],
      done: false,
      isError: false,
    };
    expect(subagentWorking(call)).toBe(true);
    expect(subagentWorking({ ...call, done: true })).toBe(false);
    expect(subagentWorking({ ...call, runs: [{ agent: "x", task: "", status: "completed" }] })).toBe(false);
  });
});

describe("resolveAgentModel", () => {
  const parent = { provider: "anthropic", id: "claude-opus-4-5" };
  const models = [
    { provider: "anthropic", id: "claude-haiku-4-5" },
    { provider: "openai", id: "gpt-5" },
  ];

  it("takes the parent session's model when the agent has none (never Pi's default)", () => {
    expect(resolveAgentModel("", "", parent, models)).toEqual(parent);
    expect(resolveAgentModel("agent", "", parent, models)).toEqual(parent);
    expect(resolveAgentModel("session", "anthropic/claude-haiku-4-5", parent, models)).toEqual(parent);
  });

  it("takes the agent's model, with or without provider", () => {
    expect(resolveAgentModel("", "openai/gpt-5", parent, models)).toEqual({ provider: "openai", id: "gpt-5" });
    expect(resolveAgentModel("agent", "claude-haiku-4-5", parent, models)).toEqual(models[0]);
  });

  it("falls back to the parent's model when a bare agent model is unknown", () => {
    expect(resolveAgentModel("", "no-such-model", parent, models)).toEqual(parent);
  });

  it("takes an explicit choice from the dialog", () => {
    expect(resolveAgentModel("openai/gpt-5", "anthropic/claude-haiku-4-5", parent, models)).toEqual({
      provider: "openai",
      id: "gpt-5",
    });
  });

  it("returns null when nothing is known", () => {
    expect(resolveAgentModel("", "", null, models)).toBeNull();
    expect(resolveAgentModel("session", "", null, models)).toBeNull();
  });
});

describe("subagentWaits", () => {
  it("sequential (and unset) waits while another subagent runs", () => {
    expect(subagentWaits("sequential", 1)).toBe(true);
    expect(subagentWaits(undefined, 2)).toBe(true);
    expect(subagentWaits("sequential", 0)).toBe(false);
    expect(subagentWaits(undefined, 0)).toBe(false);
  });

  it("parallel never waits", () => {
    expect(subagentWaits("parallel", 0)).toBe(false);
    expect(subagentWaits("parallel", 3)).toBe(false);
  });
});
