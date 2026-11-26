// Data the chat reads besides Pi: the session organisation (meta_get / meta_set_session – SessionMeta fields model,
// thinking, preset, planMode, chatMode, contextMode, temperature, name …), the shared settings of the admin
// (app_config_get: presets, quick actions) and the chat settings of the user (default view, answer style, auto
// scroll, background), saved with the user's own settings on the server.
import type { ChatMode, ModelPreset, Project, QuickAction, SessionMeta } from "@shared/api";
import { cleanQuickActions } from "@shared/quickActions";
import { invoke } from "../bridge";
import { onSocketMessage } from "../socketBus";
import { saveSettings, settings } from "../state";

export interface MetaView {
  sessionMeta: Record<string, SessionMeta>;
  projects: Project[];
}

export async function loadMeta(): Promise<MetaView> {
  const v = await invoke<Partial<MetaView>>("meta_get");
  return { sessionMeta: v.sessionMeta ?? {}, projects: v.projects ?? [] };
}

/**
 * Change some fields of a session's metadata and keep all others (name, colour, group … belong to other views):
 * read the entry fresh, apply the patch (undefined deletes a field), write the whole entry back.
 */
export async function patchSessionMeta(key: string, patch: Partial<Record<keyof SessionMeta, unknown>>): Promise<SessionMeta> {
  const cur = { ...((await loadMeta()).sessionMeta[key] ?? {}) } as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined || v === null || v === "") delete cur[k];
    else cur[k] = v;
  }
  await invoke("meta_set_session", { key, meta: Object.keys(cur).length ? cur : null });
  return cur as SessionMeta;
}

// ------------------------------------------------------------------ shared settings (admin)

export interface SharedConfig {
  presets: ModelPreset[];
  quickActions: QuickAction[];
}

let shared: Promise<SharedConfig> | null = null;
onSocketMessage((m) => {
  if (m.type === "config/app-updated") shared = null;
});

/** Presets (only those with a name and something to set) and the quick actions of kind "command" */
export function sharedConfig(): Promise<SharedConfig> {
  shared ??= invoke<{ presets?: ModelPreset[]; quickActions?: QuickAction[] }>("app_config_get")
    .then((c) => ({
      presets: (c.presets ?? []).filter((p) => p && p.id && p.name && (p.model || p.thinking)),
      // shell scripts need a terminal: the webapp has none
      quickActions: cleanQuickActions(c.quickActions).filter((a) => a.kind === "command"),
    }))
    .catch(() => ({ presets: [], quickActions: [] }));
  return shared;
}

// ------------------------------------------------------------------ the user's chat settings

export type AnswerMode = "short" | "normal" | "technical";
export type AutoScroll = "auto" | "always" | "off";

export interface ChatSettings {
  /** View of sessions without their own (desktop ui.chatMode) */
  chatMode?: ChatMode;
  /** Answer style hint appended to each message (desktop ui.answerMode) */
  answerMode?: AnswerMode;
  autoScroll?: AutoScroll;
  /** Send messages as runs in the background by default (desktop ui.background) */
  background?: boolean;
  /** Preset new sessions start with (id of a shared preset), "" = Pi's default */
  defaultPreset?: string;
}

export function chatSettings(): ChatSettings {
  return settings() as ChatSettings;
}

export function saveChatSettings(patch: ChatSettings): Promise<void> {
  return saveSettings(patch as Parameters<typeof saveSettings>[0]);
}
