// One open session: a Pi process (via the Rust core) plus the chat rendering of its events
import { api, PiCommand, PiModel } from "../shared/api";
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
import { h, renderMarkdown, errMsg, toast } from "../shared/dom";
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
import { speak, stopSpeaking } from "../shared/voice";
import { icon, IconName } from "../shared/icons";
import { diagnoseDialog } from "./diagnose";
import { state } from "./state";

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
}

type Image = { data: string; mimeType: string };
export type QueueWhen = "steer" | "followUp";
export interface QueueItem {
  text: string;
  when: QueueWhen;
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
  /** Dialog or notice from a Pi extension (Pi waits for dialogs to be answered) */
  onUiRequest: (tab: SessionTab, req: UiRequest) => void;
}

const MAX_RESULT = 20000;

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

/** Cards open live in the "debug" chat view */
function debugView(): boolean {
  return state.config?.ui.chatMode === "debug";
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
  /** Name of the tool that is running right now ("" = none) */
  activity = "";
  /** Read the next answer aloud (message came from the quick bar) */
  readNext = false;
  /** Name given in "New session", saved as own name once the session has a file */
  pendingName = "";
  /** Pi tools for this session (allowlist), null = Pi's default; applied when Pi starts */
  toolset: string[] | null = null;
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

  constructor(hostId: string, cwd: string, sessionPath: string | null, title: string, cb: TabCallbacks) {
    this.hostId = hostId;
    this.cwd = cwd;
    this.sessionPath = sessionPath;
    this.title = title;
    this.cb = cb;
    this.el = h("div", { class: "messages" });
  }

  get key(): string {
    return `${this.hostId}|${this.sessionPath ?? `new-${this.handle}`}`;
  }

  // ---------- Lifecycle ----------

  async start(onHandle?: (tab: SessionTab) => void) {
    this.note(this.sessionPath ? t("Loading session …") : t("Starting new session …"));
    this.handle = await api.piOpen(this.hostId, this.cwd, this.sessionPath ?? undefined, this.toolset);
    this.alive = true;
    onHandle?.(this);
    await this.refreshState();
    if (this.sessionPath) await this.loadHistory();
    this.el.querySelectorAll(".msg.note.loading").forEach((n) => n.remove());
    await this.refreshModels();
    this.cb.onStateChange(this);
  }

  async restart() {
    // also after Pi ended by itself: frees its entry in the Rust core
    if (this.handle) await api.piClose(this.handle).catch(() => {});
    this.clearView();
    await this.start(this.cb.onHandle);
  }

  private clearView() {
    this.el.innerHTML = "";
    this.stats = emptyStats();
    this.tools.clear();
    this.cur = null;
    this.userCount = 0;
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
    if (this.handle) api.piClose(this.handle).catch(() => {});
    this.alive = false;
    this.streaming = false;
  }

  /** Reload Pi's session statistics (status line under the input) */
  async refreshStats() {
    if (!this.alive) return;
    try {
      this.piStats = await api.pi(this.handle, { type: "get_session_stats" });
      this.cb.onStateChange(this);
    } catch {
      /* older Pi: the live counters stay */
    }
  }

  async refreshState() {
    void this.refreshStats();
    const st = await api.pi(this.handle, { type: "get_state" });
    this.model = st.model ?? null;
    this.thinkingLevel = st.thinkingLevel ?? "";
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
    this.questions = [];
    await this.settling.catch(() => {});
    const message = withAnswerStyle(text, state.config.ui.answerMode);
    const cmd: { type: "prompt"; [key: string]: unknown } = { type: "prompt", message };
    if (images.length) cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    if (this.streaming) {
      cmd.streamingBehavior = when;
      if (images.length) this.queuedImages.set(message, images);
    }
    await api.pi(this.handle, cmd);
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
    return this.settle(async () => {
      const m = await api.pi(this.handle, { type: "set_model", provider, modelId });
      this.model = m ?? this.model;
      await this.refreshModels();
      await this.refreshState();
      this.cb.onStateChange(this);
    });
  }

  setThinking(level: string) {
    return this.settle(async () => {
      await api.pi(this.handle, { type: "set_thinking_level", level });
      this.thinkingLevel = level;
      this.cb.onStateChange(this);
    });
  }

  // ---------- History ----------

  async loadHistory() {
    const data = await api.pi(this.handle, { type: "get_messages" });
    const list = data.messages ?? [];
    for (const m of list) this.renderStored(m);
    this.flush();
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
          }
        });
        this.endAssistant(m);
        break;
      }
      case "toolResult":
        this.toolResult(m.toolCallId, m.content, !!m.isError);
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
        this.lastText = "";
        this.failed = false;
        this.unseen = false;
        this.streaming = true;
        this.cb.onStateChange(this);
        break;
      case "agent_settled":
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
        this.setToolStatus(ev.toolCallId, "run", t("running …"));
        this.activity = ev.toolName || "Tool";
        this.cb.onStateChange(this);
        break;
      case "tool_execution_update":
        // partial output of a running tool, shown live in the debug view
        if (debugView()) this.toolResult(ev.toolCallId, ev.partialResult?.content, false, undefined, true);
        break;
      case "tool_execution_end":
        this.toolResult(ev.toolCallId, ev.result?.content, !!ev.isError, ev.durationMs);
        this.activity = "";
        this.reqStart = performance.now(); // the next model call starts now
        this.firstToken = 0;
        this.cb.onStateChange(this);
        break;
      case "extension_ui_request":
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
    text = stripAnswerStyle(text);
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
      cur.el.append(
        h(
          "div",
          { class: "part" },
          h(
            "div",
            { class: "error" },
            error,
            h(
              "div",
              { class: "error-acts" },
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
    if (text) {
      this.lastText = text;
      const b: HTMLElement = h("button", {
        class: "msg-act",
        title: t("Read aloud"),
        onclick: () => readAloud(text, b),
      });
      b.innerHTML = ICON_SPEAK;
      btn = b;
    }
    const ts = msg?.timestamp ?? (this.streaming ? Date.now() : undefined);
    const time = timeLabel(ts);
    if (time) cur.el.append(time);
    const hoverTime = timeLabel(ts, true);
    if (btn || used || hoverTime) cur.el.append(h("div", { class: "msg-acts" }, hoverTime, used, btn));
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
          { class: "card", open: debugView() },
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
    const scroller = this.el.parentElement;
    const atBottom = scroller ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80 : false;
    for (const part of this.allParts()) {
      if (!part.dirty) continue;
      part.dirty = false;
      renderMarkdown(part.body, part.text);
      if (part.kind === "thinking") {
        const prev = part.el.querySelector(".preview");
        if (prev) prev.textContent = part.text.replace(/\s+/g, " ").slice(0, 120);
      }
    }
    if (scroller && atBottom) scroller.scrollTop = scroller.scrollHeight;
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
      { class: "card", open: debugView() },
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
    if (debugView()) this.schedule();
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
    if (debugView()) this.schedule();
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
