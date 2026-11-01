// Interface to the Rust core: types and all invoke() calls (counterpart: src-tauri/src/lib.rs)
import { invoke } from "@tauri-apps/api/core";

/** Answer of read_file_head, see src-tauri/src/files.rs */
export interface HeadVersion {
  /** The file lies in a Git repository */
  inGit: boolean;
  /** Content in HEAD; null if the file is not committed yet */
  text: string | null;
}

/** Answer of list_dirs, see src-tauri/src/files.rs */
export interface DirListing {
  /** Resolved absolute path */
  path: string;
  /** Home folder of the host */
  home: string;
  dirs: string[];
}

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

/** Saved combination of model and thinking level; empty fields keep the session's value */
export interface ModelPreset {
  id: string;
  name: string;
  /** "<provider>/<model id>" */
  model: string;
  /** Pi thinking level, e.g. "high" */
  thinking: string;
}

export type Theme = "auto" | "light" | "dark";
/** natural: text only · technical: collapsed thinking/tool cards · debug: cards open, live */
export type ChatMode = "natural" | "technical" | "debug";
/** short: brief answers · normal: no hint · technical: as short as possible but with technical details */
export type AnswerMode = "short" | "normal" | "technical";

/** Dictation, read aloud and text improvement (Rust: VoiceCfg in config.rs) */
export interface VoiceCfg {
  stt: {
    /** "off", "api" (OpenAI-compatible) or "command" (local program, {file} = recording) */
    provider: "off" | "api" | "command";
    baseUrl: string;
    apiKey: string;
    model: string;
    language: string;
    command: string;
  };
  tts: {
    /** "system" (OS voice) or "api" (OpenAI-compatible) */
    provider: "system" | "api";
    baseUrl: string;
    apiKey: string;
    model: string;
    voice: string;
    /** "off", "quick" (answers to quick bar messages) or "all" */
    autoRead: "off" | "quick" | "all";
  };
  improve: {
    enabled: boolean;
    afterDictation: boolean;
    baseUrl: string;
    apiKey: string;
    model: string;
    /** empty = default prompt */
    prompt: string;
  };
}

/** Name, pin, colour and group of a session */
export interface SessionMeta {
  name?: string;
  pinned?: boolean;
  /** Colour name, see COLORS in src/main/menu.ts */
  color?: string;
  /** SessionGroup id */
  group?: string;
  /** Pi tools of this session: undefined = Pi's default, [] = none */
  tools?: string[];
}

export interface SessionGroup {
  id: string;
  name: string;
  color: string;
  collapsed: boolean;
}

export interface AppConfig {
  hosts: HostCfg[];
  sessionFolders: Record<string, string[]>;
  reminders: Reminder[];
  presets: ModelPreset[];
  voice: VoiceCfg;
  /** Key "<hostId>|<sessionPath>" */
  sessionMeta: Record<string, SessionMeta>;
  groups: SessionGroup[];
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
    /** "auto", "light" or "dark" */
    theme?: Theme;
    /** How much of Pi's work the chat shows */
    chatMode?: ChatMode;
    /** Answer style hint appended to each message */
    answerMode?: AnswerMode;
    /** Panel widths in pixels */
    leftWidth?: number | null;
    rightWidth?: number | null;
    /** Height of the file tree above the editor (percent of the right panel) */
    filesSplit?: number | null;
    /** Git status in the file tree */
    showGit?: boolean;
    /** Time of each chat message */
    showTimes?: boolean;
    /** Notification when a session finishes while PiBar is in the background (default on) */
    notifyDone?: boolean;
    /** Default for new sessions: preset id, or model "<provider>/<id>" plus thinking level ("" = Pi's default) */
    defaultPreset?: string;
    defaultModel?: string;
    defaultThinking?: string;
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
  /** Markdown files relative to root; folders end with "/" */
  files: string[];
  /** The folder does not exist on the host */
  missing: boolean;
  error: string | null;
  /** Git status (only with ui.showGit): the repository of the folder ("" dir) and repositories in subfolders */
  git?: GitInfo[];
}

/** Branch, sync state with the upstream (as of the last fetch) and changed files */
export interface GitInfo {
  /** Repository folder relative to the listed folder, "" = the listed folder itself */
  dir: string;
  branch: string;
  upstream: string | null;
  /** Commits not pushed yet */
  ahead: number;
  /** Commits on the upstream not pulled yet */
  behind: number;
  /** Paths relative to the listed folder (folders end with "/"); code = porcelain "XY", e.g. " M", "??" */
  changes: { path: string; code: string }[];
}

export interface PiModel {
  id: string;
  name: string;
  provider: string;
  reasoning?: boolean;
  /** Context window in tokens */
  contextWindow?: number;
}

/** Slash command from Pi's get_commands: skill, prompt template or extension command */
export interface PiCommand {
  name: string;
  description?: string;
  /** "skill", "prompt" or "extension" */
  source?: string;
  location?: string;
  path?: string;
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
  /** Id of the chosen preset, null = model/thinking chosen individually */
  preset: string | null;
  text: string;
  images: { data: string; mimeType: string }[];
  ocr: string | null;
}

/** Status of the double-tap listener (src-tauri/src/doubletap.rs) */
export type DoubleTapStatus = "off" | "active" | "permission" | "error" | "unsupported";

export const api = {
  showMain: () => invoke<void>("show_main"),
  setHotkey: (accel: string) => invoke<void>("set_hotkey", { accel }),
  /** Shortcut of the quick bar and why it could not be registered (null = registered) */
  hotkeyStatus: () => invoke<{ accel: string; error: string | null }>("hotkey_status"),
  /** Returns the status code, see DoubleTapStatus */
  setDoubleTap: (key: string) => invoke<DoubleTapStatus>("set_double_tap", { key }),
  doubleTapStatus: () => invoke<DoubleTapStatus>("double_tap_status"),
  /** Tell the Rust core the UI language (for its messages and the tray menu) */
  setLanguage: (lang: string) => invoke<void>("set_language", { lang }),
  quickResetPos: () => invoke<void>("quick_reset_pos"),
  listModels: (hostId: string) => invoke<ModelInfo[]>("list_models", { hostId }),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config", { cfg }),
  /** Problem with the settings file at start (damaged file reset, backup path), null = all fine */
  configLoadError: () => invoke<string | null>("config_load_error"),
  testHost: (hostId: string) => invoke<string>("test_host", { hostId }),
  listSessions: (hostId: string) => invoke<SessionInfo[]>("list_sessions", { hostId }),
  /** Delete session files (only paths inside Pi's sessions folder) */
  deleteSessions: (hostId: string, paths: string[]) => invoke<number>("delete_sessions", { hostId, paths }),
  /** tools: null = Pi's default, [] = no tools, otherwise an allowlist */
  piOpen: (hostId: string, cwd: string, sessionPath?: string, tools?: string[] | null) =>
    invoke<number>("pi_open", { hostId, cwd, sessionPath: sessionPath ?? null, tools: tools ?? null }),
  piClose: (handle: number) => invoke<void>("pi_close", { handle }),
  /** What a Pi process wrote to stderr (tail) */
  piStderr: (handle: number) => invoke<string>("pi_stderr", { handle }),
  /** Diagnosis report for a host (Pi, environment, model config, reachability), see src-tauri/src/diag.rs */
  diagnose: (hostId: string, provider: string, model: string) =>
    invoke<string>("diagnose", { hostId, provider, model }),
  piCloseAll: () => invoke<void>("pi_close_all"),
  listFiles: (hostId: string, folders: string[], git = false) =>
    invoke<FolderListing[]>("list_files", { hostId, folders, git }),
  readFile: (hostId: string, path: string) => invoke<string>("read_file", { hostId, path }),
  /** File content in Git HEAD, for the diff view */
  readFileHead: (hostId: string, path: string) => invoke<HeadVersion>("read_file_head", { hostId, path }),
  writeFile: (hostId: string, path: string, content: string) => invoke<void>("write_file", { hostId, path, content }),
  createFile: (hostId: string, path: string) => invoke<void>("create_file", { hostId, path }),
  createDir: (hostId: string, path: string) => invoke<void>("create_dir", { hostId, path }),
  /** Subfolders of a folder on the host, for the folder picker (src/main/folderPicker.ts) */
  listDirs: (hostId: string, path: string, hidden = false) => invoke<DirListing>("list_dirs", { hostId, path, hidden }),
  /** Screenshot: "region" (drag an area) or "screen"; null if cancelled */
  captureScreen: (mode: "region" | "screen") =>
    invoke<{ path: string; data: string; mimeType: string } | null>("capture_screen", { mode }),
  /** Recording (base64) → text with the dictation settings */
  transcribe: (data: string, mime: string) => invoke<string>("transcribe_audio", { data, mime }),
  /** Text → improved text by the second LLM */
  improveText: (text: string, prompt: string) => invoke<string>("improve_text", { text, prompt }),
  /** Text → speech (mp3, base64) through the API */
  speakText: (text: string) => invoke<{ data: string; mimeType: string }>("speak_text", { text }),

  /** Send an RPC command to Pi; throws if success=false */
  async pi(handle: number, cmd: Record<string, unknown>): Promise<any> {
    const res = await invoke<PiResponse>("pi_send", { handle, cmd });
    if (!res.success) throw new Error(res.error || `Pi command ${res.command} failed`);
    return res.data;
  },
};
