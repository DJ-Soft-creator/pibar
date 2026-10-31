// One open session: a Pi process (via the Rust core) plus the chat rendering of its events
import { api, PiModel } from "../shared/api";
import { h, renderMarkdown, errMsg, toast } from "../shared/dom";
import { splitScreenText } from "../shared/format";
import { t } from "../shared/i18n";

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

export interface TabCallbacks {
  onHandle: (tab: SessionTab) => void;
  onStateChange: (tab: SessionTab) => void;
  onSettled: (tab: SessionTab) => void;
}

const MAX_RESULT = 20000;

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
  usage: { tokens: number; cost: number } = { tokens: 0, cost: 0 };

  readonly el: HTMLElement;
  private cur: { el: HTMLElement; parts: Map<number, Part> } | null = null;
  private tools = new Map<string, ToolCard>();
  private raf = 0;
  private cb: TabCallbacks;

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
    this.el.innerHTML = "";
    this.tools.clear();
    this.cur = null;
    await this.start(this.cb.onHandle);
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
  }

  // ---------- Actions ----------

  async send(text: string, images: { data: string; mimeType: string }[] = []) {
    const cmd: Record<string, unknown> = { type: "prompt", message: text };
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
        this.streaming = true;
        this.cb.onStateChange(this);
        break;
      case "agent_settled":
        this.streaming = false;
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
        if (a.type === "text_delta") this.appendPart(a.contentIndex, "text", a.delta);
        else if (a.type === "thinking_delta") this.appendPart(a.contentIndex, "thinking", a.delta);
        else if (a.type === "toolcall_start") this.toolStart(a.contentIndex, a.id, a.toolName);
        else if (a.type === "toolcall_delta") this.toolArgsDelta(a.contentIndex, a.delta);
        else if (a.type === "toolcall_end" && a.toolCall) this.toolArgs(a.toolCall.id, a.toolCall.arguments);
        break;
      }
      case "message_end":
        if (ev.message?.role === "assistant") {
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
        break;
      case "tool_execution_end":
        this.toolResult(ev.toolCallId, ev.result?.content, !!ev.isError, ev.durationMs);
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
    this.el.append(h("div", { class: "msg user" }, h("div", { class: "bubble" }, ...imgs, text, ocrCard)));
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
    this.cur = null;
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
          { class: "card" },
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
      { class: "card" },
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

  private toolResult(id: string, content: any, isError: boolean, durationMs?: number) {
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
    const dur = durationMs !== undefined ? ` · ${(durationMs / 1000).toFixed(1)} s` : "";
    this.setToolStatus(id, isError ? "err" : "ok", (isError ? t("Error") : t("done")) + dur);
  }

  private addUsage(u: any) {
    const tokens = u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0);
    const cost = typeof u.cost === "object" ? (u.cost?.total ?? 0) : (u.cost ?? 0);
    this.usage = { tokens: this.usage.tokens + (tokens || 0), cost: this.usage.cost + (cost || 0) };
    this.cb.onStateChange(this);
  }
}

function argPreview(args: any): string {
  if (!args || typeof args !== "object") return "";
  const v = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.url ?? Object.values(args)[0];
  return typeof v === "string" ? v.replace(/\s+/g, " ").slice(0, 140) : "";
}
