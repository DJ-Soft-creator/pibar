import { describe, expect, it } from "vitest";
import { cleanColor, cleanProfiles, colorVars, fullHex, hasColors, profileFor, type ColorProfile } from "./colors";

describe("cleanColor", () => {
  it("takes hex colours with or without #, short and long", () => {
    expect(cleanColor("#AABBCC")).toBe("#aabbcc");
    expect(cleanColor("abcdef")).toBe("#abcdef");
    expect(cleanColor("#abc")).toBe("#abc");
    expect(cleanColor("#aabbccdd")).toBe("#aabbccdd");
    expect(cleanColor("  #123456 ")).toBe("#123456");
  });

  it("drops anything else instead of breaking the styling", () => {
    expect(cleanColor("")).toBe("");
    expect(cleanColor(undefined)).toBe("");
    expect(cleanColor("rot")).toBe("");
    expect(cleanColor("#12345")).toBe("");
    expect(cleanColor("#12345g")).toBe("");
    expect(cleanColor("rgb(1,2,3)")).toBe("");
  });
});

describe("fullHex", () => {
  it("expands short values for the colour picker", () => {
    expect(fullHex("#abc")).toBe("#aabbcc");
    expect(fullHex("#aabbcc")).toBe("#aabbcc");
    expect(fullHex("#aabbccdd")).toBe("#aabbcc");
    expect(fullHex("nope")).toBe("");
  });
});

const profile: ColorProfile = {
  id: "p1",
  name: "Mine",
  dark: { thinking: { background: "#112233", text: "#eeeeee" }, own: { background: "#223344" } },
  light: { answer: { background: "#fafafa" } },
};

describe("colorVars", () => {
  it("sets only the colours of the chosen theme", () => {
    expect(colorVars(profile, true)).toEqual({
      "--thinking-bg": "#112233",
      "--thinking-fg": "#eeeeee",
      "--user-bg": "#223344",
    });
    expect(colorVars(profile, false)).toEqual({
      "--answer-bg": "#fafafa",
      "--answer-pad": "6px 12px",
      "--answer-radius": "10px",
    });
  });

  it("sets nothing without a profile", () => {
    expect(colorVars(undefined, true)).toEqual({});
    expect(colorVars({ id: "x", name: "x" }, false)).toEqual({});
  });

  it("ignores invalid values", () => {
    expect(colorVars({ id: "x", name: "x", dark: { tools: { background: "nope", text: "#fff" } } }, true)).toEqual({
      "--tool-fg": "#fff",
    });
  });
});

describe("profileFor", () => {
  const list = [profile, { id: "p2", name: "Other" }];
  it("prefers the host's own profile, then the default", () => {
    expect(profileFor(list, "p2", "p1")?.name).toBe("Other");
    expect(profileFor(list, "", "p1")?.name).toBe("Mine");
    expect(profileFor(list, "gone", "")).toBeUndefined();
    expect(profileFor(undefined, "p1", "p1")).toBeUndefined();
  });
});

describe("cleanProfiles", () => {
  it("normalises values and drops empty rows", () => {
    const out = cleanProfiles([
      { id: "a", name: "  ", dark: { thinking: { background: "ABC", text: "" } } } as ColorProfile,
      { id: "", name: "gone" },
    ]);
    expect(out).toEqual([{ id: "a", name: "a", dark: { thinking: { background: "#abc", text: "" } }, light: {} }]);
    expect(hasColors(out[0].dark)).toBe(true);
    expect(hasColors(out[0].light)).toBe(false);
  });
});
