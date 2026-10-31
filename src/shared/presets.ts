// Model presets: pure helpers (no DOM, no Tauri) to split model keys, clean up edited presets and find
// the preset that matches a session's current model and thinking level.
import type { ModelPreset } from "./api";

/** "provider/model-id" → parts; null if the key has no provider or no id */
export function splitModelKey(key: string): { provider: string; id: string } | null {
  const i = key.indexOf("/");
  if (i <= 0 || i === key.length - 1) return null;
  return { provider: key.slice(0, i), id: key.slice(i + 1) };
}

/** Trim fields and drop presets without a name or without anything to set */
export function cleanPresets(list: ModelPreset[]): ModelPreset[] {
  return list
    .map((p) => ({ ...p, name: p.name.trim(), model: p.model.trim(), thinking: p.thinking.trim() }))
    .filter((p) => p.name && (p.model || p.thinking));
}

/** First preset that fits model ("provider/id") and thinking level; an empty preset field fits anything */
export function matchPreset(presets: ModelPreset[], model: string, thinking: string): ModelPreset | undefined {
  return presets.find(
    (p) => (p.model || p.thinking) && (!p.model || p.model === model) && (!p.thinking || p.thinking === thinking),
  );
}
