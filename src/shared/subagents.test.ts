// Tests for the subagent parsing (shared/subagents.ts)
import { describe, expect, it } from "vitest";
import { subagentFromArgs, subagentFromDetails, subagentWorking } from "./subagents";

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
