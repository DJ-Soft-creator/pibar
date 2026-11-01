import { describe, expect, it } from "vitest";
import { dateBucket, sectionRows, sortRows, type OrderRow } from "./sessionOrder";

const now = new Date(2026, 10, 1, 9, 30); // Sun 1 Nov 2026, 09:30
const at = (d: number, m = 10, y = 2026, hh = 12) => new Date(y, m, d, hh).getTime();
const row = (title: string, cwd: string, created: number, modified: number, fresh = false): OrderRow => ({
  title,
  cwd,
  created,
  modified,
  fresh,
});

describe("dateBucket", () => {
  it("sorts times into sections", () => {
    expect(dateBucket(at(1, 10, 2026, 8), now)).toBe("today");
    expect(dateBucket(at(31, 9), now)).toBe("yesterday");
    expect(dateBucket(at(27, 9), now)).toBe("week");
    expect(dateBucket(at(10, 9), now)).toBe("month");
    expect(dateBucket(at(15, 8), now)).toBe("2026-09");
    expect(dateBucket(0, now)).toBe("today");
  });
});

describe("sortRows", () => {
  const rows = [
    row("beta", "/b", at(1, 9), at(31, 9)),
    row("Alpha", "/a", at(20, 9), at(25, 9)),
    row("neu", "/c", 0, 0, true),
  ];
  it("keeps new sessions first and sorts by activity, creation, name or folder", () => {
    expect(sortRows(rows, "activity").map((r) => r.title)).toEqual(["neu", "beta", "Alpha"]);
    expect(sortRows(rows, "created").map((r) => r.title)).toEqual(["neu", "Alpha", "beta"]);
    expect(sortRows(rows, "name").map((r) => r.title)).toEqual(["neu", "Alpha", "beta"]);
    expect(sortRows(rows, "folder").map((r) => r.title)).toEqual(["neu", "Alpha", "beta"]);
  });
});

describe("sectionRows", () => {
  const rows = [
    row("heute", "/p", at(1), at(1, 10, 2026, 9)),
    row("gestern", "/q", at(20, 9), at(31, 9)),
    row("alt", "/p", at(3, 6), at(4, 6)),
  ];
  it("groups by date, newest section first", () => {
    expect(sectionRows(rows, "activity", "date", now).map((s) => [s.key, s.rows.map((r) => r.title)])).toEqual([
      ["today", ["heute"]],
      ["yesterday", ["gestern"]],
      ["2026-07", ["alt"]],
    ]);
  });
  it("groups by folder", () => {
    expect(sectionRows(rows, "activity", "folder", now).map((s) => [s.key, s.rows.length])).toEqual([
      ["/p", 2],
      ["/q", 1],
    ]);
  });
  it("has one unnamed section without grouping", () => {
    expect(sectionRows(rows, "name", "none", now)).toHaveLength(1);
  });
});
