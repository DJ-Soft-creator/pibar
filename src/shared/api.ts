// Interface to the Rust core: types and all invoke() calls (counterpart: src-tauri/src/lib.rs)
import { invoke } from "@tauri-apps/api/core";
import type { PiResult } from "./piProtocol";
import type { SessionOutline } from "./branches";
import type { SessionGroupBy, SessionSort } from "./sessionOrder";

/** Answer of read_file_head, see src-tauri/src/files.rs */
export interface HeadVersion {
  /** The file lies in a Git repository */
  inGit: boolean;
  /** Content in HEAD; null if the file is not committed yet */
  text: string | null;
}

/** A session file with a message that contains the search text, see src-tauri/src/sessions.rs */
export interface SearchHit {
  path: string;
  /** Working folder of the session (from the file's header), so a hit opens without the session list */
  cwd: string;
  /** Name from Pi or the first own message; empty if the file has neither */
  title: string;
  /** Role of that message: "user", "assistant" or a tool result */
  role: string;
  /** Text around the match, JSON escapes removed */
  snippet: string;
}

/** File state recorded before a message, see src-tauri/src/snapshot.rs */
export interface SnapshotTaken {
  /** Root of the repository the session folder is in */
  repo: string;
  commit: string;
  /** Entry id of the own message this state belongs to (the state after its answer) */
  tag: string;
}

/** Files Pi changed after one own message, see src-tauri/src/sessions.rs */
export interface MessageTouches {
  /** Entry id of the message (stable across branches and compaction) */
  id: string;
  paths: string[];
}

/** One file that going back changes: "M" changed, "A" created (goes away), "D" deleted (comes back) */
export interface RewindChange {
  /** Relative to the repository root */
  path: string;
  status: "M" | "A" | "D";
}

/** What going back would restore, see src-tauri/src/snapshot.rs */
export interface RewindPreview {
  /** Repository root, null if the session folder is not in a Git repository */
  repo: string | null;
  /** Recorded state of that point, null if there is none */
  commit: string | null;
  changes: RewindChange[];
  /** Paths Pi changed that lie outside the repository */
  skipped: string[];
}

/** What going back restored, see src-tauri/src/snapshot.rs */
export interface RewindRestored {
  /** State before restoring (for the undo), "" when undoing itself */
  backup: string;
  restored: string[];
  deleted: string[];
  failed: string[];
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
  /** Colour profile of the chat on this host, "" = the default from the settings */
  colorProfile: string;
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

/** Colours of one part of the chat; "" = keep what the theme does (see src/shared/colors.ts) */
export interface RoleColor {
  background?: string;
  text?: string;
}

/** Colours of thinking, tool calls, answers and own messages */
export interface ChatColors {
  thinking?: RoleColor;
  tools?: RoleColor;
  answer?: RoleColor;
  own?: RoleColor;
}

/** Colour profile of the chat: one set for the dark and one for the light theme, chosen per host */
export interface ColorProfile {
  id: string;
  name: string;
  dark?: ChatColors;
  light?: ChatColors;
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

/** Quick action button under the input, on the right (Rust: QuickActionCfg in config.rs) */
export interface QuickAction {
  id: string;
  /** Label of the button */
  name: string;
  /** "command": message/slash command to Pi · "shell": script in a new terminal tab */
  kind: "command" | "shell";
  text: string;
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
  /** Context mode chosen for this session (see shared/contextMode.ts): "private", "public" or empty = Pi's default */
  contextMode?: "private" | "public";
  /** Sections the mode-guard extension leaves out in public mode, saved with the session */
  contextStripped?: string[];
  pinned?: boolean;
  /** Colour name, see COLORS in src/shared/sessionColors.ts */
  color?: string;
  /** SessionGroup id */
  group?: string;
  /** Pi tools of this session: undefined = Pi's default, [] = none */
  tools?: string[];
  /** Model chosen for this session ("provider/model-id"); empty = Pi's model from the session file */
  model?: string;
  /** Thinking level chosen for this session; empty = as in the session file */
  thinking?: string;
  /** Model preset chosen for this session (id from AppConfig.presets); empty = own model and thinking level */
  preset?: string;
  /** "on"/"off": every message of this session runs in the background; empty = as in the settings */
  background?: string;
  /** Start time (ms since epoch) of the newest run in the background, 0 = none */
  backgroundAt?: number;
  /** Chat view of this session (see ChatMode); empty = as in the settings */
  chatMode?: ChatMode;
  /** Sampling temperature of this session (0–2, see shared/temperature.ts); absent = the model's default */
  temperature?: number;
  /**
   * Unread: set in the session menu or by a run that settled while nobody looked; it survives a restart and goes
   * away when the session is opened
   */
  unread?: boolean;
  /** Manual position in the list ("Own order", see sortRows in shared/sessionOrder.ts): higher = further down, 0 = not arranged yet */
  order?: number;
  /** Plan mode of this session (see shared/planMode.ts): read-only tools and a plan hint with each message */
  planMode?: boolean;
  /** Key of the parent session ("<hostId>|<sessionPath>") when this is a subagent session started by PiBar */
  parentKey?: string;
  /** Agent definition this subagent session runs as (src-tauri/src/agents.rs) */
  agentName?: string;
  /** Path of the agent's system prompt file on the host, applied again when the session is opened */
  agentPrompt?: string;
  /** The subagent rows under this session are folded away (src/main/subagents.ts) */
  kidsCollapsed?: boolean;
}

export interface SessionGroup {
  id: string;
  name: string;
  color: string;
  /** Closed when a block of the list shows it for the first time; then each block keeps its own state */
  collapsed: boolean;
}

/**
 * Named project folder in the left column (src/main/projects.ts): sessions whose working folder lies in this folder
 * appear under the project, and a new session started from the project runs in this folder.
 */
export interface Project {
  id: string;
  name: string;
  /** Host the folder lives on */
  hostId: string;
  /** Folder of the project, "~/…" or absolute */
  dir: string;
  collapsed: boolean;
  /** Fixed model preset for the sessions started here (id from AppConfig.presets); empty = the default of the settings */
  preset?: string;
  /**
   * Chat view its sessions start with: "natural", "technical" or "debug"; empty = as in the settings. A session that
   * was switched to another view in the header keeps its own.
   */
  view?: string;
  /**
   * Context mode its sessions start with (see shared/contextMode.ts): "private" or "public"; empty = as in the
   * settings. A session switched in the header keeps its own.
   */
  contextMode?: "private" | "public";
}

/** Quick start preset of the new-session dialog: name and fixed working folder */
export interface SessionPreset {
  name: string;
  dir: string;
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
  /** Named project folders in the left column, below the hosts */
  projects?: Project[];
  /** Colour profiles of the chat (thinking, tool calls, answers, own messages) */
  colorProfiles?: ColorProfile[];
  /** Quick action buttons under the input, on the right (src/main/quickActions.ts) */
  quickActions?: QuickAction[];
  ui: {
    /** "auto", "de" or "en" */
    language?: string;
    showTools: boolean;
    showThinking: boolean;
    selectedHost?: string;
    collapsedHosts?: string[];
    /** Collapsed date or folder sections of the session list: "<hostId>|<date|folder>|<section>" */
    collapsedSections?: string[];
    /** Groups closed in a block of the list (host or project): "<block>|<group id>"; see sessionGroups.ts */
    groupCollapsed?: Record<string, boolean>;
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
    /** Height of the terminal below the chat in pixels */
    termHeight?: number | null;
    /** The terminal shows the shell of the session you switch to (default on) */
    termFollowSession?: boolean;
    /** Every session gets a terminal tab of its own (default off: only the "+" button opens one) */
    termAutoOpen?: boolean;
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
    /**
     * Default context mode of new sessions (Pi extension mode-guard): "private" or "public"; empty = the extension's
     * default. A project's mode and a session's own mode in its SessionMeta win over this.
     */
    defaultMode?: "private" | "public" | "";
    /** Auto scroll: "auto" (default, pauses when scrolling up), "always" (forced) or "off"; "on" = auto (older) */
    autoScroll?: "auto" | "always" | "off" | "on";
    /** File tree: only Markdown, HTML and images (default: all files) */
    filesDocsOnly?: boolean;
    /** Send messages as detached runs on the host by default ("in the background") */
    background?: boolean;
    /** Last session shown per host (host id → session file), so switching hosts brings it back */
    sessionByHost?: Record<string, string>;
    /** Colour profile for hosts without their own, "" = the theme's colours */
    colorProfile?: string;
    /** Session list: order and sections (src/shared/sessionOrder.ts) */
    sessionSort?: SessionSort;
    sessionGroup?: SessionGroupBy;
    /** View of the session list: everything, or only what I am working on (see listFilter.ts) */
    sessionFilter?: "all" | "active";
    /** Colour filter: colour names (COLORS in src/shared/sessionColors.ts) or "none"; empty = every colour */
    sessionColors?: string[];
    /** Own short descriptions of the session colours (colour name → label); empty = built-in colour name */
    sessionColorLabels?: Record<string, string>;
    /** Quick start presets at the top of the new-session dialog: up to 4, each with its own folder */
    sessionPresets?: SessionPreset[];
    /** Text size of the whole window as a factor (1 = 100 %), see src/main/layout.ts */
    fontScale?: number;
  };
}

/** A commit of the Git history (src-tauri/src/gitlog.rs) */
export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  /** Seconds since the epoch */
  time: number;
  refs: string;
  subject: string;
  unpushed: boolean;
}

export interface SessionInfo {
  path: string;
  id: string;
  cwd: string;
  timestamp: string;
  title: string;
  name: string | null;
  /** Session this one was branched from (Pi's fork), null = none */
  parent?: string | null;
  /** Last change of the file (last activity), seconds since the epoch; 0 = unknown */
  modified?: number;
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

/** An agent definition for subagent sessions (Rust: AgentInfo in agents.rs) */
export interface AgentInfo {
  name: string;
  description: string;
  /** Tool allowlist, null = Pi's default */
  tools: string[] | null;
  /** "provider/id" or a bare model id, "" = the session's model */
  model: string;
  /** "user" (~/.pi/agent/agents) or "project" (.pi/agents) */
  source: string;
  /** Path of the definition on the host */
  path: string;
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
  /** Typed per command by `api.pi` */
  data?: unknown;
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
  /** Attached text files (go into the message as tagged blocks, format.ts withFiles) */
  files: { name: string; text: string }[];
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
  /** Agent definitions of a host: ~/.pi/agent/agents plus the nearest .pi/agents above cwd (src-tauri/src/agents.rs) */
  listAgents: (hostId: string, cwd: string) => invoke<AgentInfo[]>("list_agents", { hostId, cwd }),
  /** Write an agent's system prompt to ~/.pibar/agent-prompts on the host; returns the absolute path */
  agentPromptFile: (hostId: string, path: string) => invoke<string>("agent_prompt_file", { hostId, path }),
  getConfig: () => invoke<AppConfig>("get_config"),
  saveConfig: (cfg: AppConfig) => invoke<void>("save_config", { cfg }),
  /** Problem with the settings file at start (damaged file reset, backup path), null = all fine */
  configLoadError: () => invoke<string | null>("config_load_error"),
  testHost: (hostId: string) => invoke<string>("test_host", { hostId }),
  listSessions: (hostId: string) => invoke<SessionInfo[]>("list_sessions", { hostId }),
  /** Delete session files (only paths inside Pi's sessions folder) */
  deleteSessions: (hostId: string, paths: string[]) => invoke<number>("delete_sessions", { hostId, paths }),
  /** tools: null = Pi's default, [] = no tools, otherwise an allowlist */
  piOpen: (hostId: string, cwd: string, sessionPath?: string, tools?: string[] | null, appendPrompt?: string | null) =>
    invoke<number>("pi_open", {
      hostId,
      cwd,
      sessionPath: sessionPath ?? null,
      tools: tools ?? null,
      appendPrompt: appendPrompt ?? null,
    }),
  piClose: (handle: number) => invoke<void>("pi_close", { handle }),
  /** What a Pi process wrote to stderr (tail) */
  piStderr: (handle: number) => invoke<string>("pi_stderr", { handle }),
  /** Diagnosis report for a host (Pi, environment, model config, reachability), see src-tauri/src/diag.rs */
  diagnose: (hostId: string, provider: string, model: string) =>
    invoke<string>("diagnose", { hostId, provider, model }),
  piCloseAll: () => invoke<void>("pi_close_all"),
  /** Send one message as a detached run on the host; returns the handle of the log stream (see SessionTab.bg) */
  bgStart: (
    hostId: string,
    cwd: string,
    session: string,
    prompt: string,
    provider?: string,
    modelId?: string,
    thinking?: string,
    tools?: string[] | null,
    publicMode = false,
    temperature?: number | null,
  ) =>
    invoke<number>("bg_start", {
      hostId,
      cwd,
      session,
      prompt,
      provider: provider ?? null,
      modelId: modelId ?? null,
      thinking: thinking ?? null,
      tools: tools ?? null,
      publicMode,
      temperature: temperature ?? null,
    }),
  /** Install the temperature extension on a host (src-tauri/src/temp.rs); Pi loads it on the next session start */
  tempInstall: (hostId: string) => invoke<void>("temp_install", { hostId }),
  /** Follow a run in the background that was started earlier (e.g. before PiBar was restarted) */
  bgFollow: (hostId: string, session: string) => invoke<number>("bg_follow", { hostId, session }),
  /** Is the session's run in the background still going? */
  bgRunning: (hostId: string, session: string) => invoke<boolean>("bg_running", { hostId, session }),
  /** Stop the session's run in the background */
  bgStop: (hostId: string, session: string) => invoke<void>("bg_stop", { hostId, session }),
  /** Interactive shell in a pty (src-tauri/src/terminal.rs); returns the terminal id */
  termOpen: (hostId: string, cwd: string, cols: number, rows: number) =>
    invoke<number>("term_open", { hostId, cwd, cols, rows }),
  /** Keys and pasted text */
  termWrite: (id: number, data: string) => invoke<void>("term_write", { id, data }),
  termResize: (id: number, cols: number, rows: number) => invoke<void>("term_resize", { id, cols, rows }),
  termClose: (id: number) => invoke<void>("term_close", { id }),
  termCloseAll: () => invoke<void>("term_close_all"),
  /** `docsOnly`: only Markdown, HTML and images instead of all files */
  listFiles: (hostId: string, folders: string[], git = false, docsOnly = false) =>
    invoke<FolderListing[]>("list_files", { hostId, folders, git, docsOnly }),
  readFile: (hostId: string, path: string) => invoke<string>("read_file", { hostId, path }),
  /** Git history: commits of the repository of `dir`, or of `file` (name relative to `dir`) */
  gitLog: (hostId: string, dir: string, file?: string, limit = 200) =>
    invoke<GitCommit[]>("git_log", { hostId, dir, file: file ?? null, limit }),
  gitCommit: (hostId: string, dir: string, hash: string) =>
    invoke<{ message: string; files: { status: string; path: string }[] }>("git_commit", { hostId, dir, hash }),
  /** Diff of a file in a commit; `top`: path relative to the repository root, otherwise to `dir` */
  gitDiff: (hostId: string, dir: string, hash: string, path: string, top: boolean) =>
    invoke<string>("git_diff", { hostId, dir, hash, path, top }),
  /** Remember the files of the session folder as the state before a message; null if the folder is not in a Git
   * repository (src-tauri/src/snapshot.rs) */
  snapshotTake: (hostId: string, dir: string, sessionId: string, tag: string) =>
    invoke<SnapshotTaken | null>("snapshot_take", { hostId, dir, sessionId, tag }),
  /** Files Pi changed since that point of the session (`paths` as Pi named them), see src/main/rewindFiles.ts */
  rewindPreview: (hostId: string, dir: string, sessionIds: string[], tag: string, paths: string[]) =>
    invoke<RewindPreview>("rewind_preview", { hostId, dir, sessionIds, tag, paths }),
  /** Put those files back to the recorded state of that point; null if there is none */
  rewindRestore: (hostId: string, dir: string, sessionIds: string[], tag: string, paths: string[]) =>
    invoke<RewindRestored | null>("rewind_restore", { hostId, dir, sessionIds, tag, paths }),
  /** Undo a restore: the same files back to the state before it (`backup`) */
  rewindUndo: (hostId: string, dir: string, commit: string, paths: string[]) =>
    invoke<RewindRestored>("rewind_undo", { hostId, dir, commit, paths }),
  /** Files Pi changed, per own message of a session file (see src-tauri/src/sessions.rs) */
  sessionTouches: (hostId: string, path: string) => invoke<MessageTouches[]>("session_touches", { hostId, path }),
  /** Image of the file panel (png, jpeg, gif, webp) as base64; read only */
  readImage: (hostId: string, path: string) =>
    invoke<{ mimeType: string; data: string }>("read_image", { hostId, path }),
  /** File content in Git HEAD, for the diff view */
  readFileHead: (hostId: string, path: string) => invoke<HeadVersion>("read_file_head", { hostId, path }),
  writeFile: (hostId: string, path: string, content: string) => invoke<void>("write_file", { hostId, path, content }),
  /** Upload a file of any type (e.g. PDF) into a folder on the host; data is base64 (src/main/fileUpload.ts).
   * false = the file exists and was kept; ask the user, then call again with overwrite. */
  uploadFile: (hostId: string, path: string, data: string, overwrite = false) =>
    invoke<boolean>("upload_file", { hostId, path, data, overwrite }),
  createFile: (hostId: string, path: string) => invoke<void>("create_file", { hostId, path }),
  createDir: (hostId: string, path: string) => invoke<void>("create_dir", { hostId, path }),
  /** Subfolders of a folder on the host, for the folder picker (src/main/folderPicker.ts) */
  /** User messages (entry ids) of session files, to find where branches part (src/shared/branches.ts) */
  sessionOutlines: (hostId: string, paths: string[]) => invoke<SessionOutline[]>("session_outlines", { hostId, paths }),
  /** Sessions of a host whose messages contain `query` (src/main/search.ts) */
  searchSessions: (hostId: string, query: string) => invoke<SearchHit[]>("search_sessions", { hostId, query }),
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

  /** Answer a dialog Pi asked for (extension_ui_request); Pi sends no response to it */
  piReply: (handle: number, msg: { id: string; value?: string; confirmed?: boolean; cancelled?: boolean }) =>
    invoke<void>("pi_reply", { handle, msg: { type: "extension_ui_response", ...msg } }),
  /** Send an RPC command to Pi; throws if success=false. The result type follows the command (piProtocol.ts). */
  async pi<K extends string>(handle: number, cmd: { type: K; [key: string]: unknown }): Promise<PiResult<K>> {
    const res = await invoke<PiResponse>("pi_send", { handle, cmd });
    if (!res.success) throw new Error(res.error || `Pi command ${res.command} failed`);
    return res.data as PiResult<K>;
  },
};
