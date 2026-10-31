// Interface to the Rust core: types and all invoke() calls (counterpart: src-tauri/src/lib.rs)
import { invoke } from "@tauri-apps/api/core";

export interface HostCfg {
  id: string;
  name: string;
  kind: "local" | "ssh";
  sshTarget: string;
  sshUser: string;
  sshPort: number | null;
  piCommand: string;
  defaultDir: string;
  useHerdr: boolean;
}

/** A reminder on a saved session */
export interface Reminder {
  /** Session key "<hostId>|<sessionPath>" */
  key: string;
  hostId: string;
  path: string;
  cwd: string;
  title: string;
  /** Due time (ms since epoch) */
  at: number;
  note: string;
  /** Notification already shown */
  fired: boolean;
}

export interface AppConfig {
  hosts: HostCfg[];
  sessionFolders: Record<string, string[]>;
  reminders: Reminder[];
  ui: {
    /** "auto", "de" or "en" */
    language?: string;
    showTools: boolean;
    showThinking: boolean;
    selectedHost?: string;
    collapsedHosts?: string[];
    leftCollapsed?: boolean;
    rightCollapsed?: boolean;
    quickHotkey?: string;
    doubleTap?: string;
  };
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  timestamp: string;
  title: string;
  name: string | null;
}

export interface FolderListing {
  folder: string;
  root: string;
  files: string[];
  error: string | null;
}

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
}

export interface PiResponse {
  type: "response";
  command: string;
  success: boolean;
  data?: any;
  error?: string;
}

export interface QuickTarget {
  kind: "active" | "new" | "session";
  hostId?: string;
  path?: string;
  cwd?: string;
  title?: string;
}

export interface ModelInfo {
  provider: string;
  id: string;
  thinking: boolean;
  images: boolean;
}

export interface QuickSubmit {
  target: QuickTarget;
  /** null = keep the session's model */
  model: { provider: string; id: string } | null;
  /** null = keep the session's thinking level */
  thinking: string | null;
  text: string;
  images: { data: string; mimeType: string }[];
  ocr: string | null;
}

/** Status of the double-tap listener (src-tauri/src/doubletap.rs) */
export type DoubleTapStatus = "off" | "active" | "permission" | "error" | "unsupported";

export const api = {
  showMain: () => invoke<void>("show_main"),
  setHotkey: (accel: string) => invoke<void>("set_hotkey", { accel }),
  /** Returns the status code, see DoubleTapStatus */
  setDoubleTap: (key: string) => invoke<DoubleTapStatus>("set_double_tap", { key }),
  doubleTapStatus: () => invoke<DoubleTapStatus>("double_tap_status"),
  /** Tell the Rust core the UI language (for its messages and the tray menu) */
  setLanguage: (lang: string) => invoke<void>("set_language", { lang }),
  quickResetPos: () => invoke<void>("quick_reset_pos"),
  listModels: (hostId: string) => invoke<ModelInfo[]>("list_models", { hostId }),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config", { cfg }),
  testHost: (hostId: string) => invoke<string>("test_host", { hostId }),
  listSessions: (hostId: string) => invoke<SessionInfo[]>("list_sessions", { hostId }),
  piOpen: (hostId: string, cwd: string, sessionPath?: string) =>
    invoke<number>("pi_open", { hostId, cwd, sessionPath: sessionPath ?? null }),
  piClose: (handle: number) => invoke<void>("pi_close", { handle }),
  piCloseAll: () => invoke<void>("pi_close_all"),
  listFiles: (hostId: string, folders: string[]) => invoke<FolderListing[]>("list_files", { hostId, folders }),
  readFile: (hostId: string, path: string) => invoke<string>("read_file", { hostId, path }),
  writeFile: (hostId: string, path: string, content: string) => invoke<void>("write_file", { hostId, path, content }),
  createFile: (hostId: string, path: string) => invoke<void>("create_file", { hostId, path }),

  /** Send an RPC command to Pi; throws if success=false */
  async pi(handle: number, cmd: Record<string, unknown>): Promise<any> {
    const res = await invoke<PiResponse>("pi_send", { handle, cmd });
    if (!res.success) throw new Error(res.error || `Pi command ${res.command} failed`);
    return res.data;
  },
};
