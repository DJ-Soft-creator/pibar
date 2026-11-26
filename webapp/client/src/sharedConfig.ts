// The shared settings of the webapp as every user sees them (app_config_get: presets, quick actions, colour
// profiles, colour descriptions, voice services without API keys), kept in memory and reloaded when an admin saves
// them (WebSocket message "config/app-updated"). Used by the chat colours and the voice functions.
import type { ColorProfile, ModelPreset, QuickAction } from "@shared/api";
import { invoke } from "./bridge";
import { onSocketMessage } from "./socketBus";

/** A colour profile of the webapp: `isDefault` marks the one for hosts without their own */
export type WebColorProfile = ColorProfile & { isDefault?: boolean };

/** VoiceCfg of the desktop as the server hands it out: no keys, only whether one is set */
export interface WebVoiceCfg {
  stt?: { provider?: string; baseUrl?: string; apiKeySet?: boolean; model?: string; language?: string; command?: string };
  tts?: { provider?: string; baseUrl?: string; apiKeySet?: boolean; model?: string; voice?: string };
  improve?: {
    enabled?: boolean;
    afterDictation?: boolean;
    baseUrl?: string;
    apiKeySet?: boolean;
    model?: string;
    prompt?: string;
  };
}

export interface SharedConfig {
  presets: ModelPreset[];
  quickActions: QuickAction[];
  colorProfiles: WebColorProfile[];
  sessionColorLabels: Record<string, string>;
  voice: WebVoiceCfg;
}

let config: SharedConfig | null = null;
let loading: Promise<SharedConfig | null> | null = null;
let wired = false;
const listeners = new Set<(c: SharedConfig) => void>();

/** The settings as last loaded; null = not loaded yet */
export function sharedConfig(): SharedConfig | null {
  return config;
}

/** Load (again) from the server; listeners hear the new settings. Errors keep the old ones. */
export function loadSharedConfig(): Promise<SharedConfig | null> {
  loading ??= invoke<SharedConfig>("app_config_get")
    .then((c) => {
      config = c;
      for (const fn of [...listeners]) fn(c);
      return c;
    })
    .catch(() => config)
    .finally(() => (loading = null));
  return loading;
}

/** Hear every (re)load; returns the function that removes the listener */
export function onSharedConfig(fn: (c: SharedConfig) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Reload when an admin saved the settings (once per page) */
export function wireSharedConfig() {
  if (wired) return;
  wired = true;
  onSocketMessage((m) => {
    if (m.type === "config/app-updated") void loadSharedConfig();
  });
}
