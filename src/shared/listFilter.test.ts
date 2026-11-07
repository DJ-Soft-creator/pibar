import { describe, expect, it } from "vitest";
import { filterSet, passesFilter } from "./listFilter";

describe("session list filter", () => {
  it("keeps everything without a filter", () => {
    expect(filterSet("all", [])).toBe(false);
    expect(passesFilter({}, "all", [])).toBe(true);
    expect(passesFilter({ color: "red" }, "all", [])).toBe(true);
  });
  it("knows when a filter is set", () => {
    expect(filterSet("active", [])).toBe(true);
    expect(filterSet("all", ["red"])).toBe(true);
  });
  it("active keeps running, unread and open sessions", () => {
    expect(passesFilter({ running: true }, "active", [])).toBe(true);
    expect(passesFilter({ unread: true }, "active", [])).toBe(true);
    expect(passesFilter({ open: true }, "active", [])).toBe(true);
    expect(passesFilter({}, "active", [])).toBe(false);
  });
  it("filters by colour, none counts as its own colour", () => {
    expect(passesFilter({ color: "red" }, "all", ["red"])).toBe(true);
    expect(passesFilter({ color: "blue" }, "all", ["red"])).toBe(false);
    expect(passesFilter({}, "all", ["none"])).toBe(true);
    expect(passesFilter({ color: "red" }, "all", ["red", "blue"])).toBe(true);
  });
  it("colour and active both have to hold", () => {
    expect(passesFilter({ running: true, color: "red" }, "active", ["blue"])).toBe(false);
    expect(passesFilter({ running: true, color: "blue" }, "active", ["blue"])).toBe(true);
  });
});
