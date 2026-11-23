import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { branchesAt, branchFamily, versionFamilies, type SessionOutline } from "./branches";

const info = (path: string, parent: string | null = null): SessionInfo => ({
  path,
  id: path,
  cwd: "/p",
  timestamp: "",
  title: path,
  name: null,
  parent,
});
const u = (...ids: string[]) => ids.map((id) => ({ id, text: `text ${id}` }));

describe("branchFamily", () => {
  it("finds original, branches and branches of branches", () => {
    const list = [info("a"), info("b", "a"), info("c", "b"), info("d", "a"), info("x")];
    expect(branchFamily(list, "c").sort()).toEqual(["a", "b", "c", "d"]);
    expect(branchFamily(list, "x")).toEqual(["x"]);
  });

  it("survives a parent loop", () => {
    expect(branchFamily([info("a", "b"), info("b", "a")], "a").sort()).toEqual(["a", "b"]);
  });
});

describe("versionFamilies", () => {
  const row = (key: string, modified: number, created = modified) => ({ key, modified, created });

  it("keeps only the newest version as a main row, the older ones under it (newest first)", () => {
    const [a, b, c] = [row("h|a", 100), row("h|b", 300), row("h|c", 200)];
    const parents = new Map([
      ["h|b", "h|a"],
      ["h|c", "h|b"],
    ]);
    const m = versionFamilies([a, b, c], parents);
    expect([...m.keys()]).toEqual(["h|b"]);
    expect(m.get("h|b")).toEqual({ root: "h|a", older: [c, a] });
  });

  it("groups a family even when its root is not a row (filtered out)", () => {
    const [b, c] = [row("h|b", 100), row("h|c", 200)];
    const parents = new Map([
      ["h|b", "h|a"],
      ["h|c", "h|a"],
    ]);
    const m = versionFamilies([b, c], parents);
    expect(m.get("h|c")).toEqual({ root: "h|a", older: [b] });
  });

  it("leaves sessions without branches alone and survives a parent loop", () => {
    expect(versionFamilies([row("h|x", 1)], new Map()).size).toBe(0);
    const m = versionFamilies(
      [row("h|a", 1), row("h|b", 2)],
      new Map([
        ["h|a", "h|b"],
        ["h|b", "h|a"],
      ]),
    );
    expect([...m.keys()]).toEqual(["h|b"]);
    expect(m.get("h|b")?.root).toBe("h|a");
  });

  it("falls back to the creation time when the last change is unknown", () => {
    const m = versionFamilies([row("h|a", 0, 500), row("h|b", 0, 100)], new Map([["h|b", "h|a"]]));
    expect([...m.keys()]).toEqual(["h|a"]);
  });
});

describe("branchesAt", () => {
  // a: u1 u2 u3 · b = "edit u2" in a (b2) · c = "run again u3" in b (c3) · d = "go back" in a (prefix only)
  const outlines: SessionOutline[] = [
    { path: "a", mtime: 100, users: u("u1", "u2", "u3") },
    { path: "b", mtime: 200, users: u("u1", "b2", "b3") },
    { path: "c", mtime: 300, users: u("u1", "b2", "c3") },
    { path: "d", mtime: 400, users: u("u1", "u2") },
  ];

  it("shows the versions of a message where branches part", () => {
    const m = branchesAt("a", u("u1", "u2", "u3"), outlines);
    expect([...m.keys()]).toEqual([1]);
    // b and c share the edited message: one version, the newer file c opens
    expect(m.get(1)).toEqual([
      { path: "a", text: "text u2", current: true },
      { path: "c", text: "text b2", current: false },
    ]);
  });

  it("works from inside a branch", () => {
    const m = branchesAt("b", u("u1", "b2", "b3"), outlines);
    expect(m.get(1)?.map((c) => [c.path, c.current])).toEqual([
      ["a", false],
      ["b", true],
    ]);
    expect(m.get(2)?.map((c) => [c.path, c.current])).toEqual([
      ["b", true],
      ["c", false],
    ]);
  });

  it("is empty without other versions", () => {
    expect(branchesAt("a", u("u1", "u2", "u3"), [outlines[0]]).size).toBe(0);
  });
});
