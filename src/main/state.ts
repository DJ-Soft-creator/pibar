// Shared state of the main window. All modules read and write through `state`.
import { api, AppConfig, SessionInfo } from "../shared/api";
import { errMsg, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";

export interface HostStatus {
  state: "ok" | "err" | "busy";
  error?: string;
}

export const state = {
  /** Settings (loaded in index.ts, saved with saveConfig) */
  config: undefined as unknown as AppConfig,
  /** Session list per host (from Pi's session folder) */
  sessionsByHost: new Map<string, SessionInfo[]>(),
  hostStatus: new Map<string, HostStatus>(),
  /** Open sessions, key: SessionTab.key ("<hostId>|<sessionPath>") */
  tabs: new Map<string, SessionTab>(),
  /** Same sessions by Pi process handle (for events from the Rust core) */
  tabsByHandle: new Map<number, SessionTab>(),
  /** Session shown in the chat area */
  active: null as SessionTab | null,
};

export async function saveConfig() {
  try {
    await api.saveConfig(state.config);
  } catch (e) {
    toast(`${t("Settings not saved")}: ${errMsg(e)}`, "err");
  }
}
