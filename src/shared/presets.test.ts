import { describe, expect, it } from "vitest";
import type { ModelPreset } from "./api";
import { cleanPresets, matchPreset, movePreset, presetForNewSession, resolveChoice, splitModelKey } from "./presets";

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
  it("keeps the order while cleaning", () => {
    const list = [p("c", "a/x", ""), p("a", "b/y", "low"), p("b", "c/z", "high")];
    expect(cleanPresets(list).map((x) => x.id)).toEqual(["c", "a", "b"]);
  });
  it("moves a preset up or down, the rest keep their order", () => {
    const list = [p("a", "a/x", ""), p("b", "b/y", ""), p("c", "c/z", "")];
    expect(movePreset(list, 2, 0).map((x) => x.id)).toEqual(["c", "a", "b"]);
    expect(movePreset(list, 0, 1).map((x) => x.id)).toEqual(["b", "a", "c"]);
    // the input list is not changed
    expect(list.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
  it("clamps the positions and does nothing at the edges", () => {
    const list = [p("a", "a/x", ""), p("b", "b/y", "")];
    expect(movePreset(list, 0, -3).map((x) => x.id)).toEqual(["a", "b"]);
    expect(movePreset(list, 1, 9).map((x) => x.id)).toEqual(["a", "b"]);
    expect(movePreset(list, 1, 1).map((x) => x.id)).toEqual(["a", "b"]);
    expect(movePreset([], 0, 1)).toEqual([]);
    expect(movePreset([p("a", "a/x", "")], 0, 1).map((x) => x.id)).toEqual(["a"]);
  });
  it("finds the preset matching model and thinking", () => {
    const list = [p("fast", "a/mini", "low"), p("deep", "a/big", "high"), p("think", "", "max")];
    expect(matchPreset(list, "a/big", "high")?.id).toBe("deep");
    expect(matchPreset(list, "a/big", "low")).toBeUndefined();
    expect(matchPreset(list, "b/other", "max")?.id).toBe("think");
  });
  it("resolves the saved choice of a session", () => {
    const list = [p("fast", "a/mini", "low"), p("think", "", "max")];
    const asModel = { provider: "a", id: "mini" };
    // a preset wins over the model stored next to it (its fields apply)
    expect(resolveChoice(list, { preset: "fast", model: "b/old", thinking: "high" })).toEqual({
      preset: list[0],
      model: asModel,
      thinking: "low",
    });
    // a preset without a model only sets the thinking level
    expect(resolveChoice(list, { preset: "think" })).toEqual({ preset: list[1], model: null, thinking: "max" });
    // own choice: model and thinking level as stored
    expect(resolveChoice(list, { model: "b/other", thinking: "high" })).toEqual({
      preset: null,
      model: { provider: "b", id: "other" },
      thinking: "high",
    });
    // preset deleted in the settings: its model from the session file counts
    expect(resolveChoice(list, { preset: "gone", model: "b/other" }).preset).toBeNull();
    expect(resolveChoice(list, { preset: "gone" })).toEqual({ preset: null, model: null, thinking: "" });
    expect(resolveChoice(list, undefined)).toEqual({ preset: null, model: null, thinking: "" });
  });
  it("new sessions take the project's fixed preset, else the default of the settings", () => {
    const list = [p("fast", "a/x", "low"), p("deep", "b/y", "max")];
    expect(presetForNewSession(list, "deep", "fast")?.id).toBe("deep");
    expect(presetForNewSession(list, "", "fast")?.id).toBe("fast");
    expect(presetForNewSession(list, undefined, undefined)).toBeUndefined();
    // a preset deleted in the settings falls back to the default
    expect(presetForNewSession(list, "gone", "fast")?.id).toBe("fast");
    expect(presetForNewSession(list, "gone", "also-gone")).toBeUndefined();
  });
});
