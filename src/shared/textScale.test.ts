import { describe, expect, it } from "vitest";
import { FONT_SCALES, normalizeScale, scaleLabel, stepScale } from "./textScale";

describe("text size", () => {
  it("unknown values count as 100 %", () => {
    expect(normalizeScale(undefined)).toBe(1);
    expect(normalizeScale("abc")).toBe(1);
    expect(normalizeScale(1.7)).toBe(1);
    expect(normalizeScale("1.2")).toBe(1.2);
  });

  it("goes one step bigger or smaller", () => {
    expect(stepScale(1, 1)).toBe(1.1);
    expect(stepScale(1, -1)).toBe(0.9);
  });

  it("stays inside the offered sizes", () => {
    const small = FONT_SCALES[0];
    const big = FONT_SCALES[FONT_SCALES.length - 1];
    expect(stepScale(small, -1)).toBe(small);
    expect(stepScale(big, 1)).toBe(big);
  });

  it("labels the factor in percent", () => {
    expect(scaleLabel(1)).toBe("100 %");
    expect(scaleLabel(1.1)).toBe("110 %");
    expect(scaleLabel(1.6)).toBe("160 %");
  });
});
