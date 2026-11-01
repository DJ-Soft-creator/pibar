import { describe, expect, it } from "vitest";
import type { SessionInfo } from "./api";
import { branchesAt, branchFamily, type SessionOutline } from "./branches";

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
