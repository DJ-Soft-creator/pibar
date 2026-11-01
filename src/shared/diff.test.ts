import { describe, expect, it } from "vitest";
import { diffLines, diffStats, hunks } from "./diff";

const ops = (a: string, b: string) => diffLines(a, b).map((d) => d.op + d.text);

describe("diff", () => {
  it("equal texts have no changes", () => {
    expect(diffStats(diffLines("a\nb\n", "a\nb\n"))).toEqual({ added: 0, removed: 0 });
  });
  it("changed line: removed, then added, with line numbers", () => {
    const d = diffLines("a\nb\nc\n", "a\nB\nc\nd\n");
    expect(d.map((x) => x.op + x.text)).toEqual([" a", "-b", "+B", " c", "+d"]);
    expect(d[2]).toEqual({ op: "+", text: "B", a: 0, b: 2 });
    expect(d[3]).toEqual({ op: " ", text: "c", a: 3, b: 3 });
  });
  it("new file and deleted content", () => {
    expect(ops("", "x\ny")).toEqual(["+x", "+y"]);
    expect(ops("x\n", "")).toEqual(["-x"]);
  });
  it("moves within the text", () => {
    expect(ops("1\n2\n3\n4\n", "1\n3\n2\n4\n")).toEqual([" 1", "-2", " 3", "+2", " 4"]);
  });
  it("hunks keep context and collapse the rest", () => {
    const old = Array.from({ length: 20 }, (_, i) => `l${i}`).join("\n");
    const neu = old.replace("l10", "X");
    const hs = hunks(diffLines(old, neu), 2);
    expect(hs[0]).toEqual({ skipped: 8 });
    expect(hs.filter((x) => "op" in x).length).toBe(6);
    expect(hs[hs.length - 1]).toEqual({ skipped: 7 });
  });
  it("short gaps between changes are not collapsed", () => {
    const hs = hunks(diffLines("a\nb\nc\nd\ne\n", "A\nb\nc\nd\nE\n"), 1);
    expect(hs.every((x) => "op" in x)).toBe(true);
  });
});
