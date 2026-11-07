import { describe, expect, it } from "vitest";
import { cleanQuery, highlight, isSearching, matchesQuery, roleLabel } from "./search";

describe("search", () => {
  it("keeps the query short and single spaced", () => {
    expect(cleanQuery("  Session   Suche ")).toBe("Session Suche");
    expect(cleanQuery("x".repeat(300)).length).toBe(100);
  });
  it("needs two characters to search", () => {
    expect(isSearching("a")).toBe(false);
    expect(isSearching(" a ")).toBe(false);
    expect(isSearching("ab")).toBe(true);
  });
  it("matches any part of a row, ignoring case", () => {
    expect(matchesQuery(["Neue Session", "/Users/user/Claude/PiBar"], "pibar")).toBe(true);
    expect(matchesQuery(["Neue Session", "/Users/user"], "jetzt")).toBe(false);
    expect(matchesQuery(["egal"], "")).toBe(true);
  });
  it("splits a snippet at the match", () => {
    expect(highlight("Bitte die Suche bauen", "suche")).toEqual(["Bitte die ", "Suche", " bauen"]);
    expect(highlight("Bitte die Suche bauen", "nichts")).toBeNull();
    expect(highlight("Suche", "  ")).toBeNull();
  });
  it("names the role of a hit", () => {
    expect(roleLabel("user")).toBe("You");
    expect(roleLabel("assistant")).toBe("Pi");
    expect(roleLabel("toolResult")).toBe("Tool");
  });
});
