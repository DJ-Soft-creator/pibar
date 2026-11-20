import { describe, expect, it } from "vitest";
import {
  CONTEXT_SECTIONS,
  contextModeCommand,
  contextSectionCommand,
  isContextMode,
  parseContextStatus,
  startContextMode,
} from "./contextMode";

describe("context mode", () => {
  it("reads private and public from the status line", () => {
    expect(parseContextStatus("🔒 private · voller Kontext")).toEqual({ mode: "private", stripped: [] });
    expect(parseContextStatus("☁ public · ohne project_context, skills, mcp_servers")).toEqual({
      mode: "public",
      stripped: ["project_context", "skills", "mcp_servers"],
    });
  });

  it("ignores unknown text and empty statuses", () => {
    expect(parseContextStatus(undefined)).toEqual({ mode: "", stripped: [] });
    expect(parseContextStatus("")).toEqual({ mode: "", stripped: [] });
    expect(parseContextStatus("something else")).toEqual({ mode: "", stripped: [] });
  });

  it("keeps the section choice when the mode changes and accepts English wording", () => {
    expect(parseContextStatus("private · ohne docs")).toEqual({ mode: "private", stripped: ["docs"] });
    expect(parseContextStatus("public · without docs, rules").stripped).toEqual(["docs", "rules"]);
  });

  it("builds the commands Pi's extension expects", () => {
    expect(contextModeCommand("public")).toBe("/mode public");
    expect(contextSectionCommand("docs", false)).toBe("/strip docs");
    expect(contextSectionCommand("docs", true)).toBe("/keep docs");
    expect(isContextMode("public") && isContextMode("private")).toBe(true);
    expect(isContextMode("")).toBe(false);
    expect(CONTEXT_SECTIONS).toContain("project_context");
  });

  it("lets the project win over the setting, and the setting over the extension", () => {
    expect(startContextMode("public", "private")).toBe("public");
    expect(startContextMode("", "private")).toBe("private");
    expect(startContextMode(undefined, undefined)).toBe("");
    expect(startContextMode("nonsense", "public")).toBe("public");
  });
});
