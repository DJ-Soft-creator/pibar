// Tests of the pure temperature logic (src/shared/temperature.ts): slider grid, labels, command and status line.
import { describe, expect, it } from "vitest";
import {
  TEMP_NEUTRAL,
  clampTemp,
  formatTemp,
  isTemp,
  parseTemperatureStatus,
  tempHint,
  temperatureCommand,
} from "./temperature";

describe("clampTemp", () => {
  it("rounds to the slider grid and clamps", () => {
    expect(clampTemp(0.7)).toBe(0.7);
    expect(clampTemp(0.74)).toBe(0.7);
    expect(clampTemp(0.76)).toBe(0.8);
    expect(clampTemp(-1)).toBe(0);
    expect(clampTemp(5)).toBe(1);
    expect(clampTemp(0.30000000000000004)).toBe(0.3);
  });
  it("falls back to the neutral position for nonsense", () => {
    expect(clampTemp(NaN)).toBe(TEMP_NEUTRAL);
    expect(clampTemp(Infinity)).toBe(TEMP_NEUTRAL);
  });
});

describe("isTemp", () => {
  it("accepts 0–2 only", () => {
    expect(isTemp(0)).toBe(true);
    expect(isTemp(0.7)).toBe(true);
    expect(isTemp(2)).toBe(true);
    expect(isTemp(2.1)).toBe(false);
    expect(isTemp(-0.1)).toBe(false);
    expect(isTemp(NaN)).toBe(false);
    expect(isTemp("0.7")).toBe(false);
    expect(isTemp(undefined)).toBe(false);
  });
});

describe("formatTemp", () => {
  it("shows one decimal on the grid and two for typed values", () => {
    expect(formatTemp(0.7)).toBe("0.7");
    expect(formatTemp(1)).toBe("1.0");
    expect(formatTemp(0)).toBe("0.0");
    expect(formatTemp(0.75)).toBe("0.75");
  });
});

describe("tempHint", () => {
  it("explains the ends and the middle", () => {
    expect(tempHint(0.1)).toBe("Very focused: precise, factual and close to the rules");
    expect(tempHint(0.5)).toBe("Balanced: a middle ground between precise and free");
    expect(tempHint(1)).toBe("Very free: creative and surprising, but less predictable");
  });
});

describe("temperatureCommand", () => {
  it("builds the command of the extension", () => {
    expect(temperatureCommand(0.3)).toBe("/temperature 0.3");
    expect(temperatureCommand(null)).toBe("/temperature off");
  });
});

describe("parseTemperatureStatus", () => {
  it("reads value and default", () => {
    expect(parseTemperatureStatus("🌡 0.7")).toBe(0.7);
    expect(parseTemperatureStatus("🌡 default")).toBeNull();
    expect(parseTemperatureStatus("🌡 0,75")).toBe(0.75);
  });
  it("ignores other status lines", () => {
    expect(parseTemperatureStatus("🔒 private · voller Kontext")).toBeUndefined();
    expect(parseTemperatureStatus("")).toBeUndefined();
    expect(parseTemperatureStatus(undefined)).toBeUndefined();
    expect(parseTemperatureStatus("🌡 nonsense")).toBeUndefined();
    expect(parseTemperatureStatus("🌡 9")).toBeUndefined();
  });
});
