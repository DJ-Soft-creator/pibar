import { describe, expect, it } from "vitest";
import { parentDir, tildePath } from "./folderPicker";

describe("folder picker paths", () => {
  it("tildePath", () => {
    expect(tildePath("/Users/a", "/Users/a")).toBe("~");
    expect(tildePath("/Users/a/proj", "/Users/a")).toBe("~/proj");
    expect(tildePath("/Users/ab", "/Users/a")).toBe("/Users/ab");
    expect(tildePath("/opt/x", "/")).toBe("/opt/x");
  });
  it("parentDir", () => {
    expect(parentDir("/Users/a/proj")).toBe("/Users/a");
    expect(parentDir("/Users")).toBe("/");
    expect(parentDir("/")).toBe("/");
  });
});
