// One open session: a Pi process (via the Rust core) plus the chat rendering of its events
import { api, ChatMode, PiCommand, PiModel } from "../shared/api";
import { isChatMode } from "../shared/chatViews";
import {
  CONTEXT_SECTIONS,
  CONTEXT_SECTIONS_COMMAND,
  contextModeCommand,
  contextSectionCommand,
  isContextMode,
  parseContextStatus,
  startContextMode,
  type ContextMode,
} from "../shared/contextMode";
import { projectAt } from "../shared/projects";
import { sessionStarted } from "./terminal";
import type { BranchChoice } from "../shared/branches";
import { findQuestions, type QuestionGroup } from "../shared/questions";
import type {
  UiRequest,
  AssistantMessage,
  Content,
  PiEvent,
  PiMessage,
  PiSessionStats,
  ToolArgs,
  Usage,
} from "../shared/piProtocol";
import { copyText, h, renderMarkdown, errMsg, toast } from "../shared/dom";
import {
  baseName,
  msgTime,
  splitContext,
  splitFiles,
  shortModel,
  splitScreenText,
  stripAnswerStyle,
  tokensPerSecond,
  withAnswerStyle,
} from "../shared/format";
import { getLang, t } from "../shared/i18n";
import { isStaleInstallError } from "../shared/piErrors";
import { PLAN_TOOLS, stripPlanMode, withPlanMode } from "../shared/planMode";
import { subagentFromArgs, subagentFromDetails, type SubagentCall } from "../shared/subagents";
import { resolveChoice } from "../shared/presets";
import { clampTemp, isTemp, parseTemperatureStatus, temperatureCommand } from "../shared/temperature";
import { speak, stopSpeaking } from "../shared/voice";
import { icon, IconName } from "../shared/icons";
import type { Attachment } from "./composerTools";
import { diagnoseDialog } from "./diagnose";
import { saveConfig, state } from "./state";

type PartKind = "text" | "thinking" | "tool";

interface Part {
  kind: PartKind;
  el: HTMLElement;
  body: HTMLElement;
  text: string;
  dirty: boolean;
}

interface ToolCard {
  card: HTMLDetailsElement;
  preview: HTMLElement;
  status: HTMLElement;
  args: HTMLElement;
  result: HTMLElement;
  argsRaw: string;
  /** Tool name (edit, write, bash, …) */
  name?: string;
}

/** Tools that change files: their `path` shows up as edited in the file tree */
const FILE_TOOLS = new Set(["edit", "write", "multi_edit", "create"]);

/** What to do with an earlier own message (buttons under a user bubble) */
export type UserAction = "edit" | "rerun" | "rewind" | "reuse" | "copy";

/** Where an "Undo" after branching or going back returns to */
export interface BranchUndo {
  /** Session file before the branch */
  fromPath: string;
  /** File of the branch (deleted on undo), null if Pi has not saved it */
  branchPath: string | null;
  /** Files that "go back" restored: the undo puts them back (src/main/rewindFiles.ts) */
  files?: { cwd: string; commit: string; paths: string[] };
}

type Image = { data: string; mimeType: string };
export type QueueWhen = "steer" | "followUp";
export interface QueueItem {
  text: string;
  when: QueueWhen;
}

/** A message sent as a detached run on the host: `handle` is the log stream the tab follows */
export interface BackgroundRun {
  handle: number;
  started: number;
}

export interface TabCallbacks {
  onHandle: (tab: SessionTab) => void;
  onStateChange: (tab: SessionTab) => void;
  onSettled: (tab: SessionTab) => void;
  /**
   * Button under an own message; `index` = position among the user messages of this chat, `text` = the message as
   * sent, `edited` = new text for "edit"
   */
  onUserAction: (tab: SessionTab, index: number, action: UserAction, text: string, edited?: string) => void;
  /** A run of Pi starts (auto scroll decides whether to follow it) */
  onAnswerStart: (tab: SessionTab) => void;
  /** Dialog or notice from a Pi extension (Pi waits for dialogs to be answered) */
  onUiRequest: (tab: SessionTab, req: UiRequest) => void;
  /** A run in the background started or ended (marker in the session list and sessionMeta) */
  onBackground?: (tab: SessionTab, running: boolean) => void;
}

const MAX_RESULT = 20000;

/** Running number for sessions without a file yet: their key stays stable from the start (see `key`) */
let sessionSeq = 0;

/** Token counters of a session (shown in the header, see usageStats.ts) */
export interface TabStats {
  responses: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
  /** Tokens in the context after the last answer */
  lastContext: number;
  /** Output tokens of the last answer */
  lastOutput: number;
  /** Output tokens per second of the last live answer */
  lastTps: number | null;
  /** Time to first token of the last live answer (ms) */
  lastTtft: number | null;
  /** Sum of live generation time (ms) and its output tokens, for the average speed */
  genMs: number;
  genTokens: number;
}

function emptyStats(): TabStats {
  return {
    responses: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    total: 0,
    cost: 0,
    lastContext: 0,
    lastOutput: 0,
    lastTps: null,
    lastTtft: null,
    genMs: 0,
    genTokens: 0,
  };
}

const ICON_SPEAK =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M2.5 6h2.5l3.5-3v10L5 10H2.5z"/><path d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.5a6 6 0 0 1 0 9"/></svg>';

const ICON_COPY =
  '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 3.5A1.5 1.5 0 0 0 9 2H4a2 2 0 0 0-2 2v5a1.5 1.5 0 0 0 1.5 1.5"/></svg>';

/** Button that is reading aloud right now */
let speakingBtn: HTMLElement | null = null;

/** Read a text aloud (second click stops); errors as toast */
export function readAloud(text: string, btn: HTMLElement | null = null) {
  const again = !!btn && speakingBtn === btn;
  stopSpeaking();
  speakingBtn?.classList.remove("on");
  speakingBtn = null;
  if (again) return;
  speakingBtn = btn;
  btn?.classList.add("on");
  speak(state.config.voice, text, getLang())
    .catch((e) => toast(`${t("Read aloud")}: ${errMsg(e)}`, "err"))
    .finally(() => {
      if (speakingBtn === btn) {
        btn?.classList.remove("on");
        speakingBtn = null;
      }
    });
}

/** Chat view from the settings: the default for sessions without a view of their own (see `SessionTab.viewMode`) */
export function defaultViewMode(): ChatMode {
  const m = state.config?.ui.chatMode;
  return m === "natural" || m === "debug" ? m : "technical";
}

export class SessionTab {
  readonly hostId: string;
  sessionPath: string | null;
  cwd: string;
  title: string;
  handle = 0;
  alive = false;
  streaming = false;
  model: PiModel | null = null;
  thinkingLevel = "";
  /** Pi's session id (get_state), "" while Pi has no session file yet */
  sessionId = "";
  models: PiModel[] = [];
  levels: string[] = [];
  /** Preset chosen in the toolbar or quick bar: id, "" = individual choice, null = derive from model/thinking */
  presetId: string | null = null;
  stats: TabStats = emptyStats();
  /** Pi's get_session_stats (tokens, cost, context use of the whole session), null = not loaded */
  piStats: PiSessionStats | null = null;
  /** Finished while not on screen (marked in the list until opened) */
  unseen = false;
  /** The last run ended with an error */
  failed = false;
  /** Skills, prompt templates and extension commands (for the "/" menu) */
  commands: PiCommand[] = [];
  /**
   * Context mode as Pi's mode-guard extension reports it (footer status); "" = not reported yet, usually because the
   * extension is not loaded on this host
   */
  contextMode: ContextMode = "";
  /** Sections the extension leaves out in public mode (its status names them) */
  contextStripped: string[] = [];
  /** The saved mode has been pushed to Pi at least once in this tab (see `applyContext`) */
  private contextApplied = false;
  /** A saved mode waits for the extension to load (its `/mode` command was not listed yet) */
  private contextPending = false;
  /** Timer that retries a pending mode push (see `applyContext`) */
  private contextTimer: number | undefined;
  /** The extension's first status of this start arrived (it reports the default before the saved mode is pushed) */
  private contextStatusSeen = false;
  /** Sampling temperature of this session (Pi extension pibar-temperature); null = the model's default */
  temperature: number | null = null;
  /** The saved temperature has been pushed to Pi at least once in this tab (see `applyTemperature`) */
  private tempApplied = false;
  /** A saved temperature waits for the extension to load (its `/temperature` command was not listed yet) */
  private tempPending = false;
  /** Timer that retries a pending temperature push (see `applyTemperature`) */
  private tempTimer: number | undefined;
  /** The extension's first status of this start arrived (it reports the default before the saved value is pushed) */
  private tempStatusSeen = false;
  /** Name of the tool that is running right now ("" = none) */
  activity = "";
  /** Read the next answer aloud (message came from the quick bar) */
  readNext = false;
  /** Name given in "New session", saved as own name once the session has a file */
  pendingName = "";
  /** Message being written for this session (kept when switching to another session and back) */
  draft = "";
  /** Files picked for the next message of this session, see draft */
  draftAttachments: Attachment[] = [];
  /** Pi tools for this session (allowlist), null = Pi's default; applied when Pi starts */
  toolset: string[] | null = null;
  /** Plan mode (src/shared/planMode.ts): read-only tools and a plan hint with each message; Build = off */
  planMode = false;
  /** The session's own tools while plan mode is on; they come back when switching to Build */
  toolsetBeforePlan: string[] | null = null;
  /** Agent system prompt file on the host (subagent session, src/main/subagents.ts); Pi gets it at start */
  agentPromptFile: string | null = null;
  /** Runs of the subagent extension, by tool call id (shown under the session in the list, src/main/subagents.ts) */
  subagentCalls = new Map<string, SubagentCall>();
  /** Run in the background (src-tauri/src/bg.rs): Pi runs detached on the host, the tab follows its log */
  bg: BackgroundRun | null = null;
  /** Every message of this session goes to the background (toggle in the send menu, default from the settings) */
  background = false;
  /** No Pi process here: the tab shows a run in the background (or waits for the next one) */
  detached = false;
  /** The current run in the background reported agent_settled (otherwise it ended without an answer) */
  private bgSettled = false;
  /** The user stopped the current run in the background (no answer is not an error then) */
  private bgStopWanted = false;
  /** Text of the last answer of the current run (for auto read) */
  private lastText = "";
  /** Choice questions at the end of the last answer (answer dialog, src/main/answerDialog.ts); [] = none */
  questions: QuestionGroup[] = [];

  readonly el: HTMLElement;
  private cur: { el: HTMLElement; parts: Map<number, Part> } | null = null;
  private tools = new Map<string, ToolCard>();
  private raf = 0;
  private cb: TabCallbacks;
  /** Live timing: request start and first token of the current answer */
  private reqStart = 0;
  /**
   * Model and thinking changes still on their way to Pi. Pi handles RPC commands concurrently: a prompt sent right
   * after set_model could start before the switch is done and still use the old model. send() waits for this.
   */
  private settling: Promise<unknown> = Promise.resolve();
  private firstToken = 0;
  /** Number of user messages shown (index for the message actions) */
  private userCount = 0;
  /** Own number of this tab; a session without a file is known by it from the start (see `key`) */
  private readonly uid = ++sessionSeq;

  constructor(hostId: string, cwd: string, sessionPath: string | null, title: string, cb: TabCallbacks) {
    this.hostId = hostId;
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this.title = title;
    this.cb = cb;
    this.el = h("div", { class: "messages" });
  }

  /**
   * Key of this session in the settings: "<hostId>|<sessionPath>". A session that has no file yet gets a key of its
   * own from the first moment (`new-<number>`), so name, colour and group can be set before the first message. When
   * Pi saves the session, the settings move over to the file (see `rekey` in sessions.ts).
   */
  get key(): string {
    return `${this.hostId}|${this.sessionPath ?? `new-${this.uid}`}`;
  }

  // ---------- The chat view of this session ----------

  /** View this session starts with when it has none of its own: that of its project, else the setting */
  startView(): ChatMode {
    const own = projectAt(state.config.projects ?? [], this.hostId, this.cwd)?.view;
    return isChatMode(own) ? own : defaultViewMode();
  }

  /** Own view of this session, else the default of its project or of the settings */
  viewMode(): ChatMode {
    const own = state.config.sessionMeta?.[this.key]?.chatMode;
    return isChatMode(own) ? own : this.startView();
  }

  /**
   * Keep the chat view for this session only: switching to another session shows that session's view again. Choosing
   * the view the session starts with (project or settings) drops the own choice, so it follows that again.
   */
  setViewMode(mode: ChatMode) {
    const all = (state.config.sessionMeta ??= {});
    const m = (all[this.key] ??= {});
    if (mode === this.startView()) delete m.chatMode;
    else m.chatMode = mode;
    if (!Object.keys(m).length) delete all[this.key];
    saveConfig();
  }

  /** Cards open and live (thinking, tool input and output) in the "debug" chat view */
  private debug(): boolean {
    return this.viewMode() === "debug";
  }

  // ---------- Lifecycle ----------

  async start(onHandle?: (tab: SessionTab) => void) {
    this.note(this.sessionPath ? t("Loading session …") : t("Starting new session …"));
    this.handle = await api.piOpen(
      this.hostId,
      this.cwd,
      this.sessionPath ?? undefined,
      this.toolset,
      this.agentPromptFile,
    );
    this.alive = true;
    this.detached = false;
    this.contextStatusSeen = false;
    this.tempStatusSeen = false;
    // A terminal belongs to this session: its tab shows the session's name and colour (only if wanted and open)
    sessionStarted(this);
    onHandle?.(this);
    await this.refreshState();
    if (this.sessionPath) await this.loadHistory();
    this.el.querySelectorAll(".msg.note.loading").forEach((n) => n.remove());
    await this.refreshModels();
    await this.applyChoice();
    await this.applyContext();
    await this.applyTemperature();
    this.cb.onStateChange(this);
  }

  /** Start Pi again in the same session (after a crash, a lost connection or a tool change); the model chosen here
   * stays – a fresh process would otherwise take the model of the session file, i.e. the one used back then. */
  async restart() {
    if (this.detached) return this.attach();
    // also after Pi ended by itself: frees its entry in the Rust core
    if (this.handle) await api.piClose(this.handle).catch(() => {});
    this.clearView();
    await this.keepModel(() => this.start(this.cb.onHandle));
  }

  private clearView() {
    this.el.innerHTML = "";
    this.stats = emptyStats();
    this.tools.clear();
    this.cur = null;
    this.userCount = 0;
    this.userTexts = [];
  }

  // ---------- Branching (Pi RPC fork) ----------

  /** User messages of the current branch that can be forked from */
  async forkPoints(): Promise<{ entryId: string; text: string }[]> {
    const r = await api.pi(this.handle, { type: "get_fork_messages" });
    return r?.messages ?? [];
  }

  /**
   * Fork before a user message: Pi writes a new session file with the history up to that message and continues
   * there; the original session stays unchanged. Shows the new branch and returns the message text.
   */
  async forkAt(entryId: string): Promise<string | null> {
    return this.keepModel(async () => {
      const r = await api.pi(this.handle, { type: "fork", entryId });
      if (r?.cancelled) return null;
      const st = await api.pi(this.handle, { type: "get_state" });
      this.sessionPath = (st.messageCount ?? 0) > 0 ? (st.sessionFile ?? null) : null;
      this.model = st.model ?? this.model;
      this.thinkingLevel = st.thinkingLevel ?? this.thinkingLevel;
      this.sessionId = st.sessionId ?? "";
      this.clearView();
      if (this.sessionPath) await this.loadHistory();
      this.cb.onStateChange(this);
      return r?.text ?? "";
    });
  }

  /**
   * Pi takes model and thinking level from the history when it loads a session file (fork, switch to a branch):
   * that is the model used at that point back then, not the one chosen now. Keep the current choice.
   */
  private async keepModel<T>(fn: () => Promise<T>): Promise<T> {
    const model = this.model;
    const thinking = this.thinkingLevel;
    const result = await fn();
    if (!this.alive) return result;
    if (model && (this.model?.provider !== model.provider || this.model?.id !== model.id)) {
      try {
        const m = await api.pi(this.handle, { type: "set_model", provider: model.provider, modelId: model.id });
        this.model = m ?? model;
      } catch (e) {
        toast(`${t("Model")}: ${errMsg(e)}`, "err");
      }
    }
    if (thinking && this.thinkingLevel !== thinking) {
      try {
        await api.pi(this.handle, { type: "set_thinking_level", level: thinking });
        this.thinkingLevel = thinking;
      } catch {
        /* the model may not support this level */
      }
    }
    this.cb.onStateChange(this);
    return result;
  }

  /** Undo for the last branch or "go back" (shown as a bar above the input), null = nothing to undo */
  undo: BranchUndo | null = null;

  /** Switch this Pi process to another session file (RPC switch_session) and show it */
  async switchTo(path: string): Promise<boolean> {
    return this.keepModel(async () => {
      const r = await api.pi(this.handle, { type: "switch_session", sessionPath: path });
      if (r?.cancelled) return false;
      await this.refreshState();
      this.sessionPath = path;
      this.clearView();
      await this.loadHistory();
      this.cb.onStateChange(this);
      return true;
    });
  }

  /** Stop the Pi process. The session file stays and can be reopened. */
  close() {
    if (this.tempTimer !== undefined) window.clearTimeout(this.tempTimer);
    if (this.handle) api.piClose(this.handle).catch(() => {});
    // following a run in the background ends here; the run itself keeps going on the host
    if (this.bg) api.piClose(this.bg.handle).catch(() => {});
    this.alive = false;
    this.streaming = false;
  }

  /** Reload Pi's session statistics (status line under the input) */
  async refreshStats() {
    if (!this.alive || this.detached) return;
    try {
      this.piStats = await api.pi(this.handle, { type: "get_session_stats" });
      this.cb.onStateChange(this);
    } catch {
      /* older Pi: the live counters stay */
    }
  }

  async refreshState() {
    if (this.detached || !this.handle) return;
    void this.refreshStats();
    const st = await api.pi(this.handle, { type: "get_state" });
    this.model = st.model ?? null;
    this.thinkingLevel = st.thinkingLevel ?? "";
    this.sessionId = st.sessionId ?? "";
    this.streaming = !!st.isStreaming;
    if (st.sessionFile && (st.messageCount ?? 0) > 0) this.sessionPath = st.sessionFile;
    if (st.sessionName) this.title = st.sessionName;
  }

  async refreshModels() {
    try {
      const m = await api.pi(this.handle, { type: "get_available_models" });
      this.models = m.models ?? [];
    } catch (e) {
      this.models = [];
      toast(`${t("Models")}: ${errMsg(e)}`, "err");
    }
    try {
      const l = await api.pi(this.handle, { type: "get_available_thinking_levels" });
      this.levels = l.levels ?? [];
    } catch {
      this.levels = [];
    }
    try {
      const c = await api.pi(this.handle, { type: "get_commands" });
      this.commands = c.commands ?? [];
    } catch {
      this.commands = []; // older Pi versions
    }
    // the extension may register a moment after Pi started: push the saved mode as soon as its command shows up
    if (this.contextPending && this.contextAvailable()) void this.applyContext();
    if (this.tempPending && this.tempAvailable()) void this.applyTemperature();
  }

  /** Pi's statistics for the whole session (get_session_stats) */
  sessionStats(): Promise<PiSessionStats> {
    return api.pi(this.handle, { type: "get_session_stats" });
  }

  // ---------- Actions ----------

  /**
   * Send a message. While Pi works it waits in Pi's queue: `when` = "followUp" (after Pi is done) or "steer" (in
   * between, before Pi's next step). The queue is shown above the input (`queue`, chatView.ts renderQueue).
   */
  async send(text: string, images: Image[] = [], when: QueueWhen = "followUp") {
    if (this.detached) {
      await this.sendToBackground(text, images, when);
      return;
    }
    this.questions = [];
    // the state before this message, so "go back" can restore the files Pi is about to change
    if (!this.streaming) await this.rememberFiles();
    await this.settling.catch(() => {});
    const message = withPlanMode(withAnswerStyle(text, state.config.ui.answerMode), this.planMode);
    const cmd: { type: "prompt"; [key: string]: unknown } = { type: "prompt", message };
    if (images.length) cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    if (this.streaming) {
      cmd.streamingBehavior = when;
      if (images.length) this.queuedImages.set(message, images);
    }
    await api.pi(this.handle, cmd);
  }

  /** No Git repository (or no Git): no file states for this session, "go back" then only touches the conversation */
  private snapshotOff = false;

  /**
   * Record the files of the working folder as the state after the answer to the last own message
   * (src-tauri/src/snapshot.rs). Going back to that message later restores what Pi changes from here on; nothing is
   * recorded outside a Git repository. The state is kept under Pi's entry id, which survives branches and compaction.
   */
  private async rememberFiles(): Promise<void> {
    if (this.snapshotOff || !this.sessionId) return;
    try {
      const points = await this.forkPoints();
      const tag = points[points.length - 1]?.entryId;
      if (!tag) return; // the first message: there is no state before it yet
      if (!(await api.snapshotTake(this.hostId, this.cwd, this.sessionId, tag))) this.snapshotOff = true;
    } catch {
      this.snapshotOff = true;
    }
  }

  // ---------- Runs in the background (src-tauri/src/bg.rs) ----------

  /**
   * Send a message as a detached run on the host: Pi keeps working when PiBar quits or the connection drops. The tab
   * follows the run's log file and shows the answer from the session file once it is done.
   * Returns false if nothing was sent (the caller keeps the text in the input).
   */
  async sendToBackground(text: string, images: Image[] = [], when: QueueWhen = "followUp"): Promise<boolean> {
    if (this.bg) {
      toast(t("This session is still running in the background – wait or stop it."));
      return false;
    }
    if (images.length) {
      toast(t("Images only go with a normal message."));
      return false;
    }
    if (this.streaming) {
      // a live run of this tab: queue the message in Pi as usual
      if (!this.detached) {
        await this.send(text, images, when);
        return true;
      }
      toast(t("Pi is still working – wait for the answer."));
      return false;
    }
    // The first message of a new session has no session file yet: it goes the normal way, the rest can follow.
    if (!this.sessionPath) {
      await this.send(text, images);
      return true;
    }
    await this.rememberFiles();
    const message = withPlanMode(withAnswerStyle(text, state.config.ui.answerMode), this.planMode);
    const path = this.sessionPath;
    // before detaching: the live process knows model and thinking level of the session
    const choice = await this.runChoice();
    try {
      await this.detach();
      const handle = await api.bgStart(
        this.hostId,
        this.cwd,
        path,
        message,
        choice.provider,
        choice.modelId,
        choice.thinking,
        this.toolset,
        // public also for the detached run: the flag of the mode-guard extension
        this.contextMode === "public" && this.contextAvailable(),
        // temperature also for the detached run: the flag of the pibar-temperature extension
        this.tempAvailable() ? this.temperature : null,
      );
      this.startRun(handle);
      this.cb.onBackground?.(this, true);
      return true;
    } catch (e) {
      toast(`${t("In the background")}: ${errMsg(e)}`, "err");
      await this.attach().catch(() => {});
      return false;
    }
  }

  /**
   * Model and thinking level a detached run has to start with. A new Pi process takes the model of the device's default
   * (an extension sets it at start), not the one of the session – without these arguments the run in the background
   * would answer with another model than the session on screen. The choice saved for the session wins: after a reload
   * the live model can be the device default again, and the background run must still use the model the user picked.
   * The live process only fills what the saved choice leaves open.
   */
  private async runChoice(): Promise<{ provider?: string; modelId?: string; thinking?: string }> {
    const saved = resolveChoice(state.config.presets ?? [], state.config.sessionMeta?.[this.key] ?? {});
    if ((!saved.model || !saved.thinking) && this.alive && this.handle) {
      try {
        await this.refreshState();
      } catch {
        /* Pi may be gone already: the saved choice above still knows the model */
      }
    }
    return {
      provider: saved.model?.provider || this.model?.provider,
      modelId: saved.model?.id || this.model?.id,
      thinking: saved.thinking || this.thinkingLevel,
    };
  }

  /** Open a session whose run is still going in the background (e.g. after PiBar was restarted) */
  async followBackground(): Promise<void> {
    const path = this.sessionPath;
    if (!path) return;
    const handle = await api.bgFollow(this.hostId, path);
    this.alive = true;
    this.detached = true;
    this.note(t("This session runs in the background – its history appears when the run is done."));
    this.startRun(handle);
    this.cb.onBackground?.(this, true);
  }

  /** Stop the run in the background; the answer stays as far as Pi has written it */
  async stopBackground(): Promise<void> {
    if (!this.sessionPath) return;
    this.bgStopWanted = true;
    await api.bgStop(this.hostId, this.sessionPath).catch((e) => toast(errMsg(e), "err"));
  }

  private startRun(handle: number) {
    this.bg = { handle, started: Date.now() };
    this.bgSettled = false;
    this.bgStopWanted = false;
    state.tabsByHandle.set(handle, this);
    this.streaming = true;
    this.activity = "";
    this.cb.onStateChange(this);
  }

  /** Start Pi again in this session (after a run in the background) and show the history from the session file */
  async attach(): Promise<void> {
    const run = this.bg;
    if (run) {
      this.bg = null;
      state.tabsByHandle.delete(run.handle);
      await api.piClose(run.handle).catch(() => {});
    }
    this.detached = false;
    this.clearView();
    await this.keepModel(() => this.start(this.cb.onHandle));
    this.cb.onStateChange(this);
  }

  /** A run in the background ended (Pi wrote its answer into the session file): show the session from there */
  private async finishBackground(stderr: string) {
    const run = this.bg;
    if (!run) return;
    this.bg = null;
    this.streaming = false;
    this.activity = "";
    state.tabsByHandle.delete(run.handle);
    await api.piClose(run.handle).catch(() => {});
    this.flush();
    this.cb.onBackground?.(this, false);
    const ok = this.bgSettled || this.bgStopWanted;
    await this.attach().catch((e) => toast(`${t("In the background")}: ${errMsg(e)}`, "err"));
    if (stderr.trim()) this.el.append(h("div", { class: "msg note" }, stderr.trim().slice(-800)));
    if (!ok)
      toast(
        `${t("In the background")}: ${t("The run ended without an answer – its log is on the host in ~/.pibar.")}`,
        "err",
      );
    this.cb.onSettled(this);
  }

  /** Close this tab's Pi process; the session stays on the host and the next message can run in the background */
  private async detach() {
    this.alive = true; // the tab keeps showing the session, there is just no process of its own
    if (this.handle) {
      const handle = this.handle;
      this.handle = 0;
      state.tabsByHandle.delete(handle);
      await api.piClose(handle).catch(() => {});
    }
    this.detached = true;
    this.streaming = false;
    this.activity = "";
    this.queue = { steering: [], followUp: [] };
  }

  /** Messages waiting while Pi works (from Pi's queue_update): in between (steering) and after (followUp) */
  queue: { steering: string[]; followUp: string[] } = { steering: [], followUp: [] };
  /** Images of queued messages (Pi's queue only reports the text) */
  private queuedImages = new Map<string, Image[]>();

  /**
   * Change Pi's queue: Pi can only clear it as a whole, so take everything out, apply `change` and queue the rest
   * again in the new order. If Pi finished meanwhile, the first message starts a new run.
   */
  async editQueue(change: (items: QueueItem[]) => QueueItem[]) {
    const r = await api.pi(this.handle, { type: "clear_queue" });
    const items: QueueItem[] = [
      ...(r.steering ?? []).map((text) => ({ text, when: "steer" as const })),
      ...(r.followUp ?? []).map((text) => ({ text, when: "followUp" as const })),
    ];
    for (const it of change(items)) {
      const imgs = this.queuedImages.get(it.text) ?? [];
      const cmd: { type: "prompt"; [key: string]: unknown } = { type: "prompt", message: it.text };
      if (imgs.length) cmd.images = imgs.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
      if (this.streaming) cmd.streamingBehavior = it.when;
      await api.pi(this.handle, cmd);
      this.streaming = true; // from the first message on Pi works again
    }
  }

  async abort() {
    if (this.detached) return this.stopBackground();
    await api.pi(this.handle, { type: "abort" });
  }

  /** Run a settings change after the previous ones; send() waits until all are done */
  private settle<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.settling.catch(() => {}).then(fn);
    this.settling = run;
    return run;
  }

  setModel(provider: string, modelId: string) {
    if (this.streaming)
      this.note(t("The new model applies from the next message; the running answer keeps the old one."));
    this.presetId = ""; // an individual model is no preset
    return this.settle(async () => {
      const m = await api.pi(this.handle, { type: "set_model", provider, modelId });
      this.model = m ?? this.model;
      await this.refreshModels();
      await this.refreshState();
      this.saveChoice();
      this.cb.onStateChange(this);
    });
  }

  setThinking(level: string) {
    return this.settle(async () => {
      await api.pi(this.handle, { type: "set_thinking_level", level });
      this.thinkingLevel = level;
      this.saveChoice();
      this.cb.onStateChange(this);
    });
  }

  /**
   * Choose a preset (id, null/"" = an individual choice): model and thinking level of the preset go to Pi, and the
   * choice is kept for this session (see `saveChoice`).
   */
  async setPreset(id: string | null) {
    const { preset, model, thinking } = resolveChoice(state.config.presets ?? [], { preset: id ?? "" });
    if (this.detached || !this.handle) {
      // no process to ask: the choice goes with the next run in the background
      if (model) this.model = { provider: model.provider, id: model.id, name: model.id };
      if (thinking) this.thinkingLevel = thinking;
    } else {
      if (model) await this.setModel(model.provider, model.id); // clears the preset, set again below
      if (thinking) await this.setThinking(thinking);
    }
    this.presetId = preset?.id ?? "";
    this.saveChoice();
    this.cb.onStateChange(this);
  }

  // ---------- The model chosen for this session ----------

  /**
   * Keep model, thinking level and preset of this session in the settings (SessionMeta). Pi takes the model from the
   * session file when it opens it – the one used back then, and in a session without messages Pi's default. A session
   * therefore stays with the model it was started with until another one is chosen.
   */
  saveChoice() {
    const all = (state.config.sessionMeta ??= {});
    const key = this.key;
    const m = (all[key] ??= {});
    if (this.model) m.model = `${this.model.provider}/${this.model.id}`;
    else delete m.model;
    if (this.thinkingLevel) m.thinking = this.thinkingLevel;
    else delete m.thinking;
    if (this.presetId) m.preset = this.presetId;
    else delete m.preset;
    if (!Object.keys(m).length) delete all[key];
    saveConfig();
  }

  /** Apply the choice saved for this session again (after Pi loaded the session file), unless Pi already has it */
  async applyChoice() {
    const saved = state.config.sessionMeta?.[this.key];
    if (!saved?.model && !saved?.thinking && !saved?.preset) return;
    const { preset, model, thinking } = resolveChoice(state.config.presets ?? [], saved);
    try {
      if (model && (this.model?.provider !== model.provider || this.model?.id !== model.id))
        await this.setModel(model.provider, model.id);
      if (thinking && this.thinkingLevel !== thinking) await this.setThinking(thinking);
      this.presetId = preset?.id ?? "";
      this.saveChoice();
    } catch (e) {
      toast(`${t("Model")}: ${errMsg(e)}`, "err");
    }
  }

  // ---------- Plan mode (src/shared/planMode.ts) ----------

  /**
   * Toggle between Plan (read-only tools plus a plan hint with each message) and Build (the session's own tools).
   * Pi gets its tools at start, so the session restarts; history, model and view stay. The choice is saved in
   * SessionMeta, so it survives a restart of PiBar.
   */
  async setPlanMode(on: boolean): Promise<void> {
    if (on === this.planMode) return;
    if (this.streaming || this.bg) {
      toast(t("Pi is still working – stop it first or wait."), "err");
      return;
    }
    if (on) {
      this.toolsetBeforePlan = this.toolset;
      this.toolset = [...PLAN_TOOLS];
    } else {
      this.toolset = this.toolsetBeforePlan;
      this.toolsetBeforePlan = null;
    }
    this.planMode = on;
    const all = (state.config.sessionMeta ??= {});
    const m = (all[this.key] ??= {});
    if (on) m.planMode = true;
    else delete m.planMode;
    if (!Object.keys(m).length) delete all[this.key];
    saveConfig();
    try {
      if (this.alive) await this.restart();
      toast(on ? t("Plan mode: Pi only reads and writes a plan.") : t("Build mode: Pi may change files again."));
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  // ---------- Context mode (Pi extension mode-guard, src/shared/contextMode.ts) ----------

  /** Is the extension loaded in this Pi process? It then offers the command "/mode" */
  contextAvailable(): boolean {
    return this.commands.some((c) => c.name === "mode");
  }

  /** Prompt text as a command; false if Pi sent it to the model instead of handling it */
  private async extensionCommand(text: string): Promise<boolean> {
    const r = await api.pi(this.handle, { type: "prompt", message: text });
    return r?.disposition === "handled";
  }

  /**
   * Keep mode and stripped sections with the session, so opening it again restores them. A session that ends up with
   * the mode it starts with (project or settings, see `startContextMode`) drops its own choice and follows that again.
   */
  private saveContext() {
    const all = (state.config.sessionMeta ??= {});
    const key = this.key;
    const m = (all[key] ??= {});
    if (isContextMode(this.contextMode) && this.contextMode !== this.startContextMode())
      m.contextMode = this.contextMode;
    else delete m.contextMode;
    if (this.contextStripped.length) m.contextStripped = [...this.contextStripped];
    else delete m.contextStripped;
    if (!Object.keys(m).length) delete all[key];
    saveConfig();
  }

  /**
   * Mode this session starts with when it has none of its own: that of its project, else the setting
   * (`ui.defaultMode`); "" = the extension decides.
   */
  startContextMode(): ContextMode {
    const own = projectAt(state.config.projects ?? [], this.hostId, this.cwd)?.contextMode;
    return startContextMode(own, state.config.ui.defaultMode);
  }

  /**
   * Apply the mode and sections saved for this session (a fresh Pi process starts with Pi's default). A session
   * without an own mode follows its project or PiBar's default (`ui.defaultMode`, see `startContextMode`). If the
   * extension is not loaded yet, the push is retried once its command appears (see `refreshModels`).
   */
  async applyContext() {
    const saved = state.config.sessionMeta?.[this.key];
    const mode: ContextMode = saved?.contextMode || this.startContextMode();
    const stripped = saved?.contextStripped ?? [];
    if (!mode && !stripped.length) return;
    if (!this.contextAvailable()) {
      this.contextPending = true;
      this.scheduleContextRetry();
      return;
    }
    this.contextPending = false;
    try {
      if (mode && (await this.extensionCommand(contextModeCommand(mode)))) this.contextMode = mode;
      this.contextApplied = true;
      if (stripped.length) {
        const stripped_ = new Set(stripped);
        // name every section: only that way a section the user brought back stays in
        for (const name of CONTEXT_SECTIONS)
          await this.extensionCommand(contextSectionCommand(name, !stripped_.has(name)));
        this.contextStripped = [...stripped_];
      }
      this.cb.onStateChange(this);
    } catch {
      /* the extension may be gone; the next status tells the truth */
    }
  }

  /** A pending mode waits for the extension to register; try again shortly, the command list may still be loading */
  private scheduleContextRetry() {
    if (this.contextTimer !== undefined) return;
    this.contextTimer = window.setTimeout(() => {
      this.contextTimer = undefined;
      if (this.contextPending && this.alive) void this.applyContext();
    }, 1500);
  }

  /** Switch private/public for this session (needs the mode-guard extension) */
  async setContextMode(mode: "private" | "public") {
    if (!this.alive || this.detached) return toast(t("The context mode needs a live session."), "err");
    try {
      if (!(await this.extensionCommand(contextModeCommand(mode))))
        throw new Error(t("Pi did not handle it as a command."));
      this.contextMode = mode;
      this.contextApplied = true;
      this.saveContext();
      this.cb.onStateChange(this);
    } catch (e) {
      toast(`${t("Context mode")}: ${errMsg(e)}`, "err");
    }
  }

  /** Take one section out of public mode or bring it back in */
  async setContextSection(name: string, keep: boolean) {
    if (!this.alive || this.detached) return toast(t("The context mode needs a live session."), "err");
    try {
      if (!(await this.extensionCommand(contextSectionCommand(name, keep))))
        throw new Error(t("Pi did not handle it as a command."));
      const stripped = new Set(this.contextStripped);
      if (keep) stripped.delete(name);
      else stripped.add(name);
      this.contextStripped = [...stripped];
      this.saveContext();
      this.cb.onStateChange(this);
    } catch (e) {
      toast(`${t("Context mode")}: ${errMsg(e)}`, "err");
    }
  }

  /** Pi lists the sections it sends right now (arrives as a notice, src/main/answerDialog.ts) */
  showContextSections() {
    if (!this.alive || this.detached) return toast(t("The context mode needs a live session."), "err");
    this.extensionCommand(CONTEXT_SECTIONS_COMMAND).catch((e) => toast(`${t("Context mode")}: ${errMsg(e)}`, "err"));
  }

  // ---------- Temperature (Pi extension pibar-temperature, src/shared/temperature.ts) ----------

  /** Is the extension loaded in this Pi process? It then offers the command "/temperature" */
  tempAvailable(): boolean {
    return this.commands.some((c) => c.name === "temperature");
  }

  /** Keep the temperature with the session, so opening it again restores it (null = the model's default) */
  private saveTemperature() {
    const all = (state.config.sessionMeta ??= {});
    const m = (all[this.key] ??= {});
    if (this.temperature !== null) m.temperature = this.temperature;
    else delete m.temperature;
    if (!Object.keys(m).length) delete all[this.key];
    saveConfig();
  }

  /**
   * Apply the temperature saved for this session (a fresh Pi process starts with the model's default). If the
   * extension is not loaded yet, the push is retried once its command appears (see `refreshModels`).
   */
  async applyTemperature() {
    const saved = state.config.sessionMeta?.[this.key]?.temperature;
    this.temperature = isTemp(saved) ? saved : null;
    if (this.temperature === null) return;
    if (!this.tempAvailable()) {
      this.tempPending = true;
      this.scheduleTempRetry();
      return;
    }
    this.tempPending = false;
    try {
      if (await this.extensionCommand(temperatureCommand(this.temperature))) this.tempApplied = true;
      this.cb.onStateChange(this);
    } catch {
      /* the extension may be gone; the next status tells the truth */
    }
  }

  /** A pending temperature waits for the extension to register; try again shortly */
  private scheduleTempRetry() {
    if (this.tempTimer !== undefined) return;
    this.tempTimer = window.setTimeout(() => {
      this.tempTimer = undefined;
      if (this.tempPending && this.alive) void this.applyTemperature();
    }, 1500);
  }

  /** Set the temperature for this session (null = the model's default); needs the pibar-temperature extension */
  async setTemperature(v: number | null) {
    const value = v === null ? null : clampTemp(v);
    if (this.detached || !this.handle) {
      // no process to ask: the value goes with the next run in the background
      this.temperature = value;
      this.saveTemperature();
      this.cb.onStateChange(this);
      return;
    }
    try {
      if (!(await this.extensionCommand(temperatureCommand(value))))
        throw new Error(t("Pi did not handle it as a command."));
      this.temperature = value;
      this.tempApplied = true;
      this.saveTemperature();
      this.cb.onStateChange(this);
    } catch (e) {
      toast(`${t("Temperature")}: ${errMsg(e)}`, "err");
    }
  }

  /**
   * A model or thinking level changed inside Pi itself (Pi's own /model or /thinking command, a fallback): take it
   * over as the session's choice – otherwise opening the session again would undo it. Sessions without a saved choice
   * are left alone; they keep following Pi.
   */
  adoptChoice() {
    const saved = state.config.sessionMeta?.[this.key];
    if (!saved?.model && !saved?.thinking) return;
    const model = this.model ? `${this.model.provider}/${this.model.id}` : "";
    const changed =
      (!!model && model !== saved.model) || (!!this.thinkingLevel && this.thinkingLevel !== saved.thinking);
    if (!changed) return;
    this.presetId = ""; // the preset no longer describes what Pi runs
    this.saveChoice();
  }

  // ---------- History ----------

  async loadHistory() {
    const data = await api.pi(this.handle, { type: "get_messages" });
    const list = data.messages ?? [];
    for (const m of list) this.renderStored(m);
    this.flush();
    // subagent rows of the list come from the stored calls too, not only from live events
    if (this.subagentCalls.size > 0) this.cb.onStateChange(this);
    // an open choice question only if the session ends with that answer
    this.questions = list[list.length - 1]?.role === "assistant" ? findQuestions(this.lastText) : [];
  }

  private renderStored(m: PiMessage) {
    switch (m.role) {
      case "user":
        this.userBubble(m.content, m.timestamp);
        break;
      case "assistant": {
        this.beginAssistant();
        (m.content ?? []).forEach((c, i) => {
          if (c.type === "text") this.appendPart(i, "text", c.text ?? "");
          else if (c.type === "thinking") this.appendPart(i, "thinking", c.thinking ?? "");
          else if (c.type === "toolCall") {
            this.toolStart(i, c.id, c.name);
            this.toolArgs(c.id, c.arguments);
            this.setToolStatus(c.id, "ok", t("done"));
            // subagent calls of the history appear as rows under the session again (live: tool_execution_start)
            if (c.name === "subagent") {
              const call = subagentFromArgs(c.arguments);
              if (call) this.subagentCalls.set(c.id, call);
            }
          }
        });
        this.endAssistant(m);
        break;
      }
      case "toolResult":
        this.toolResult(m.toolCallId, m.content, !!m.isError);
        this.trackSubagent(m.toolCallId, m.details, true, !!m.isError);
        break;
      default:
        break;
    }
  }

  // ---------- Live events ----------

  onEvent(ev: PiEvent) {
    switch (ev.type) {
      case "agent_start":
      case "turn_start":
        this.reqStart = performance.now();
        this.firstToken = 0;
        if (ev.type === "turn_start") break;
        this.cb.onAnswerStart(this);
        this.lastText = "";
        this.failed = false;
        this.unseen = false;
        this.streaming = true;
        this.cb.onStateChange(this);
        break;
      case "agent_settled":
        if (this.bg) {
          this.bgSettled = true;
          void this.finishBackground("");
          break;
        }
        this.streaming = false;
        this.activity = "";
        this.questions = findQuestions(this.lastText);
        this.autoRead();
        this.flush();
        this.cb.onSettled(this);
        break;
      case "message_start":
        if (ev.message?.role === "user") this.userBubble(ev.message.content, ev.message.timestamp ?? Date.now());
        else if (ev.message?.role === "assistant") this.beginAssistant();
        break;
      case "message_update": {
        const a = ev.assistantMessageEvent;
        if (!this.cur) this.beginAssistant();
        if (!a) break;
        if (!this.firstToken && /_(delta|start)$/.test(a.type ?? "")) this.firstToken = performance.now();
        if (a.type === "text_delta") this.appendPart(a.contentIndex, "text", a.delta);
        else if (a.type === "thinking_delta") this.appendPart(a.contentIndex, "thinking", a.delta);
        else if (a.type === "toolcall_start") this.toolStart(a.contentIndex, a.id, a.toolName);
        else if (a.type === "toolcall_delta") this.toolArgsDelta(a.contentIndex, a.delta);
        else if (a.type === "toolcall_end" && a.toolCall) this.toolArgs(a.toolCall.id, a.toolCall.arguments);
        break;
      }
      case "message_end":
        if (ev.message?.role === "assistant") {
          this.measure(ev.message);
          this.endAssistant(ev.message);
          void this.refreshStats();
        }
        break;
      case "tool_execution_start":
        if (!this.tools.has(ev.toolCallId)) {
          this.beginAssistant();
          this.toolStart(999, ev.toolCallId, ev.toolName ?? "Tool");
          this.toolArgs(ev.toolCallId, ev.args);
        }
        if (ev.toolName === "subagent") {
          const call = subagentFromArgs(ev.args);
          if (call) this.subagentCalls.set(ev.toolCallId, call);
        }
        this.setToolStatus(ev.toolCallId, "run", t("running …"));
        this.activity = ev.toolName || "Tool";
        this.cb.onStateChange(this);
        break;
      case "tool_execution_update":
        // partial output of a running tool, shown live in the debug view
        if (this.debug()) this.toolResult(ev.toolCallId, ev.partialResult?.content, false, undefined, true);
        this.trackSubagent(ev.toolCallId, ev.partialResult?.details, false, false);
        break;
      case "tool_execution_end":
        this.toolResult(ev.toolCallId, ev.result?.content, !!ev.isError, ev.durationMs);
        this.trackSubagent(ev.toolCallId, ev.result?.details, true, !!ev.isError);
        this.activity = "";
        this.reqStart = performance.now(); // the next model call starts now
        this.firstToken = 0;
        this.cb.onStateChange(this);
        break;
      case "extension_ui_request":
        // the temperature extension reports its value as a footer status (see shared/temperature.ts)
        if (ev.method === "setStatus" && ev.statusKey === "pibar-temperature") {
          const v = parseTemperatureStatus(ev.statusText);
          if (v === undefined) break;
          const changed = v !== this.temperature;
          // the first status of a start reports the default before the saved value is pushed: it must not
          // overwrite the saved choice
          const first = !this.tempStatusSeen;
          this.tempStatusSeen = true;
          this.temperature = v;
          // a value switched inside Pi (its own /temperature command) stays the session's choice
          if (!first && this.tempApplied && changed) this.saveTemperature();
          this.cb.onStateChange(this);
          break;
        }
        // the mode-guard extension reports its context mode as a footer status (see shared/contextMode.ts)
        if (ev.method === "setStatus" && ev.statusKey === "mode-guard") {
          const st = parseContextStatus(ev.statusText);
          const changed = st.mode !== this.contextMode;
          // the first status of a start reports the extension's default (private) before the saved mode is pushed:
          // it must not overwrite the saved choice
          const first = !this.contextStatusSeen;
          this.contextStatusSeen = true;
          this.contextMode = st.mode;
          // only the public status names the sections; private keeps the choice already known
          if (st.mode === "public") this.contextStripped = st.stripped;
          // a mode switched inside Pi (its own /mode command) stays the session's choice
          if (!first && this.contextApplied && changed) this.saveContext();
          this.cb.onStateChange(this);
          break;
        }
        this.cb.onUiRequest(this, ev);
        break;
      case "queue_update":
        this.queue = { steering: ev.steering ?? [], followUp: ev.followUp ?? [] };
        for (const k of this.queuedImages.keys())
          if (!this.queue.steering.includes(k) && !this.queue.followUp.includes(k)) this.queuedImages.delete(k);
        this.cb.onStateChange(this);
        break;
      default:
        break;
    }
  }

  /** Diagnosis for an error of this session (model, error text, Pi's stderr) */
  diagnose(error: string) {
    diagnoseDialog(this.hostId, {
      provider: this.model?.provider,
      model: this.model?.id,
      error,
      handle: this.alive ? this.handle : undefined,
    });
  }

  onExit(stderr: string) {
    if (this.bg) {
      void this.finishBackground(stderr);
      return;
    }
    this.el.querySelectorAll(".msg.note.loading").forEach((n) => n.remove());
    this.alive = false;
    this.streaming = false;
    this.queue = { steering: [], followUp: [] };
    const box = h(
      "div",
      { class: "error" },
      t("Pi has stopped."),
      stderr.trim() ? `\n\n${stderr.trim().slice(-1500)}` : "",
      h(
        "div",
        {},
        h(
          "button",
          { class: "ghost", onclick: () => this.restart().catch((e) => toast(errMsg(e), "err")) },
          t("Reconnect"),
        ),
        h(
          "button",
          { class: "ghost", onclick: () => this.diagnose(stderr.trim() || t("Pi has stopped.")) },
          t("Diagnose"),
        ),
      ),
    );
    this.el.append(h("div", { class: "msg" }, box));
    this.cb.onStateChange(this);
  }

  // ---------- Rendering ----------

  private note(text: string) {
    this.el.append(h("div", { class: "msg note loading" }, text));
  }

  private userBubble(content: Content | undefined, ts?: number | string) {
    let text = "";
    const imgs: HTMLElement[] = [];
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .map((c) => (c.type === "text" ? (c.text ?? "") : null))
        .filter((x): x is string => x !== null)
        .join("\n");
      for (const c of content) {
        if (c.type === "image" && c.data) {
          const src = `data:${c.mimeType || "image/png"};base64,${c.data}`;
          imgs.push(h("img", { class: "msg-img", src, onclick: () => window.open(src) }));
        }
      }
    }
    this.cur = null;
    text = stripPlanMode(stripAnswerStyle(text));
    // Screen text (OCR) as a collapsible card instead of a long text
    let ocrCard: HTMLElement | null = null;
    const split = splitScreenText(text);
    if (split.ocr !== null) {
      text = split.text;
      const ocr = split.ocr;
      ocrCard = h(
        "details",
        { class: "card ocr-card" },
        h(
          "summary",
          {},
          h("span", { class: "label" }, t("Screen text")),
          h("span", { class: "preview" }, t("{n} characters via OCR", { n: ocr.length })),
        ),
        h("div", { class: "body" }, h("pre", {}, ocr)),
      );
    }
    // folders and files put into the context: small chips
    const csplit = splitContext(text);
    text = csplit.text;
    const ctxChips = csplit.paths.length
      ? h(
          "div",
          { class: "ctx-chips" },
          ...csplit.paths.map((p) =>
            h(
              "span",
              { class: "chip chip-ctx", title: p.path },
              icon(p.kind === "folder" ? "folder" : "file", 12, "chip-icon"),
              h("span", { class: "chip-name" }, baseName(p.path)),
            ),
          ),
        )
      : null;
    // attached text files as collapsible cards
    const fsplit = splitFiles(text);
    text = fsplit.text;
    const fileCards = fsplit.files.map((f) =>
      h(
        "details",
        { class: "card ocr-card" },
        h(
          "summary",
          {},
          h("span", { class: "label" }, f.name),
          h("span", { class: "preview" }, t("{n} characters", { n: f.text.length })),
        ),
        h("div", { class: "body" }, h("pre", {}, f.text)),
      ),
    );
    const index = this.userCount++;
    this.userTexts[index] = text;
    const bubble = h("div", { class: "bubble" }, ...imgs, text, ctxChips, ocrCard, ...fileCards);
    const panel = h("div", { class: "branch-panel", hidden: true });
    const act = (name: IconName, title: string, fn: () => void) => {
      const b = h("button", { class: "msg-act", title, "aria-label": title, onclick: fn });
      b.append(icon(name, 13));
      return b;
    };
    const acts = h(
      "div",
      { class: "msg-acts user-acts" },
      timeLabel(ts, true),
      act("edit", t("Edit and resend (new branch from here)"), () =>
        this.branchPanel(panel, acts, index, text, "edit"),
      ),
      act("redo", t("Run again from here (new branch)"), () => this.branchPanel(panel, acts, index, text, "rerun")),
      act("undo", t("Go back to here (later messages are removed from this view)"), () =>
        this.branchPanel(panel, acts, index, text, "rewind"),
      ),
      act("insert", t("Use as new message"), () => this.cb.onUserAction(this, index, "reuse", text)),
      act("copy", t("Copy"), () => this.cb.onUserAction(this, index, "copy", text)),
    );
    this.el.append(
      h("div", { class: "msg user", "data-user-index": String(index) }, bubble, timeLabel(ts), panel, acts),
    );
  }

  // ---------- Versions of a message (branches, src/main/branchNav.ts) ----------

  /** Texts of the own messages shown (⌘↑ takes the last one back into the input) */
  private userTexts: string[] = [];

  lastUserText(): string {
    return this.userTexts[this.userTexts.length - 1] ?? "";
  }

  /** Number of own messages shown in this chat */
  get userMessages(): number {
    return this.userCount;
  }

  /**
   * "‹ 2/3 ›" under own messages that exist in other versions (branches). `versions`: position among Pi's fork points →
   * versions; `offset`: fork points not shown in the chat (e.g. compacted away). `pick` switches to a version.
   */
  showBranches(
    versions: Map<number, BranchChoice[]>,
    offset: number,
    pick: (choice: BranchChoice, index: number) => void,
  ) {
    this.el.querySelectorAll(".branch-nav").forEach((n) => n.remove());
    for (const [k, list] of versions) {
      const index = k - offset;
      const msg = this.el.querySelector<HTMLElement>(`.msg.user[data-user-index="${index}"]`);
      const cur = list.findIndex((c) => c.current);
      if (!msg || cur < 0) continue;
      const go = (to: number) => () => list[to] && pick(list[to], index);
      const tip = list.map((c, i) => `${i + 1}. ${c.current ? "▸ " : ""}${c.text}`).join("\n");
      const nav = h(
        "div",
        { class: "branch-nav", title: `${t("Versions of this message")}\n${tip}` },
        h("button", { class: "msg-act", disabled: cur === 0, title: t("Previous version"), onclick: go(cur - 1) }, "‹"),
        h("span", { class: "branch-count" }, `${cur + 1}/${list.length}`),
        h(
          "button",
          {
            class: "msg-act",
            disabled: cur === list.length - 1,
            title: t("Next version"),
            onclick: go(cur + 1),
          },
          "›",
        ),
      );
      msg.querySelector(".bubble")?.after(nav);
    }
  }

  /** Bring an own message into view (after switching to another version of it) */
  scrollToUser(index: number) {
    const msg = this.el.querySelector<HTMLElement>(`.msg.user[data-user-index="${index}"]`);
    if (!msg) return;
    msg.scrollIntoView({ block: "center" });
    msg.classList.add("flash");
    setTimeout(() => msg.classList.remove("flash"), 1200);
  }

  /** Show the tool card of a subagent call in the chat (a click on its row in the list, src/main/subagents.ts) */
  scrollToTool(toolCallId: string) {
    const card = this.tools.get(toolCallId)?.card;
    if (!card) return;
    card.open = true;
    card.scrollIntoView({ block: "center" });
    card.classList.add("flash");
    setTimeout(() => card.classList.remove("flash"), 1200);
  }

  /**
   * Keep the runs of a subagent tool call up to date (shared/subagents.ts). The details of the extension replace
   * the runs; without details (older version) the end marks them done. The list re-renders only when something
   * changed, so the stream of updates does not redraw it on every token.
   */
  private trackSubagent(toolCallId: string, details: unknown, done: boolean, isError: boolean) {
    const call = this.subagentCalls.get(toolCallId);
    if (!call) return;
    const before = JSON.stringify(call);
    const parsed = subagentFromDetails(details);
    if (parsed) {
      call.mode = parsed.mode;
      call.runs = parsed.runs;
      call.isError = parsed.isError;
    }
    if (done) {
      call.done = true;
      call.isError = call.isError || isError;
      for (const r of call.runs) {
        if (r.status === "pending" || r.status === "running") r.status = isError ? "failed" : "completed";
      }
    }
    if (JSON.stringify(call) !== before) this.cb.onStateChange(this);
  }

  /**
   * Inline panel under an own message: edit the text (or just confirm "run again"), then branch – or cancel
   * (button or Esc) and nothing changes. The fork only happens on "send".
   */
  private branchPanel(
    panel: HTMLElement,
    acts: HTMLElement,
    index: number,
    text: string,
    mode: "edit" | "rerun" | "rewind",
  ) {
    const editable = mode === "edit";
    const close = () => {
      panel.hidden = true;
      panel.replaceChildren();
      acts.hidden = false;
    };
    const area = editable
      ? (h("textarea", {
          class: "branch-text",
          rows: Math.min(10, text.split("\n").length + 1),
        }) as HTMLTextAreaElement)
      : null;
    if (area) area.value = text;
    const go = () => {
      const msg = area ? area.value.trim() : text;
      if (!msg) return;
      close();
      this.cb.onUserAction(this, index, mode, text, msg);
    };
    area?.addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        close();
      } else if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        go();
      }
    });
    panel.replaceChildren(
      area ??
        h(
          "div",
          { class: "branch-q" },
          mode === "rewind"
            ? t("Go back to the state after this message and its answer?")
            : t("Run this message again from here?"),
        ),
      h(
        "div",
        { class: "branch-bar" },
        h("span", { class: "branch-hint" }, t("Creates a new branch; the original session stays unchanged.")),
        h("button", { class: "ghost small", type: "button", onclick: close }, t("Cancel")),
        h(
          "button",
          { class: "primary small", type: "button", onclick: go },
          editable ? t("Send as new branch") : mode === "rewind" ? t("Go back") : t("Run again"),
        ),
      ),
    );
    panel.hidden = false;
    acts.hidden = true;
    if (area) {
      area.focus();
      area.setSelectionRange(area.value.length, area.value.length);
    } else panel.querySelector<HTMLButtonElement>(".primary")?.focus();
  }

  private beginAssistant() {
    if (this.cur) return;
    // "technical" until visible text arrives: the natural view hides such messages completely (tool calls only)
    const el = h("div", { class: "msg assistant technical" });
    this.el.append(el);
    this.cur = { el, parts: new Map() };
  }

  private endAssistant(msg?: AssistantMessage) {
    if (!this.cur) this.beginAssistant();
    const cur = this.cur!;
    if (msg?.usage) this.addUsage(msg.usage);
    if (msg?.stopReason === "error" || msg?.errorMessage || msg?.stopReason === "aborted")
      cur.el.classList.remove("technical"); // errors and "aborted" stay visible in every view
    if (msg?.stopReason === "error" || msg?.errorMessage) {
      if (this.streaming) this.failed = true;
      const error = msg.errorMessage || t("Error in the response");
      // Pi was updated or removed on the host while this process was running: only a new process helps
      const stale = isStaleInstallError(error);
      cur.el.append(
        h(
          "div",
          { class: "part" },
          h(
            "div",
            { class: "error" },
            error,
            stale
              ? h(
                  "div",
                  { class: "error-hint" },
                  t(
                    "Pi was updated or removed on the host while this session was running. Restart the session; the history stays.",
                  ),
                )
              : null,
            h(
              "div",
              { class: "error-acts" },
              stale
                ? h(
                    "button",
                    { class: "ghost small", onclick: () => this.restart().catch((e) => toast(errMsg(e), "err")) },
                    t("Restart session"),
                  )
                : null,
              h("button", { class: "ghost small", onclick: () => this.diagnose(error) }, t("Diagnose")),
            ),
          ),
        ),
      );
    } else if (msg?.stopReason === "aborted") {
      cur.el.append(h("div", { class: "part msg note" }, t("Aborted.")));
    }
    this.flush();
    cur.el.querySelectorAll(".cursor").forEach((c) => c.classList.remove("cursor"));
    const text = [...cur.parts.values()]
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
    // the model that actually answered (shown with the actions, on hover)
    const used = msg?.model
      ? h("span", { class: "msg-model", title: `${msg.provider ?? ""}/${msg.model}` }, shortModel(msg.model))
      : null;
    let btn: HTMLElement | null = null;
    let copy: HTMLElement | null = null;
    if (text) {
      this.lastText = text;
      const b: HTMLElement = h("button", {
        class: "msg-act",
        title: t("Read aloud"),
        onclick: () => readAloud(text, b),
      });
      b.innerHTML = ICON_SPEAK;
      btn = b;
      // copy the answer as Markdown source, not the rendered text of the bubbles
      const c: HTMLElement = h("button", { class: "msg-act", title: t("Copy answer") });
      c.innerHTML = ICON_COPY;
      c.addEventListener("click", () =>
        copyText(text).then(
          () => toast(t("Answer copied")),
          (e) => toast(errMsg(e), "err"),
        ),
      );
      copy = c;
    }
    const ts = msg?.timestamp ?? (this.streaming ? Date.now() : undefined);
    const time = timeLabel(ts);
    if (time) cur.el.append(time);
    const hoverTime = timeLabel(ts, true);
    if (btn || copy || used || hoverTime) cur.el.append(h("div", { class: "msg-acts" }, hoverTime, used, copy, btn));
    this.cur = null;
  }

  /** Settings → Voice → "Read answers aloud" */
  private autoRead() {
    const mode = state.config.voice?.tts.autoRead ?? "off";
    const read = mode === "all" || (mode === "quick" && this.readNext);
    this.readNext = false;
    if (read && this.lastText) readAloud(this.lastText);
  }

  private getPart(index: number, kind: PartKind): Part {
    if (!this.cur) this.beginAssistant();
    const cur = this.cur!;
    let p = cur.parts.get(index);
    if (p && p.kind === kind) return p;
    let el: HTMLElement;
    let body: HTMLElement;
    if (kind === "thinking") {
      body = h("div", { class: "body thinking-body md" });
      el = h(
        "div",
        { class: "part thinking" },
        h(
          "details",
          { class: "card", open: this.debug() },
          h("summary", {}, h("span", { class: "label" }, t("Thinking")), h("span", { class: "preview" }, "")),
          body,
        ),
      );
    } else {
      body = h("div", { class: "md cursor" });
      el = h("div", { class: "part text" }, body);
    }
    cur.el.append(el);
    p = { kind, el, body, text: "", dirty: false };
    cur.parts.set(index, p);
    return p;
  }

  private appendPart(index: number, kind: PartKind, delta: string) {
    const p = this.getPart(index, kind);
    p.text += delta;
    p.dirty = true;
    if (kind === "text" && p.text.trim()) this.cur?.el.classList.remove("technical");
    this.schedule();
  }

  private schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => {
      this.raf = 0;
      this.flush();
    });
  }

  /** Re-render changed text parts as Markdown */
  private flush() {
    for (const part of this.allParts()) {
      if (!part.dirty) continue;
      part.dirty = false;
      renderMarkdown(part.body, part.text);
      if (part.kind === "thinking") {
        const prev = part.el.querySelector(".preview");
        if (prev) prev.textContent = part.text.replace(/\s+/g, " ").slice(0, 120);
      }
    }
  }

  private *allParts(): Generator<Part> {
    if (this.cur) yield* this.cur.parts.values();
  }

  private toolStart(index: number, id: string, name: string) {
    if (!this.cur) this.beginAssistant();
    if (this.tools.has(id)) return;
    const preview = h("span", { class: "preview" }, "");
    const status = h("span", { class: "status" }, "");
    const args = h("pre", {}, "");
    const result = h("div", {});
    const card = h(
      "details",
      { class: "card", open: this.debug() },
      h("summary", {}, h("span", { class: "label" }, name || "Tool"), preview, status),
      h("div", { class: "body" }, h("div", { class: "sub" }, t("Input")), args, result),
    ) as HTMLDetailsElement;
    this.cur!.el.append(h("div", { class: "part tool", "data-index": index }, card));
    this.tools.set(id, { card, preview, status, args, result, argsRaw: "", name });
    this.lastToolByIndex.set(index, id);
  }
  private lastToolByIndex = new Map<number, string>();

  private toolArgsDelta(index: number, delta: string) {
    const id = this.lastToolByIndex.get(index);
    const card = id ? this.tools.get(id) : undefined;
    if (!card) return;
    card.argsRaw += delta;
    card.args.textContent = card.argsRaw;
    if (this.debug()) this.schedule();
  }

  /** Files Pi changed in this session (paths as Pi got them: absolute, "~/…" or relative to the working folder) */
  readonly touched = new Set<string>();

  private toolArgs(id: string, args?: ToolArgs) {
    const card = this.tools.get(id);
    if (!card) return;
    const path = args?.path ?? args?.file_path;
    if (card.name && FILE_TOOLS.has(card.name) && typeof path === "string" && path) this.touched.add(path);
    card.args.textContent = JSON.stringify(args ?? {}, null, 2);
    card.preview.textContent = argPreview(args);
  }

  private setToolStatus(id: string, kind: "run" | "ok" | "err", text: string) {
    const card = this.tools.get(id);
    if (!card) return;
    card.status.className = `status ${kind}`;
    card.status.textContent = text;
  }

  private toolResult(id: string, content: Content | undefined, isError: boolean, durationMs?: number, partial = false) {
    const card = this.tools.get(id);
    if (!card) return;
    let text = "";
    if (Array.isArray(content))
      text = content.map((c) => (c.type === "text" ? (c.text ?? "") : `[${c.type}]`)).join("\n");
    else if (typeof content === "string") text = content;
    if (text.length > MAX_RESULT)
      text = text.slice(0, MAX_RESULT) + `\n… ${t("({n} characters truncated)", { n: text.length - MAX_RESULT })}`;
    card.result.replaceChildren(
      h("div", { class: "sub" }, isError ? t("Error") : t("Result")),
      h("pre", {}, text || t("(empty)")),
    );
    if (partial) return this.schedule();
    const dur = durationMs !== undefined ? ` · ${(durationMs / 1000).toFixed(1)} s` : "";
    this.setToolStatus(id, isError ? "err" : "ok", (isError ? t("Error") : t("done")) + dur);
    if (this.debug()) this.schedule();
  }

  private addUsage(u: Usage) {
    const s = this.stats;
    const input = u.input ?? 0;
    const output = u.output ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    const tokens = u.totalTokens ?? input + output + cacheRead + cacheWrite;
    const cost = typeof u.cost === "object" ? (u.cost?.total ?? 0) : (u.cost ?? 0);
    s.responses += 1;
    s.input += input;
    s.output += output;
    s.cacheRead += cacheRead;
    s.cacheWrite += cacheWrite;
    s.total += tokens || 0;
    s.cost += cost || 0;
    s.lastOutput = output;
    s.lastContext = input + cacheRead + cacheWrite + output;
    this.cb.onStateChange(this);
  }

  /** Speed of a live answer: output tokens from the first token to message_end */
  measure(msg?: AssistantMessage) {
    const output = msg?.usage?.output ?? 0;
    if (!this.firstToken || !output) return;
    const now = performance.now();
    const ms = now - this.firstToken;
    const s = this.stats;
    s.lastTps = tokensPerSecond(output, ms);
    s.lastTtft = this.reqStart ? this.firstToken - this.reqStart : null;
    s.genMs += ms;
    s.genTokens += output;
    this.firstToken = 0;
    this.reqStart = now;
  }
}

/**
 * Time of a message, full date as tooltip. `inline`: in the action row, shown on hover; otherwise its own line under
 * the message, shown when "always show times" is on (View menu or Settings → Chat).
 */
function timeLabel(ts: unknown, inline = false): HTMLElement | null {
  const n = typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : NaN;
  if (!Number.isFinite(n) || n <= 0) return null;
  return h(
    "time",
    {
      class: inline ? "msg-time-inline" : "msg-time",
      datetime: new Date(n).toISOString(),
      title: new Date(n).toLocaleString(getLang(), { dateStyle: "full", timeStyle: "medium" }),
    },
    msgTime(n),
  );
}

function argPreview(args?: ToolArgs): string {
  if (!args || typeof args !== "object") return "";
  const v = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? Object.values(args)[0];
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 140) : "";
}
