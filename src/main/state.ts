// Shared state of the main window. All modules read and write through `state`.
import { api, AppConfig, SearchHit, SessionInfo } from "../shared/api";
import { errMsg, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { notifyConfigSaved, prepareConfigSave } from "./configSync";

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
  /**
   * Search in the left column (src/main/search.ts): the query filters the list, the hits are sessions whose messages
   * contain it. `pending` counts the hosts still answering.
   */
  search: {
    query: "",
    hits: new Map<string, SearchHit[]>(),
    pending: 0,
    /** The shown hosts have answered for this query (no answer pending) */
    done: true,
    error: "",
  },
};

export async function saveConfig() {
  try {
    // the webapp sync stamps changed session metadata, groups and projects (updatedAt) before they are written
    prepareConfigSave();
    await api.saveConfig(state.config);
    // Listeners (e.g. the webapp sync in configExchange.ts) follow every save; the registry in
    // configSync.ts keeps state.ts free of a circular import back to configExchange.ts.
    notifyConfigSaved();
  } catch (e) {
    toast(`${t("Settings not saved")}: ${errMsg(e)}`, "err");
  }
}
