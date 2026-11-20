// Tests for cleanQuickActions (shared/quickActions.ts)
import { describe, expect, it } from "vitest";
import { cleanQuickActions } from "./quickActions";

describe("cleanQuickActions", () => {
  it("keeps valid rows and trims them", () => {
    expect(cleanQuickActions([{ id: "a", name: " Build ", kind: "shell", text: " npm run check " }])).toEqual([
      { id: "a", name: "Build", kind: "shell", text: "npm run check" },
    ]);
  });

  it("drops rows without a name or a text", () => {
    expect(
      cleanQuickActions([
        { id: "a", name: "", kind: "command", text: "/compact" },
        { id: "b", name: "X", kind: "command", text: "  " },
      ]),
    ).toEqual([]);
  });

  it("normalises the kind and gives rows without an id one", () => {
    const out = cleanQuickActions([
      { id: "", name: "A", kind: "nonsense" as never, text: "/x" },
      { id: "", name: "B", kind: "shell", text: "ls" },
    ]);
    expect(out.map((a) => a.kind)).toEqual(["command", "shell"]);
    expect(out.map((a) => a.id)).toEqual(["qa1", "qa2"]);
  });

  it("tolerates a missing list", () => {
    expect(cleanQuickActions(undefined)).toEqual([]);
    expect(cleanQuickActions(null)).toEqual([]);
  });
});
