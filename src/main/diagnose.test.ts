import { describe, expect, it } from "vitest";
import { diagnoseHints } from "./diagnose";

describe("diagnosis hints", () => {
  it("points to the macOS local network permission", () => {
    const r =
      "node http://192.168.170.211:8080/v1 -> TypeError: fetch failed | cause: EHOSTUNREACH connect EHOSTUNREACH 192.168.170.211:8080";
    expect(diagnoseHints(r).join(" ")).toContain("Local Network");
  });
  it("ignores services that are just not running on this computer", () => {
    const r =
      "curl http://127.0.0.1:1234/v1 -> curl: (7) Failed\nnode http://127.0.0.1:1234/v1 -> TypeError: fetch failed | cause: ECONNREFUSED connect ECONNREFUSED 127.0.0.1:1234";
    expect(diagnoseHints(r)).toEqual([]);
  });
  it("detects a refused connection and a missing key variable", () => {
    const r =
      "models.json: provider x apiKey=env KEY (NOT SET)\nnode http://10.0.0.5:1234/v1 -> fetch failed | cause: ECONNREFUSED connect ECONNREFUSED 10.0.0.5:1234";
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
