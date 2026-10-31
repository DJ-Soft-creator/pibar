import { describe, expect, it } from "vitest";
import type { ModelPreset } from "./api";
import { cleanPresets, matchPreset, splitModelKey } from "./presets";

const p = (id: string, model: string, thinking: string): ModelPreset => ({ id, name: id, model, thinking });

describe("presets", () => {
  it("splits model keys at the first slash", () => {
    expect(splitModelKey("openrouter/meta/llama-4")).toEqual({ provider: "openrouter", id: "meta/llama-4" });
    expect(splitModelKey("noslash")).toBeNull();
    expect(splitModelKey("/id")).toBeNull();
    expect(splitModelKey("prov/")).toBeNull();
  });
  it("drops presets without name or content and trims fields", () => {
    const out = cleanPresets([
      { id: "a", name: " Fast ", model: " x/y ", thinking: "" },
      { id: "b", name: "", model: "x/y", thinking: "low" },
      { id: "c", name: "Empty", model: "", thinking: "" },
    ]);
    expect(out).toEqual([{ id: "a", name: "Fast", model: "x/y", thinking: "" }]);
  });
  it("finds the preset matching model and thinking", () => {
    const list = [p("fast", "a/mini", "low"), p("deep", "a/big", "high"), p("think", "", "max")];
    expect(matchPreset(list, "a/big", "high")?.id).toBe("deep");
    expect(matchPreset(list, "a/big", "low")).toBeUndefined();
    expect(matchPreset(list, "b/other", "max")?.id).toBe("think");
  });
});
