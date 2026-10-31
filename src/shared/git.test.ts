import { describe, expect, it } from "vitest";
import type { GitInfo } from "./api";
import { gitLetter, gitStatusFor } from "./git";

const git: GitInfo = {
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
    expect(gitStatusFor(git, "docs/a.md")).toBe(" M");
    expect(gitStatusFor(git, "docs/")).toBe(" M");
    expect(gitStatusFor(git, "new/x.md")).toBe("??");
    expect(gitStatusFor(git, "other.md")).toBe("");
  });
  it("maps porcelain codes to letters", () => {
    expect(gitLetter(" M")?.letter).toBe("M");
    expect(gitLetter("??")?.letter).toBe("U");
    expect(gitLetter("A ")?.kind).toBe("new");
    expect(gitLetter("")).toBeNull();
  });
});
