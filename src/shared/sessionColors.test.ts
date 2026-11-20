// Tests for the session colour descriptions: cleaning, fallback to the built-in name, tooltip and legend.
import { describe, expect, it } from "vitest";
import { setLang } from "./i18n";
import {
  cleanColorLabel,
  cleanColorLabels,
  colorLabel,
  colorLegend,
  colorTitle,
  COLORS,
  LABEL_MAX,
} from "./sessionColors";

describe("cleanColorLabel", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanColorLabel("  waits   for\nreview ")).toBe("waits for review");
  });
  it("drops empty and undefined", () => {
    expect(cleanColorLabel("   ")).toBe("");
    expect(cleanColorLabel(undefined)).toBe("");
  });
  it("caps the length", () => {
    expect(cleanColorLabel("x".repeat(100))).toBe("x".repeat(LABEL_MAX));
  });
});

describe("cleanColorLabels", () => {
  it("keeps only known colours with a description", () => {
    expect(cleanColorLabels({ red: " Urgent ", blue: "", pink: "  ", bogus: "x" })).toEqual({ red: "Urgent" });
  });
  it("handles undefined", () => {
    expect(cleanColorLabels(undefined)).toEqual({});
  });
});

describe("colorLabel", () => {
  it("falls back to the built-in name in the active language", () => {
    setLang("de");
    expect(colorLabel("red")).toBe("Rot");
    setLang("en");
    expect(colorLabel("red")).toBe("Red");
    expect(colorLabel("")).toBe("No colour");
    expect(colorLabel("bogus")).toBe("No colour");
  });
  it("prefers the user's description", () => {
    expect(colorLabel("red", { red: "Urgent" })).toBe("Urgent");
    expect(colorLabel("red", { red: "   " })).toBe("Red");
  });
});

describe("colorTitle", () => {
  it("shows description and colour name", () => {
    expect(colorTitle("red", { red: "Urgent" })).toBe("Urgent (Red)");
    expect(colorTitle("red")).toBe("Red");
    expect(colorTitle("")).toBe("No colour");
  });
});

describe("colorLegend", () => {
  it("lists only colours with a description, in swatch order", () => {
    const legend = colorLegend({ blue: "Later", red: "Urgent", green: " " });
    expect(legend).toEqual([
      { color: "red", label: "Urgent" },
      { color: "blue", label: "Later" },
    ]);
    expect(COLORS.indexOf("red")).toBeLessThan(COLORS.indexOf("blue"));
  });
  it("is empty without descriptions", () => {
    expect(colorLegend()).toEqual([]);
    expect(colorLegend({})).toEqual([]);
  });
});
