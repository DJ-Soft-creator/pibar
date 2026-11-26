// The message list of the chat: own messages (with images, attached files, actions and "‹ 2/3 ›" versions), answers
// as Markdown, thinking and tool calls as cards (closed, open or hidden by the chat view), subagent runs as cards, and
// errors with hints and a "Diagnose" button. Built from the stored history (get_messages) and from live events, like
// SessionTab.renderStored/onEvent in src/main/sessionTab.ts.
import type { ChatMode } from "@shared/api";
import type { BranchChoice } from "@shared/branches";
import { copyText, errMsg, h, renderMarkdown, toast } from "@shared/dom";
import { shortModel, splitContext, splitFiles, splitScreenText, stripAnswerStyle } from "@shared/format";
import { t } from "@shared/i18n";
import { isStaleInstallError } from "@shared/piErrors";
import type { AssistantMessage, Content, PiEvent, PiMessage, ToolArgs } from "@shared/piProtocol";
import { stripPlanMode } from "@shared/planMode";
import { subagentFromArgs, subagentFromDetails, type SubagentCall } from "@shared/subagents";
import { canSpeak, speakText } from "../voiceInput";

export type UserAction = "edit" | "rerun" | "rewind" | "reuse" | "copy";

export interface RenderCallbacks {
  /** Earlier own message: index among the own messages shown, text as shown */
  userAction(index: number, action: UserAction, text: string): void;
  diagnose(error: string): void;
  restart(): void;
  /** Rendering added content (auto scroll) */
  grew(): void;
}

interface Part {
  kind: "text" | "thinking";
  el: HTMLElement;
  text: string;
}

interface ToolCard {
  card: HTMLDetailsElement;
  status: HTMLElement;
  args: HTMLElement;
  result: HTMLElement;
  summary: HTMLElement;
  argText: string;
  name: string;
  sub?: HTMLElement;
}

const RESULT_MAX = 6000;

/** Plain text of a message content (text parts joined) */
export function contentText(c: Content | undefined): string {
  if (typeof c === "string") return c;
  if (!Array.isArray(c)) return "";
  return c
    .map((p) => (p.type === "text" ? (p.text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** One line about a tool call: the command, the path or the first text argument */
function toolSummary(name: string, args: ToolArgs | undefined): string {
  if (!args) return "";
  const pick = args.command ?? args.path ?? args.file_path ?? args.pattern ?? args.query ?? args.url ?? args.task ?? args.agent;
  const v = typeof pick === "string" ? pick : Object.values(args).find((x) => typeof x === "string");
  return typeof v === "string" ? (v.split("\n")[0]?.slice(0, 160) ?? "") : name;
}

const STATUS_LABEL: Record<string, () => string> = {
  pending: () => t("waiting"),
  running: () => t("running …"),
  completed: () => t("done"),
  failed: () => t("failed"),
  aborted: () => t("Stopped."),
};

export class MessageList {
  readonly el: HTMLElement;
  private cur: { el: HTMLElement; parts: Map<number, Part> } | null = null;
  private tools = new Map<string, ToolCard>();
  private subagents = new Map<string, SubagentCall>();
  private renderQueued = new Set<Part>();
  private userCount = 0;
  /** Text of the last answer (choice questions at its end) */
  lastText = "";
  mode: ChatMode = "technical";

  constructor(private readonly cb: RenderCallbacks) {
    this.el = h("div", { class: "chat-list" });
  }

  clear() {
    this.el.replaceChildren();
    this.cur = null;
    this.tools.clear();
    this.subagents.clear();
    this.userCount = 0;
    this.lastText = "";
  }

  setMode(mode: ChatMode) {
    this.mode = mode;
    this.el.dataset.view = mode;
    // debug: cards open; technical: closed; natural hides them by CSS
    this.el.querySelectorAll<HTMLDetailsElement>("details.card").forEach((d) => {
      if (!d.classList.contains("sub-card")) d.open = mode === "debug";
    });
  }

  get userMessages(): number {
    return this.userCount;
  }

  note(text: string, kind: "hint" | "error" | "loading") {
    this.el.querySelectorAll(".chat-note.loading").forEach((n) => n.remove());
    const n = h("div", { class: `chat-note ${kind}` }, text);
    this.el.append(n);
    this.cb.grew();
    return n;
  }

  dropNotes(kind: string) {
    this.el.querySelectorAll(`.chat-note.${kind}`).forEach((n) => n.remove());
  }

  append(node: HTMLElement) {
    this.el.append(node);
    this.cb.grew();
  }

  // ------------------------------------------------------------------ own messages

  userBubble(content: Content | undefined) {
    this.cur = null;
    let text = stripPlanMode(stripAnswerStyle(contentText(content)));
    const screen = splitScreenText(text);
    text = splitContext(screen.text).text;
    const files = splitFiles(text);
    text = files.text.trim();
    const imgs = Array.isArray(content)
      ? content
          .filter((c) => c.type === "image" && c.data)
          .map((c) => {
            const p = c as { mimeType?: string; data: string };
            return h("img", { class: "msg-img", alt: "", src: `data:${p.mimeType || "image/png"};base64,${p.data}` });
          })
      : [];
    const fileCards = files.files.map((f) =>
      h("details", { class: "file-card" }, h("summary", {}, `📄 ${f.name}`, h("span", { class: "muted" }, ` · ${t("{n} characters", { n: f.text.length })}`)), h("pre", {}, f.text)),
    );
    const index = this.userCount++;
    const act = (label: string, icon: string, action: UserAction) =>
      h("button", { class: "msg-act", type: "button", "aria-label": label, title: label, onclick: () => this.cb.userAction(index, action, text) }, icon);
    const acts = h(
      "div",
      { class: "msg-acts" },
      act(t("Copy"), "⧉", "copy"),
      act(t("Use as new message"), "↧", "reuse"),
      act(t("Edit and resend (new branch from here)"), "✎", "edit"),
      act(t("Run again from here (new branch)"), "↻", "rerun"),
      act(t("Go back to here (later messages are removed from this view)"), "↶", "rewind"),
    );
    this.el.querySelectorAll(".chat-note.hint").forEach((n) => n.remove());
    this.el.append(
      h("div", { class: "msg user", "data-user-index": String(index) }, h("div", { class: "bubble" }, ...imgs, text, ...fileCards), acts),
    );
    this.cb.grew();
  }

  /** "‹ 2/3 ›" under own messages that exist in other versions (SessionTab.showBranches) */
  showBranches(versions: Map<number, BranchChoice[]>, offset: number, pick: (c: BranchChoice, index: number) => void) {
    this.el.querySelectorAll(".branch-nav").forEach((n) => n.remove());
    for (const [k, list] of versions) {
      const index = k - offset;
      const msg = this.el.querySelector<HTMLElement>(`.msg.user[data-user-index="${index}"]`);
      const cur = list.findIndex((c) => c.current);
      if (!msg || cur < 0) continue;
      const go = (to: number) => () => {
        const c = list[to];
        if (c) pick(c, index);
      };
      const nav = h(
        "div",
        { class: "branch-nav", title: t("Versions of this message") },
        h("button", { class: "msg-act", type: "button", disabled: cur === 0, "aria-label": t("Previous version"), onclick: go(cur - 1) }, "‹"),
        h("span", { class: "branch-count" }, `${cur + 1}/${list.length}`),
        h("button", { class: "msg-act", type: "button", disabled: cur === list.length - 1, "aria-label": t("Next version"), onclick: go(cur + 1) }, "›"),
      );
      msg.querySelector(".bubble")?.after(nav);
    }
  }

  scrollToUser(index: number) {
    const msg = this.el.querySelector<HTMLElement>(`.msg.user[data-user-index="${index}"]`);
    msg?.scrollIntoView({ block: "center" });
  }

  // ------------------------------------------------------------------ answers

  private beginAssistant() {
    if (this.cur) return;
    // "technical" until visible text arrives: the natural view hides answers that only call tools
    const el = h("div", { class: "msg assistant only-tools" });
    this.el.append(el);
    this.cur = { el, parts: new Map() };
  }

  private part(index: number, kind: "text" | "thinking"): Part {
    this.beginAssistant();
    const cur = this.cur as NonNullable<MessageList["cur"]>;
    let p = cur.parts.get(index);
    if (!p || p.kind !== kind) {
      let el: HTMLElement;
      if (kind === "thinking") {
        el = h("div", { class: "md" });
        const card = h("details", { class: "card thinking" }, h("summary", {}, t("Thinking")), el);
        card.open = this.mode === "debug";
        cur.el.append(card);
      } else {
        el = h("div", { class: "md answer" });
        cur.el.append(el);
        cur.el.classList.remove("only-tools");
      }
      p = { kind, el, text: "" };
      cur.parts.set(index, p);
    }
    return p;
  }

  private appendPart(index: number, kind: "text" | "thinking", delta: string) {
    const p = this.part(index, kind);
    p.text += delta;
    if (this.renderQueued.size === 0) {
      requestAnimationFrame(() => {
        for (const q of this.renderQueued) renderMarkdown(q.el, q.text);
        this.renderQueued.clear();
        this.cb.grew();
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
    const card = h("details", { class: "card tool" }, h("summary", {}, h("span", { class: "tool-name" }, name || "Tool"), summary, status), args, result);
    card.open = this.mode === "debug";
    (this.cur as NonNullable<MessageList["cur"]>).el.append(card);
    this.tools.set(id, { card, status, args, result, argText: "", name, summary });
    this.cb.grew();
  }

  private toolArgs(id: string, args: ToolArgs | undefined) {
    const tool = this.tools.get(id);
    if (!tool || !args) return;
    tool.summary.textContent = toolSummary(tool.name, args);
    tool.args.textContent = JSON.stringify(args, null, 2);
    if (tool.name === "subagent" && !this.subagents.has(id)) {
      const call = subagentFromArgs(args);
      if (call) {
        this.subagents.set(id, call);
        this.renderSubagent(id);
      }
    }
  }

  private toolStatus(id: string, kind: "run" | "ok" | "err", label: string) {
    const tool = this.tools.get(id);
    if (!tool) return;
    tool.status.className = `tool-status ${kind}`;
    tool.status.textContent = label;
  }

  private toolResult(id: string, content: Content | undefined, isError: boolean, partial = false) {
    const tool = this.tools.get(id);
    if (!tool) return;
    const text = contentText(content);
    tool.result.hidden = !text;
    tool.result.textContent = text.length > RESULT_MAX ? `${text.slice(0, RESULT_MAX)}\n…` : text;
    if (!partial) this.toolStatus(id, isError ? "err" : "ok", isError ? t("failed") : t("done"));
  }

  /** Runs of a "subagent" tool call as a card of their own under the tool (shared/subagents.ts) */
  private trackSubagent(id: string, details: unknown, done: boolean, isError: boolean) {
    const call = this.subagents.get(id);
    if (!call) return;
    const parsed = subagentFromDetails(details);
    if (parsed) {
      call.mode = parsed.mode;
      call.runs = parsed.runs;
      call.isError = parsed.isError;
    }
    if (done) {
      call.done = true;
      call.isError = call.isError || isError;
      for (const r of call.runs) if (r.status === "pending" || r.status === "running") r.status = isError ? "failed" : "completed";
    }
    this.renderSubagent(id);
  }

  private renderSubagent(id: string) {
    const tool = this.tools.get(id);
    const call = this.subagents.get(id);
    if (!tool || !call) return;
    const rows = call.runs.map((r) =>
      h(
        "div",
        { class: `sub-run s-${r.status}` },
        h("span", { class: "sub-agent" }, `${r.step ? `${r.step}. ` : ""}${r.agent}`),
        h("span", { class: "sub-task" }, r.task.split("\n")[0] ?? ""),
        h("span", { class: "sub-status" }, (STATUS_LABEL[r.status] ?? (() => r.status))()),
      ),
    );
    const head = call.mode === "parallel" ? t("Subagents in parallel") : call.mode === "chain" ? t("Subagent chain") : t("Subagent");
    const el = h("div", { class: "sub-card" }, h("div", { class: "sub-head" }, `⑂ ${head}`), ...rows);
    if (tool.sub) tool.sub.replaceWith(el);
    else tool.card.after(el);
    tool.sub = el;
  }

  /** A finished assistant message: rebuild the block from the final message (fixes a stream joined midway) */
  private endAssistant(m: AssistantMessage) {
    const old = this.cur;
    this.cur = null;
    if (old) {
      // tool cards built live stay (with their results); the rest is rebuilt
      old.el.remove();
    }
    this.renderAssistant(m, false);
    this.cur = null;
  }

  private renderAssistant(m: AssistantMessage, stored: boolean) {
    this.beginAssistant();
    const cur = this.cur as NonNullable<MessageList["cur"]>;
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
          cur.el.append(known.card);
          if (known.sub) cur.el.append(known.sub);
        } else {
          this.toolStart(c.id, c.name);
          if (stored) this.toolStatus(c.id, "ok", t("done"));
        }
        this.toolArgs(c.id, c.arguments);
      }
    });
    if (m.stopReason === "error" || m.errorMessage) {
      cur.el.classList.remove("only-tools");
      cur.el.append(this.errorBox(m.errorMessage || t("Pi reported an error.")));
    } else if (m.stopReason === "aborted") {
      cur.el.classList.remove("only-tools");
      cur.el.append(h("div", { class: "chat-note hint" }, t("Stopped.")));
    }
    const text = [...cur.parts.values()]
      .filter((p) => p.kind === "text")
      .map((p) => p.text)
      .join("\n\n")
      .trim();
    if (text) {
      this.lastText = text;
      cur.el.append(this.answerActions(text, m));
    }
    this.cb.grew();
  }

  private answerActions(text: string, m: AssistantMessage): HTMLElement {
    const copy = h("button", {
      class: "msg-act",
      type: "button",
      "aria-label": t("Copy answer"),
      title: t("Copy answer"),
      onclick: () =>
        copyText(text).then(
          () => toast(t("Answer copied")),
          (e: unknown) => toast(errMsg(e), "err"),
        ),
    }, "⧉");
    const speak = canSpeak()
      ? h("button", { class: "msg-act", type: "button", "aria-label": t("Read aloud"), title: t("Read aloud"), onclick: () => void speakText(text).catch((e: unknown) => toast(errMsg(e), "err")) }, "🔊")
      : null;
    const used = m.model ? h("span", { class: "msg-model", title: `${m.provider ?? ""}/${m.model}` }, shortModel(m.model)) : null;
    return h("div", { class: "msg-acts answer-acts" }, used, copy, speak);
  }

  /** Error of an answer with hints (src/shared/piErrors.ts) and the diagnosis (src/main/diagnose.ts) */
  errorBox(error: string): HTMLElement {
    const stale = isStaleInstallError(error);
    return h(
      "div",
      { class: "chat-note error" },
      h("div", { class: "err-text" }, error),
      stale ? h("div", { class: "err-hint" }, t("Pi was updated or removed on the host while this session was running. Restart the session; the history stays.")) : null,
      h(
        "div",
        { class: "err-acts" },
        stale ? h("button", { class: "btn", type: "button", onclick: () => this.cb.restart() }, t("Restart session")) : null,
        h("button", { class: "btn", type: "button", onclick: () => this.cb.diagnose(error) }, t("Diagnose")),
      ),
    );
  }

  renderStored(m: PiMessage) {
    if (m.role === "user") this.userBubble(m.content);
    else if (m.role === "assistant") {
      this.renderAssistant(m, true);
      this.cur = null;
    } else if (m.role === "toolResult") {
      this.toolResult(m.toolCallId, m.content, !!m.isError);
      this.trackSubagent(m.toolCallId, m.details, true, !!m.isError);
    }
  }

  /** Render a live event */
  onEvent(ev: PiEvent) {
    switch (ev.type) {
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
        break;
      case "tool_execution_update":
        if (this.mode === "debug") this.toolResult(ev.toolCallId, ev.partialResult?.content, false, true);
        this.trackSubagent(ev.toolCallId, ev.partialResult?.details, false, false);
        break;
      case "tool_execution_end":
        this.toolResult(ev.toolCallId, ev.result?.content, !!ev.isError);
        this.trackSubagent(ev.toolCallId, ev.result?.details, true, !!ev.isError);
        break;
      default:
        break;
    }
  }

  /** A new answer starts after the last one (tool results continue the same block otherwise) */
  endTurn() {
    this.cur = null;
  }
}
