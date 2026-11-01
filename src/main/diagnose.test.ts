import { describe, expect, it } from "vitest";
import { diagnoseHints } from "./diagnose";

describe("diagnosis hints", () => {
  it("points to the macOS local network permission", () => {
    const r = "http://192.168.178.250:1234/v1 -> curl: (7) Failed to connect: No route to host HTTP 000";
    expect(diagnoseHints(r).join(" ")).toContain("Local Network");
  });
  it("detects a refused connection and a missing key variable", () => {
    const r =
      "models.json: provider x apiKey=env KEY (NOT SET)\nhttp://localhost:1234/v1 -> curl: (7) Connection refused";
    const h = diagnoseHints(r);
    expect(h.some((x) => x.includes("refuses"))).toBe(true);
    expect(h.some((x) => x.includes("API key variable"))).toBe(true);
  });
  it("notices when curl works but Node does not", () => {
    const r =
      "curl http://mini.local:1234/v1 -> HTTP 200 in 0.1s\nnode http://mini.local:1234/v1 -> TypeError: fetch failed | cause: ENOTFOUND";
    expect(diagnoseHints(r).some((x) => x.includes("Node"))).toBe(true);
  });
  it("stays quiet when all is fine", () => {
    expect(diagnoseHints("https://api.anthropic.com -> HTTP 404 in 0.1s")).toEqual([]);
  });
});
