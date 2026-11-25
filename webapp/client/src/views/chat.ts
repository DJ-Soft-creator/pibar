// Chat of one session (tasks E3/E4, mobile): joins or starts Pi on the host (pi_attach), shows the history
// (get_messages), follows the live events over the WebSocket (with replay after a reconnect, see server ws.ts) and
// sends messages. Thinking and tool calls are collapsible cards; Pi's dialogs (extension UI) open as sheets.
// Event handling follows SessionTab.onEvent/renderStored in src/main/sessionTab.ts.
import { api } from "@shared/api";
import { errMsg, h, openModal, renderMarkdown, toast } from "@shared/dom";
import { splitContext, splitFiles, splitScreenText, stripAnswerStyle } from "@shared/format";
import { t } from "@shared/i18n";
import { stripPlanMode } from "@shared/planMode";
import type { AssistantMessage, Content, PiEvent, PiMessage, ToolArgs, UiRequest } from "@shared/piProtocol";
import { invoke, listen } from "../bridge";
import { onSocketMessage, onSocketOpen, socketSend } from "../socketBus";
import { go, rememberChat, state, type ChatTarget } from "../state";
import { button } from "../ui";

interface Attached {
  handle: number;
  joined: boolean;
  streaming: boolean;
  seq: number;
}

/** Plain text of a message content (text parts joined) */
function contentText(c: Content | undefined): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** What PiBar adds to a sent message (answer style, plan mode, context paths, files, screen text) is not shown */
function cleanUserText(text: string): string {
  let s = stripPlanMode(stripAnswerStyle(text));
  s = splitScreenText(s).text;
  s = splitContext(s).text;
  return splitFiles(s).text.trim();
}

/** One line about a tool call: the command, the path or the first text argument */
function toolSummary(name: string, args: ToolArgs | undefined): string {
  if (!args) return "";
  const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url;
  const v = typeof pick === "string" ? pick : Object.values(args).find((x) => typeof x === "string");
  return typeof v === "string" ? v.split("\n")[0]?.slice(0, 160) ?? "" : name;
}

const RESULT_MAX = 6000;

class ChatView {
  readonly el: HTMLElement;
  private readonly msgs: HTMLElement;
  private readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private readonly subtitle: HTMLElement;
  handle = 0;
  private seq = 0;
  private alive = false;
  private streaming = false;
  /** Events that arrive while the history loads (applied afterwards) */
  private queued: { seq: number; ev: PiEvent }[] | null = [];
  /** The assistant block being written */
  private cur: { el: HTMLElement; parts: Map<number, { kind: string; el: HTMLElement; text: string }> } | null = null;
  private tools = new Map<string, { card: HTMLDetailsElement; status: HTMLElement; args: HTMLElement; result: HTMLElement; argText: string; name: string; summary: HTMLElement }>();
  private renderQueued = new Set<{ kind: string; el: HTMLElement; text: string }>();
  private unlisten: (() => void)[] = [];
  private stickToBottom = true;

  constructor(readonly target: ChatTarget) {
    this.subtitle = h("div", { class: "chat-sub" }, target.hostName);
    this.msgs = h("div", { class: "chat-msgs", onscroll: () => this.onScroll() });
    this.status = h("div", { class: "chat-status" });
    this.input = h("textarea", {
      rows: 1,
      placeholder: t("Message to Pi"),
      oninput: () => this.autosize(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void this.send();
        }
      },
    });
    this.sendBtn = h("button", { class: "send-btn", "aria-label": t("Send"), onclick: () => void this.send() }, "↑");
    this.stopBtn = h("button", { class: "stop-btn", "aria-label": t("Stop"), hidden: true, onclick: () => void this.abort() }, "■");
    const head = h(
      "header",
      { class: "chat-head" },
      h("button", { class: "icon-btn", "aria-label": t("Back"), onclick: () => go("sessions") }, "‹"),
      h("div", { class: "chat-title" }, h("div", { class: "chat-name" }, target.title || t("New session")), this.subtitle),
      h("button", { class: "icon-btn", "aria-label": t("Details"), onclick: () => this.details() }, "ⓘ"),
    );
    this.el = h(
      "div",
      { class: "chat" },
      head,
      this.msgs,
      this.status,
      h("div", { class: "composer" }, this.input, this.stopBtn, this.sendBtn),
    );
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    this.note(t("Starting Pi on {host} …", { host: this.target.hostName }), "loading");
    this.unlisten.push(
      await listen<{ handle: number; event: PiEvent; seq?: number }>("pi-event", (e) => {
        if (e.payload.handle !== this.handle) return;
        this.onRaw(e.payload.event, e.payload.seq);
      }),
      await listen<{ handle: number; stderr: string }>("pi-exit", (e) => {
        if (e.payload.handle === this.handle) this.onExit(e.payload.stderr);
      }),
      onSocketOpen(() => {
        if (this.handle) socketSend({ type: "subscribe", handle: this.handle, since: this.seq });
      }),
      onSocketMessage((m) => {
        if (m.handle !== this.handle) return;
        if (m.type === "pi/reload") void this.reload();
        if (m.type === "pi/denied") void this.reattach();
      }),
    );
    await this.attach();
  }

  private async attach() {
    const a = await invoke<Attached>("pi_attach", {
      hostId: this.target.hostId,
      cwd: this.target.cwd || "~",
      sessionPath: this.target.path,
    });
    this.handle = a.handle;
    this.seq = a.seq;
    this.alive = true;
    this.queued = [];
    socketSend({ type: "subscribe", handle: this.handle, since: this.seq });
    await this.loadHistory();
    this.setStreaming(a.streaming);
    if (a.streaming) this.setStatus(t("Pi is working …"));
    void this.loadModel();
  }

  /** The process is gone on the server (closed while idle, container restarted): start it again */
  private async reattach() {
    if (!this.target.path) return;
    try {
      this.msgs.replaceChildren();
      await this.attach();
    } catch (e) {
      this.note(errMsg(e), "error");
    }
  }

  private async reload() {
    this.msgs.replaceChildren();
    this.queued = [];
    await this.loadHistory();
  }

  private async loadHistory() {
    try {
      const data = await api.pi(this.handle, { type: "get_messages" });
      this.msgs.replaceChildren();
      this.cur = null;
      this.tools.clear();
      for (const m of data.messages ?? []) this.renderStored(m);
      if (!data.messages?.length) this.note(t("New session in {folder}", { folder: this.target.cwd || "~" }), "hint");
    } catch (e) {
      // after Pi ended the exit box already says what happened
      if (this.alive) this.note(errMsg(e), "error");
    }
    const waiting = this.queued ?? [];
    this.queued = null;
    for (const q of waiting) this.onEvent(q.ev);
    this.scrollDown(true);
  }

  private async loadModel() {
    try {
      const st = await api.pi(this.handle, { type: "get_state" });
      const model = st.model ? `${st.model.name ?? st.model.id}` : "";
      this.subtitle.textContent = [this.target.hostName, model].filter(Boolean).join(" · ");
      if (st.sessionFile && !this.target.path) {
        // a new session got its file: remember it, so a reload opens this session again
        this.target.path = st.sessionFile;
        rememberChat();
      }
    } catch {
      /* the subtitle stays */
    }
  }

  dispose() {
    for (const u of this.unlisten) u();
    this.unlisten = [];
    if (this.handle) socketSend({ type: "unsubscribe", handle: this.handle });
  }

  // ------------------------------------------------------------------ rendering

  private onScroll() {
    const m = this.msgs;
    this.stickToBottom = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  private scrollDown(force = false) {
    if (force || this.stickToBottom) this.msgs.scrollTop = this.msgs.scrollHeight;
  }

  private note(text: string, kind: "hint" | "error" | "loading") {
    this.msgs.querySelectorAll(".chat-note.loading").forEach((n) => n.remove());
    this.msgs.append(h("div", { class: `chat-note ${kind}` }, text));
    this.scrollDown();
  }

  private userBubble(content: Content | undefined) {
    this.cur = null;
    const text = cleanUserText(contentText(content));
    const imgs = Array.isArray(content)
      ? content
          .filter((c) => c.type === "image" && c.data)
          .map((c) => h("img", { class: "msg-img", src: `data:${(c as { mimeType?: string }).mimeType || "image/png"};base64,${(c as { data: string }).data}` }))
      : [];
    this.msgs.querySelectorAll(".chat-note.hint").forEach((n) => n.remove());
    this.msgs.append(h("div", { class: "msg user" }, h("div", { class: "bubble" }, text, ...imgs)));
    this.scrollDown(true);
  }

  private beginAssistant() {
    if (this.cur) return;
    const el = h("div", { class: "msg assistant" });
    this.msgs.append(el);
    this.cur = { el, parts: new Map() };
  }

  private part(index: number, kind: "text" | "thinking") {
    this.beginAssistant();
    const cur = this.cur as NonNullable<ChatView["cur"]>;
    let p = cur.parts.get(index);
    if (!p || p.kind !== kind) {
      let el: HTMLElement;
      if (kind === "thinking") {
        const body = h("div", { class: "md" });
        cur.el.append(h("details", { class: "card thinking" }, h("summary", {}, t("Thinking")), body));
        el = body;
      } else {
        el = h("div", { class: "md" });
        cur.el.append(el);
      }
      p = { kind, el, text: "" };
      cur.parts.set(index, p);
    }
    return p;
  }

  private appendPart(index: number, kind: "text" | "thinking", delta: string) {
    const p = this.part(index, kind);
    p.text += delta;
    this.schedule(p);
  }

  /** Markdown is rendered at most once per frame while text streams in */
  private schedule(p: { kind: string; el: HTMLElement; text: string }) {
    if (this.renderQueued.size === 0) {
      requestAnimationFrame(() => {
        for (const q of this.renderQueued) renderMarkdown(q.el, q.text);
        this.renderQueued.clear();
        this.scrollDown();
      });
    }
    this.renderQueued.add(p);
  }

  private toolStart(id: string, name: string) {
    if (this.tools.has(id)) return;
    this.beginAssistant();
    const status = h("span", { class: "tool-status" });
    const summary = h("span", { class: "tool-sum" });
    const args = h("pre", { class: "tool-args" });
    const result = h("pre", { class: "tool-result", hidden: true });
    const card = h(
      "details",
      { class: "card tool" },
      h("summary", {}, h("span", { class: "tool-name" }, name || "Tool"), summary, status),
      args,
      result,
    );
    (this.cur as NonNullable<ChatView["cur"]>).el.append(card);
    this.tools.set(id, { card, status, args, result, argText: "", name, summary });
    this.scrollDown();
  }

  private toolArgs(id: string, args: ToolArgs | undefined) {
    const tool = this.tools.get(id);
    if (!tool || !args) return;
    tool.summary.textContent = toolSummary(tool.name, args);
    tool.args.textContent = JSON.stringify(args, null, 2);
  }

  private toolStatus(id: string, kind: "run" | "ok" | "err", label: string) {
    const tool = this.tools.get(id);
    if (!tool) return;
    tool.status.className = `tool-status ${kind}`;
    tool.status.textContent = label;
  }

  private toolResult(id: string, content: Content | undefined, isError: boolean) {
    const tool = this.tools.get(id);
    if (!tool) return;
    const text = contentText(content);
    tool.result.hidden = !text;
    tool.result.textContent = text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n…` : text;
    this.toolStatus(id, isError ? "err" : "ok", isError ? t("failed") : t("done"));
  }

  /** A finished assistant message: rebuild the block from the final message (fixes a stream joined midway) */
  private endAssistant(m: AssistantMessage) {
    const old = this.cur;
    this.cur = null;
    old?.el.remove();
    this.renderAssistant(m, false);
  }

  private renderAssistant(m: AssistantMessage, stored: boolean) {
    this.beginAssistant();
    (m.content ?? []).forEach((c, i) => {
      if (c.type === "text") {
        const p = this.part(i, "text");
        p.text = c.text ?? "";
        renderMarkdown(p.el, p.text);
      } else if (c.type === "thinking") {
        const p = this.part(i, "thinking");
        p.text = c.thinking ?? "";
        renderMarkdown(p.el, p.text);
      } else if (c.type === "toolCall") {
        const known = this.tools.get(c.id);
        if (known) {
          (this.cur as NonNullable<ChatView["cur"]>).el.append(known.card);
        } else {
          this.toolStart(c.id, c.name);
          if (stored) this.toolStatus(c.id, "ok", t("done"));
        }
        this.toolArgs(c.id, c.arguments);
      }
    });
    if (m.stopReason === "error" || m.errorMessage) {
      (this.cur as NonNullable<ChatView["cur"]>).el.append(h("div", { class: "chat-note error" }, m.errorMessage || t("Pi reported an error.")));
    } else if (m.stopReason === "aborted") {
      (this.cur as NonNullable<ChatView["cur"]>).el.append(h("div", { class: "chat-note hint" }, t("Stopped.")));
    }
    this.scrollDown();
  }

  private renderStored(m: PiMessage) {
    if (m.role === "user") this.userBubble(m.content);
    else if (m.role === "assistant") {
      this.renderAssistant(m, true);
      // tool results follow as their own messages; the next assistant message starts a new block
      this.cur = null;
    } else if (m.role === "toolResult") this.toolResult(m.toolCallId, m.content, !!m.isError);
  }

  // ------------------------------------------------------------------ live events

  private onRaw(ev: PiEvent, seq: number | undefined) {
    if (seq !== undefined) {
      if (seq <= this.seq) return;
      this.seq = seq;
    }
    if (this.queued) {
      this.queued.push({ seq: seq ?? 0, ev });
      return;
    }
    this.onEvent(ev);
  }

  private onEvent(ev: PiEvent) {
    switch (ev.type) {
      case "agent_start":
        this.setStreaming(true);
        this.setStatus(t("Pi is working …"));
        break;
      case "agent_settled":
        this.setStreaming(false);
        this.setStatus("");
        break;
      case "message_start":
        if (ev.message?.role === "user") this.userBubble(ev.message.content);
        else if (ev.message?.role === "assistant") this.beginAssistant();
        break;
      case "message_update": {
        const a = ev.assistantMessageEvent;
        if (!a) break;
        if (a.type === "text_delta") this.appendPart(a.contentIndex, "text", a.delta);
        else if (a.type === "thinking_delta") this.appendPart(a.contentIndex, "thinking", a.delta);
        else if (a.type === "toolcall_start") this.toolStart(a.id, a.toolName);
        else if (a.type === "toolcall_delta") {
          const last = [...this.tools.values()].at(-1);
          if (last) {
            last.argText += a.delta;
            last.args.textContent = last.argText;
          }
        } else if (a.type === "toolcall_end" && a.toolCall) this.toolArgs(a.toolCall.id, a.toolCall.arguments);
        break;
      }
      case "message_end":
        if (ev.message?.role === "assistant") this.endAssistant(ev.message);
        break;
      case "tool_execution_start":
        this.toolStart(ev.toolCallId, ev.toolName ?? "Tool");
        this.toolArgs(ev.toolCallId, ev.args);
        this.toolStatus(ev.toolCallId, "run", t("running …"));
        this.setStatus(`${ev.toolName ?? "Tool"} …`);
        break;
      case "tool_execution_end":
        this.toolResult(ev.toolCallId, ev.result?.content, !!ev.isError);
        this.setStatus(t("Pi is working …"));
        break;
      case "extension_ui_request":
        this.uiRequest(ev);
        break;
      default:
        break;
    }
  }

  private onExit(stderr: string) {
    this.alive = false;
    this.setStreaming(false);
    this.setStatus("");
    const box = h("div", { class: "chat-note error" }, t("Pi has stopped."), stderr.trim() ? h("pre", {}, stderr.trim().slice(-1500)) : null);
    box.append(h("div", {}, button(t("Reconnect"), () => void this.reattach())));
    this.msgs.append(box);
    this.scrollDown(true);
  }

  // ------------------------------------------------------------------ Pi's dialogs (extension UI)

  private uiRequest(ev: UiRequest) {
    const reply = (msg: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
      api.piReply(this.handle, { id: ev.id, ...msg }).catch((e: unknown) => toast(errMsg(e), "err"));
    switch (ev.method) {
      case "notify":
        toast(ev.message ?? "", ev.notifyType === "error" ? "err" : "info");
        return;
      case "setStatus":
      case "setWidget":
      case "setTitle":
      case "set_editor_text":
        return;
      case "confirm": {
        let answered = false;
        const close = openModal(
          ev.title || t("Pi asks"),
          h("p", {}, ev.message ?? ""),
          [
            button(t("No"), () => {
              answered = true;
              void reply({ confirmed: false });
              close();
            }),
            button(
              t("Yes"),
              () => {
                answered = true;
                void reply({ confirmed: true });
                close();
              },
              "primary",
            ),
          ],
          () => {
            if (!answered) void reply({ cancelled: true });
          },
        );
        return;
      }
      case "select": {
        let answered = false;
        const close = openModal(
          ev.title || t("Pi asks"),
          h(
            "div",
            { class: "stack" },
            ...(ev.options ?? []).map((o) =>
              button(o, () => {
                answered = true;
                void reply({ value: o });
                close();
              }),
            ),
          ),
          [button(t("Cancel"), () => close())],
          () => {
            if (!answered) void reply({ cancelled: true });
          },
        );
        return;
      }
      case "input":
      case "editor": {
        let answered = false;
        const field =
          ev.method === "editor"
            ? h("textarea", { rows: 8, placeholder: ev.placeholder ?? "" })
            : h("input", { type: "text", placeholder: ev.placeholder ?? "" });
        field.value = ev.prefill ?? "";
        const close = openModal(
          ev.title || t("Pi asks"),
          h("div", { class: "form" }, ev.message ? h("p", {}, ev.message) : null, field),
          [
            button(t("Cancel"), () => close()),
            button(
              t("OK"),
              () => {
                answered = true;
                void reply({ value: field.value });
                close();
              },
              "primary",
            ),
          ],
          () => {
            if (!answered) void reply({ cancelled: true });
          },
        );
        return;
      }
      default:
        return;
    }
  }

  // ------------------------------------------------------------------ input

  private autosize() {
    this.input.style.height = "auto";
    this.input.style.height = `${Math.min(this.input.scrollHeight, 200)}px`;
  }

  private setStreaming(on: boolean) {
    this.streaming = on;
    this.stopBtn.hidden = !on;
  }

  private setStatus(text: string) {
    this.status.textContent = text;
    this.status.hidden = !text;
  }

  private async send() {
    const text = this.input.value.trim();
    if (!text || !this.handle) return;
    if (!this.alive) {
      toast(t("Pi has stopped."), "err");
      return;
    }
    this.sendBtn.disabled = true;
    // decided before sending: Pi's agent_start for this very message can arrive before the answer to the command
    const queued = this.streaming;
    try {
      const cmd: { type: "prompt"; [k: string]: unknown } = { type: "prompt", message: text };
      // while Pi works the message waits until the current answer is done (desktop default: follow-up)
      if (queued) cmd.streamingBehavior = "followUp";
      await api.pi(this.handle, cmd);
      this.input.value = "";
      this.autosize();
      if (queued) toast(t("Queued – Pi reads it after the current answer."));
      void this.loadModel();
    } catch (e) {
      toast(errMsg(e), "err");
    } finally {
      this.sendBtn.disabled = false;
    }
  }

  private async abort() {
    try {
      await api.pi(this.handle, { type: "abort" });
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  private details() {
    const row = (label: string, value: string) => h("div", { class: "detail-row" }, h("span", {}, label), h("code", {}, value || "–"));
    const close = openModal(this.target.title || t("New session"), h("div", { class: "detail" }, row(t("Host"), this.target.hostName), row(t("Folder"), this.target.cwd), row(t("Session file"), this.target.path ?? "")), [
      button(t("Close"), () => close(), "primary"),
    ]);
  }
}

// ------------------------------------------------------------------ the chat page

let view: ChatView | null = null;

/** Render the chat tab: the current chat, or a hint */
export function renderChat(root: HTMLElement) {
  const target = state.chat;
  if (!target) {
    view?.dispose();
    view = null;
    root.replaceChildren(h("div", { class: "empty" }, h("p", {}, t("Pick a session in the list or start a new one."))));
    return;
  }
  if (!view || view.target !== target) {
    view?.dispose();
    view = new ChatView(target);
    const v = view;
    v.start().catch((e: unknown) => {
      v.el.querySelector(".chat-msgs")?.append(h("div", { class: "chat-note error" }, errMsg(e)));
    });
  }
  root.replaceChildren(view.el);
}
