// Tests for the plan mode hint (shared/planMode.ts)
import { describe, expect, it } from "vitest";
import { PLAN_TOOLS, stripPlanMode, withPlanMode } from "./planMode";

describe("plan mode", () => {
  it("plan tools are read-only", () => {
    expect(PLAN_TOOLS).toEqual(["read", "grep", "find", "ls"]);
    for (const t of ["bash", "edit", "write"]) expect(PLAN_TOOLS).not.toContain(t);
  });

  it("appends the hint only in plan mode", () => {
    expect(withPlanMode("Look at this", false)).toBe("Look at this");
    const out = withPlanMode("Look at this", true);
    expect(out.startsWith("Look at this\n\n<plan-mode>")).toBe(true);
    expect(out).toContain("numbered plan");
  });

  it("leaves slash commands unchanged", () => {
    expect(withPlanMode("/compact", true)).toBe("/compact");
    expect(withPlanMode("  /skill:x do it", true)).toBe("  /skill:x do it");
  });

  it("strips the hint again", () => {
    expect(stripPlanMode(withPlanMode("Look at this", true))).toBe("Look at this");
    expect(stripPlanMode("plain text")).toBe("plain text");
  });
});
