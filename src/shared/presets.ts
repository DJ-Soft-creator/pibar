// Model presets: pure helpers (no DOM, no Tauri) to split model keys, clean up edited presets, find the preset that
// matches a session's current model and thinking level, resolve the choice saved for a session and pick the preset a
// new session starts with.
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

/**
 * Preset a new session starts with: the fixed preset of a project if it still exists, otherwise the default from the
 * settings; undefined = Pi's default model or an individual model from the settings (see sessions.applyDefaults).
 */
export function presetForNewSession(
  presets: ModelPreset[],
  projectPreset: string | undefined,
  defaultPreset: string | undefined,
): ModelPreset | undefined {
  const pick = (id?: string) => (id ? presets.find((p) => p.id === id) : undefined);
  return pick(projectPreset) ?? pick(defaultPreset);
}

/** Model, thinking level and preset chosen for a session (settings: SessionMeta) */
export interface ModelChoice {
  /** Preset id; empty = own choice */
  preset?: string;
  /** "provider/model-id"; empty = as in the session file */
  model?: string;
  thinking?: string;
}

/**
 * What a saved choice means: the preset if it still exists (its model and thinking level may be empty), otherwise the
 * session's own model and thinking level. A preset deleted in the settings is silently dropped.
 */
export function resolveChoice(
  presets: ModelPreset[],
  choice: ModelChoice | undefined,
): { preset: ModelPreset | null; model: { provider: string; id: string } | null; thinking: string } {
  const preset = (choice?.preset ? presets.find((p) => p.id === choice.preset) : undefined) ?? null;
  if (preset) return { preset, model: splitModelKey(preset.model), thinking: preset.thinking };
  return { preset: null, model: splitModelKey(choice?.model ?? ""), thinking: choice?.thinking ?? "" };
}
