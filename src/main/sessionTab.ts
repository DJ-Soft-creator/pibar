// One open session: a Pi process (via the Rust core) plus the chat rendering of its events
import { api, PiCommand, PiModel } from "../shared/api";
import { h, renderMarkdown, errMsg, toast } from "../shared/dom";
import { splitScreenText, stripAnswerStyle, tokensPerSecond, withAnswerStyle } from "../shared/format";
import { getLang, t } from "../shared/i18n";
import { speak, stopSpeaking } from "../shared/voice";
import { icon, IconName } from "../shared/icons";
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
}

/** What to do with an earlier own message (buttons under a user bubble) */
export type UserAction = "edit" | "rerun" | "reuse" | "copy";

export interface TabCallbacks {
  onHandle: (tab: SessionTab) => void;
  onStateChange: (tab: SessionTab) => void;
  onSettled: (tab: SessionTab) => void;
  /**
   * Button under an own message; `index` = position among the user messages of this chat, `text` = the message as
   * sent, `edited` = new text for "edit"
   */
  onUserAction: (tab: SessionTab, index: number, action: UserAction, text: string, edited?: string) => void;
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
  /** Skills, prompt templates and extension commands (for the "/" menu) */
  commands: PiCommand[] = [];
  /** Name of the tool that is running right now ("" = none) */
  activity = "";
  /** Read the next answer aloud (message came from the quick bar) */
  readNext = false;
  /** Text of the last answer of the current run (for auto read) */
  private lastText = "";

  readonly el: HTMLElement;
  private cur: { el: HTMLElement; parts: Map<number, Part> } | null = null;
  private tools = new Map<string, ToolCard>();
  private raf = 0;
  private cb: TabCallbacks;
  /** Live timing: request start and first token of the current answer */
  private reqStart = 0;
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
    this.handle = await api.piOpen(this.hostId, this.cwd, this.sessionPath ?? undefined);
    this.alive = true;
    onHandle?.(this);
    await this.refreshState();
    if (this.sessionPath) await this.loadHistory();
    this.el.querySelectorAll(".msg.note.loading").forEach((n) => n.remove());
    await this.refreshModels();
    this.cb.onStateChange(this);
  }

  async restart() {
    if (this.alive) await api.piClose(this.handle).catch(() => {});
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
    const r = await api.pi(this.handle, { type: "fork", entryId });
    if (r?.cancelled) return null;
    const st = await api.pi(this.handle, { type: "get_state" });
    this.sessionPath = st.messageCount > 0 ? (st.sessionFile ?? null) : null;
    this.model = st.model ?? this.model;
    this.thinkingLevel = st.thinkingLevel ?? this.thinkingLevel;
    this.clearView();
    if (this.sessionPath) await this.loadHistory();
    this.cb.onStateChange(this);
    return r?.text ?? "";
  }

  /** Stop the Pi process. The session file stays and can be reopened. */
  close() {
    if (this.alive) api.piClose(this.handle).catch(() => {});
    this.alive = false;
    this.streaming = false;
  }

  async refreshState() {
    const st = await api.pi(this.handle, { type: "get_state" });
    this.model = st.model ?? null;
    this.thinkingLevel = st.thinkingLevel ?? "";
    this.streaming = !!st.isStreaming;
    if (st.sessionFile && st.messageCount > 0) this.sessionPath = st.sessionFile;
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
  sessionStats(): Promise<any> {
    return api.pi(this.handle, { type: "get_session_stats" });
  }

  // ---------- Actions ----------

  async send(text: string, images: { data: string; mimeType: string }[] = []) {
    const cmd: Record<string, unknown> = { type: "prompt", message: withAnswerStyle(text, state.config.ui.answerMode) };
    if (images.length) cmd.images = images.map((i) => ({ type: "image", data: i.data, mimeType: i.mimeType }));
    if (this.streaming) cmd.streamingBehavior = "steer";
    const res = await api.pi(this.handle, cmd);
    if (res?.disposition === "queued") this.note(t("Message queued – Pi will see it after the current step."));
  }

  async abort() {
    await api.pi(this.handle, { type: "abort" });
  }

  async setModel(provider: string, modelId: string) {
    const m = await api.pi(this.handle, { type: "set_model", provider, modelId });
    this.model = m ?? this.model;
    await this.refreshModels();
    await this.refreshState();
    this.cb.onStateChange(this);
  }

  async setThinking(level: string) {
    await api.pi(this.handle, { type: "set_thinking_level", level });
    this.thinkingLevel = level;
    this.cb.onStateChange(this);
  }

  // ---------- History ----------

  async loadHistory() {
    const data = await api.pi(this.handle, { type: "get_messages" });
    for (const m of data.messages ?? []) this.renderStored(m);
    this.flush();
  }

  private renderStored(m: any) {
    switch (m.role) {
      case "user":
        this.userBubble(m.content);
        break;
      case "assistant": {
        this.beginAssistant();
        (m.content ?? []).forEach((c: any, i: number) => {
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

  onEvent(ev: any) {
    switch (ev.type) {
      case "agent_start":
      case "turn_start":
        this.reqStart = performance.now();
        this.firstToken = 0;
        if (ev.type === "turn_start") break;
        this.lastText = "";
        this.streaming = true;
        this.cb.onStateChange(this);
        break;
      case "agent_settled":
        this.streaming = false;
        this.activity = "";
        this.autoRead();
        this.flush();
        this.cb.onSettled(this);
        break;
      case "message_start":
        if (ev.message?.role === "user") this.userBubble(ev.message.content);
        else if (ev.message?.role === "assistant") this.beginAssistant();
        break;
      case "message_update": {
        const a = ev.assistantMessageEvent ?? {};
        if (!this.cur) this.beginAssistant();
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
        }
        break;
      case "tool_execution_start":
        if (!this.tools.has(ev.toolCallId)) {
          this.beginAssistant();
          this.toolStart(999, ev.toolCallId, ev.toolName);
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
      default:
        break;
    }
  }

  onExit(stderr: string) {
    this.el.querySelectorAll(".msg.note.loading").forEach((n) => n.remove());
    this.alive = false;
    this.streaming = false;
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
      ),
    );
    this.el.append(h("div", { class: "msg" }, box));
    this.cb.onStateChange(this);
  }

  // ---------- Rendering ----------

  private note(text: string) {
    this.el.append(h("div", { class: "msg note loading" }, text));
  }

  private userBubble(content: any) {
    let text = "";
    const imgs: HTMLElement[] = [];
    if (typeof content === "string") text = content;
    else if (Array.isArray(content)) {
      text = content
        .filter((c: any) => c.type === "text")
        .map((c: any) => c.text)
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
    const index = this.userCount++;
    const bubble = h("div", { class: "bubble" }, ...imgs, text, ocrCard);
    const panel = h("div", { class: "branch-panel", hidden: true });
    const act = (name: IconName, title: string, fn: () => void) => {
      const b = h("button", { class: "msg-act", title, "aria-label": title, onclick: fn });
      b.append(icon(name, 13));
      return b;
    };
    const acts = h(
      "div",
      { class: "msg-acts user-acts" },
      act("edit", t("Edit and resend (new branch from here)"), () => this.branchPanel(panel, acts, index, text, true)),
      act("redo", t("Run again from here (new branch)"), () => this.branchPanel(panel, acts, index, text, false)),
      act("insert", t("Use as new message"), () => this.cb.onUserAction(this, index, "reuse", text)),
      act("copy", t("Copy"), () => this.cb.onUserAction(this, index, "copy", text)),
    );
    this.el.append(h("div", { class: "msg user" }, bubble, panel, acts));
  }

  /**
   * Inline panel under an own message: edit the text (or just confirm "run again"), then branch – or cancel
   * (button or Esc) and nothing changes. The fork only happens on "send".
   */
  private branchPanel(panel: HTMLElement, acts: HTMLElement, index: number, text: string, editable: boolean) {
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
      this.cb.onUserAction(this, index, editable ? "edit" : "rerun", text, msg);
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
      area ?? h("div", { class: "branch-q" }, t("Run this message again from here?")),
      h(
        "div",
        { class: "branch-bar" },
        h("span", { class: "branch-hint" }, t("Creates a new branch; the original session stays unchanged.")),
        h("button", { class: "ghost small", type: "button", onclick: close }, t("Cancel")),
        h(
          "button",
          { class: "primary small", type: "button", onclick: go },
          editable ? t("Send as new branch") : t("Run again"),
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
    const el = h("div", { class: "msg assistant" });
    this.el.append(el);
    this.cur = { el, parts: new Map() };
  }

  private endAssistant(msg: any) {
    if (!this.cur) this.beginAssistant();
    const cur = this.cur!;
    if (msg?.usage) this.addUsage(msg.usage);
    if (msg?.stopReason === "error" || msg?.errorMessage) {
      cur.el.append(
        h("div", { class: "part" }, h("div", { class: "error" }, msg.errorMessage || t("Error in the response"))),
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
    if (text) {
      this.lastText = text;
      const btn: HTMLElement = h("button", {
        class: "msg-act",
        title: t("Read aloud"),
        onclick: () => readAloud(text, btn),
      });
      btn.innerHTML = ICON_SPEAK;
      cur.el.append(h("div", { class: "msg-acts" }, btn));
    }
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
    this.tools.set(id, { card, preview, status, args, result, argsRaw: "" });
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

  private toolArgs(id: string, args: any) {
    const card = this.tools.get(id);
    if (!card) return;
    card.args.textContent = JSON.stringify(args ?? {}, null, 2);
    card.preview.textContent = argPreview(args);
  }

  private setToolStatus(id: string, kind: "run" | "ok" | "err", text: string) {
    const card = this.tools.get(id);
    if (!card) return;
    card.status.className = `status ${kind}`;
    card.status.textContent = text;
  }

  private toolResult(id: string, content: any, isError: boolean, durationMs?: number, partial = false) {
    const card = this.tools.get(id);
    if (!card) return;
    let text = "";
    if (Array.isArray(content)) text = content.map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`)).join("\n");
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

  private addUsage(u: any) {
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
  measure(msg: any) {
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

function argPreview(args: any): string {
  if (!args || typeof args !== "object") return "";
  const v = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? Object.values(args)[0];
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 140) : "";
}
