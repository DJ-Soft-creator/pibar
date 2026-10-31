import { describe, expect, it } from "vitest";
import { buildTree, countFiles } from "./tree";

describe("buildTree", () => {
  it("nests files into folders, folders first and sorted", () => {
    const t = buildTree(["z.md", "docs/b.md", "docs/a.md", "docs/adr/1.md", "a.md"]);
    expect(t.files.map((f) => f.name)).toEqual(["a.md", "z.md"]);
    expect(t.dirs.map((d) => d.path)).toEqual(["docs"]);
    expect(t.dirs[0].files.map((f) => f.path)).toEqual(["docs/a.md", "docs/b.md"]);
    expect(t.dirs[0].dirs[0].path).toBe("docs/adr");
    expect(countFiles(t)).toBe(5);
  });
  it("sorts numbers naturally", () => {
    expect(buildTree(["10.md", "2.md"]).files.map((f) => f.name)).toEqual(["2.md", "10.md"]);
  });
  it("ignores empty paths", () => expect(countFiles(buildTree(["", "/"]))).toBe(0));
  it("keeps empty folders (paths ending with /)", () => {
    const t = buildTree(["notes/", "notes/old/", "docs/a.md", "docs/"]);
    expect(t.dirs.map((d) => d.name)).toEqual(["docs", "notes"]);
    expect(t.dirs[1].dirs[0].path).toBe("notes/old");
    expect(countFiles(t)).toBe(1);
  });
});
