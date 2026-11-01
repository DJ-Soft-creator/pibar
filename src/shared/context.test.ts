import { describe, expect, it } from "vitest";
import { cleanTitle, splitContext, withContext, withFiles } from "./format";

describe("context paths", () => {
  it("round trip", () => {
    const msg = withContext("Look at this", [
      { kind: "folder", path: "/Users/a/proj/src" },
      { kind: "file", path: "/Users/a/proj/README.md" },
    ]);
    expect(msg).toContain("folder: /Users/a/proj/src");
    expect(splitContext(msg)).toEqual({
      text: "Look at this",
      paths: [
        { kind: "folder", path: "/Users/a/proj/src" },
        { kind: "file", path: "/Users/a/proj/README.md" },
      ],
    });
  });
  it("together with files, and in titles", () => {
    const msg = withContext(withFiles("Hi", [{ name: "a.txt", text: "x" }]), [{ kind: "folder", path: "/p" }]);
    expect(splitContext(msg).paths).toHaveLength(1);
    expect(cleanTitle(withContext("Hi", [{ kind: "folder", path: "/p" }]))).toBe("Hi");
  });
  it("no block, no change", () => {
    expect(withContext("Hi", [])).toBe("Hi");
    expect(splitContext("Hi")).toEqual({ text: "Hi", paths: [] });
  });
});
