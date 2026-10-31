import { describe, expect, it } from "vitest";
import type { GitInfo } from "./api";
import { allChanges, gitLetter, gitStatusFor } from "./git";

const git: GitInfo = {
  dir: "",
  branch: "main",
  upstream: "origin/main",
  ahead: 1,
  behind: 0,
  changes: [
    { path: "docs/a.md", code: " M" },
    { path: "new/", code: "??" },
  ],
};

describe("git status in the tree", () => {
  it("finds files and folders with changes", () => {
    const ch = allChanges([git]);
    expect(gitStatusFor(ch, "docs/a.md")).toBe(" M");
    expect(gitStatusFor(ch, "docs/")).toBe(" M");
    expect(gitStatusFor(ch, "new/x.md")).toBe("??");
    expect(gitStatusFor(ch, "other.md")).toBe("");
  });
  it("maps porcelain codes to letters", () => {
    expect(gitLetter(" M")?.letter).toBe("M");
    expect(gitLetter("??")?.letter).toBe("U");
    expect(gitLetter("A ")?.kind).toBe("new");
    expect(gitLetter("")).toBeNull();
  });
});
