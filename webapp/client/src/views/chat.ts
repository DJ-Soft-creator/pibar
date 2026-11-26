// Chat of one session (mobile): compact header (back, name, model chip, "⋯"), the message list, the input with
// attachments, quick actions and the "/" menu, and the status line under it. Joins or starts Pi on the host
// (pi_attach) or follows the session's run in the background, shows the history (get_messages), follows the live
// events over the WebSocket (with replay after a reconnect, see server ws.ts) and sends messages.
// Session state lives in chatSession.ts, rendering in chatRender.ts; follows SessionTab in src/main/sessionTab.ts.
import "./chat.css";
import type { QuickAction } from "@shared/api";
import type { FileAttachment } from "@shared/attach";
import { errMsg, h, openModal, toast } from "@shared/dom";
import { cleanTitle, withFiles } from "@shared/format";
import { t } from "@shared/i18n";
import type { PiEvent, PiMessage } from "@shared/piProtocol";
import { branchMessages, parseSessionLock, sessionLockText, type SessionLock } from "@shared/sessionLock";
import { findQuestions, type QuestionGroup } from "@shared/questions";
import { api } from "@shared/api";
import { listen } from "../bridge";
import { onSocketMessage, onSocketOpen, socketSend } from "../socketBus";
import { go, rememberChat, state, type ChatTarget } from "../state";
import { button } from "../ui";
import { Composer } from "./chatComposer";
import { diagnoseDialog, questionDialog, uiRequest } from "./chatDialogs";
import { refreshBranches, subagentDialog, userAction } from "./chatExtras";
import { MessageList } from "./chatRender";
import { ChatSession, type QueueWhen } from "./chatSession";
import { modelLabel, modelSheet, optionsSheet, renderStatusLine, statsSheet } from "./chatSheets";
import { chatSettings } from "./chatStore";
import { startNewSession } from "./newSession";

export class ChatView {
  readonly el: HTMLElement;
  readonly list: MessageList;
  readonly session: ChatSession;
  readonly composer: Composer;
  private readonly titleEl: HTMLElement;
  private readonly subEl: HTMLElement;
  private readonly modelChip: HTMLButtonElement;
  private readonly scroller: HTMLElement;
  private readonly activity: HTMLElement;
  private readonly statusLine: HTMLElement;
  private readonly questionBar: HTMLElement;
  private undoBar: HTMLElement;
  /** Events that arrive while the history loads (applied afterwards) */
  private waiting: PiEvent[] | null = [];
  private unlisten: (() => void)[] = [];
  private stick = true;
  private questions: QuestionGroup[] = [];
  disposed = false;

  constructor(readonly target: ChatTarget) {
    this.session = new ChatSession(target, {
      changed: () => this.refresh(),
      reload: () => this.reloadHistory(),
      reattach: () => this.reattach(),
      backgroundDone: (ok, stderr) => void this.backgroundDone(ok, stderr),
    });
    this.list = new MessageList({
      userAction: (i, a, text) => void userAction(this, i, a, text),
      diagnose: (error) => this.diagnose(error),
      restart: () => void this.session.restart().catch((e: unknown) => toast(errMsg(e), "err")),
      grew: () => this.scrollDown(),
    });
    this.titleEl = h("div", { class: "chat-name" }, target.title || t("New session"));
    this.subEl = h("div", { class: "chat-sub" }, target.hostName);
    this.modelChip = h("button", { class: "model-chip", type: "button", "aria-label": t("Model"), onclick: () => modelSheet(this.session) }, t("Model"));
    const head = h(
      "header",
      { class: "chat-head" },
      h("button", { class: "icon-btn", type: "button", "aria-label": t("Back"), onclick: () => go("sessions") }, "‹"),
      h("button", { class: "chat-title", type: "button", "aria-label": t("Rename …"), onclick: () => this.rename() }, this.titleEl, this.subEl),
      this.modelChip,
      h("button", { class: "icon-btn", type: "button", "aria-label": t("Session options"), onclick: () => this.options() }, "⋯"),
    );
    this.scroller = h("div", { class: "chat-msgs", onscroll: () => this.onScroll() }, this.list.el);
    this.activity = h("div", { class: "chat-status", hidden: true });
    this.questionBar = h("div", { class: "question-bar", hidden: true });
    this.undoBar = h("div", { class: "undo-bar", hidden: true });
    this.composer = new Composer({
      send: (text, att, when) => this.send(text, att, when),
      abort: () => void this.session.abort().catch((e: unknown) => toast(errMsg(e), "err")),
      commands: () => this.session.commands,
      unqueue: () => void this.unqueue(),
      quick: (a) => void this.quick(a),
    });
    this.statusLine = h("button", { class: "status-line", type: "button", "aria-label": t("Session statistics"), onclick: () => void statsSheet(this.session) });
    this.el = h("div", { class: "chat" }, head, this.scroller, this.activity, this.undoBar, this.questionBar, this.composer.el, this.statusLine);
  }

  // ------------------------------------------------------------------ lifecycle

  async start() {
    this.list.note(t("Starting Pi on {host} …", { host: this.target.hostName }), "loading");
    this.unlisten.push(
      await listen<{ handle: number; event: PiEvent; seq?: number }>("pi-event", (e) => {
        if (e.payload.handle === this.session.handle) this.onRaw(e.payload.event, e.payload.seq);
      }),
      await listen<{ handle: number; stderr: string }>("pi-exit", (e) => {
        if (e.payload.handle === this.session.handle) void this.onExit(e.payload.stderr);
      }),
      onSocketOpen(() => {
        if (this.session.handle) socketSend({ type: "subscribe", handle: this.session.handle, since: this.session.seq });
      }),
      onSocketMessage((m) => {
        if (m.handle !== this.session.handle) return;
        if (m.type === "pi/reload") void this.reloadHistory();
        if (m.type === "pi/denied") void this.reattach();
      }),
    );
    let a: Awaited<ReturnType<ChatSession["open"]>>;
    try {
      a = await this.session.open();
    } catch (e) {
      const lock = parseSessionLock(e);
      if (!lock) throw e;
      await this.showLocked(lock);
      return;
    }
    this.composer.setQuickActions(this.session.shared.quickActions);
    await this.afterAttach(a.joined);
  }

  /**
   * The session runs in another Pi right now (desktop app or another webapp): show its history read-only from the
   * session file and offer to take it over (the other Pi is stopped then).
   */
  private async showLocked(lock: SessionLock) {
    this.list.clear();
    const path = this.target.path;
    if (path) {
      try {
        const jsonl = await api.readSessionFile(this.target.hostId, path);
        for (const m of branchMessages(jsonl)) this.list.renderStored(m);
      } catch (e) {
        this.list.note(errMsg(e), "error");
      }
    }
    const since = lock.since ? ` (${t("since")} ${new Date(lock.since).toLocaleTimeString()})` : "";
    const box = h(
      "div",
      { class: "chat-note hint locked" },
      `${sessionLockText(lock)}${since} ${t("Read only – take it over to write here; the other Pi is stopped then.")}`,
      h(
        "div",
        { class: "err-acts" },
        button(
          t("Take over"),
          () => {
            box.remove();
            void this.takeOver();
          },
          "primary",
        ),
      ),
    );
    this.list.append(box);
    this.scrollDown(true);
  }

  private async takeOver() {
    try {
      this.list.note(t("Starting Pi on {host} …", { host: this.target.hostName }), "loading");
      const a = await this.session.attach(true);
      this.composer.setQuickActions(this.session.shared.quickActions);
      await this.afterAttach(a.joined);
    } catch (e) {
      this.list.note(errMsg(e), "error");
    }
  }

  private async afterAttach(joined: boolean) {
    this.waiting = [];
    socketSend({ type: "subscribe", handle: this.session.handle, since: this.session.seq });
    this.list.setMode(this.session.viewMode());
    if (this.session.detached) {
      this.list.clear();
      this.list.note(t("This session runs in the background – its history appears when the run is done."), "hint");
      this.flushWaiting();
    } else {
      await this.loadHistory();
      await this.session.ready(joined);
      if (this.target.path) void refreshBranches(this);
    }
    this.refresh();
  }

  /** Start Pi again (after it stopped, a tool change, a run in the background) */
  async reattach() {
    try {
      this.list.clear();
      this.list.note(t("Starting Pi on {host} …", { host: this.target.hostName }), "loading");
      const a = await this.session.attach();
      await this.afterAttach(a.joined);
    } catch (e) {
      const lock = parseSessionLock(e);
      if (lock) await this.showLocked(lock);
      else this.list.note(errMsg(e), "error");
    }
  }

  private async reloadHistory() {
    this.waiting = [];
    await this.loadHistory();
    if (this.target.path) void refreshBranches(this);
    this.refresh();
  }

  private async loadHistory() {
    let messages: PiMessage[] = [];
    try {
      messages = (await api.pi(this.session.handle, { type: "get_messages" })).messages ?? [];
      this.list.clear();
      for (const m of messages) this.list.renderStored(m);
      if (!messages.length) this.list.note(t("New session in {folder}", { folder: this.target.cwd || "~" }), "hint");
    } catch (e) {
      this.list.clear();
      if (this.session.alive) this.list.note(errMsg(e), "error");
    }
    this.questions = messages.at(-1)?.role === "assistant" ? findQuestions(this.list.lastText) : [];
    this.flushWaiting();
    this.scrollDown(true);
  }

  private flushWaiting() {
    const w = this.waiting ?? [];
    this.waiting = null;
    for (const ev of w) this.onEvent(ev);
  }

  dispose() {
    this.disposed = true;
    for (const u of this.unlisten) u();
    this.unlisten = [];
    if (this.session.handle) socketSend({ type: "unsubscribe", handle: this.session.handle });
  }

  // ------------------------------------------------------------------ events

  private onRaw(ev: PiEvent, seq: number | undefined) {
    if (seq !== undefined) {
      if (seq <= this.session.seq) return;
      this.session.seq = seq;
    }
    if (this.waiting) this.waiting.push(ev);
    else this.onEvent(ev);
  }

  private onEvent(ev: PiEvent) {
    const hidden = this.session.onEvent(ev);
    if (ev.type === "extension_ui_request" && !hidden) {
      uiRequest(this.session.handle, ev, (text) => this.composer.fill(text));
    }
    if (!hidden) this.list.onEvent(ev);
    switch (ev.type) {
      case "agent_start":
        this.questions = [];
        this.undoBar.hidden = true;
        if (chatSettings().autoScroll !== "off") this.stick = true;
        break;
      case "agent_settled":
        this.list.endTurn();
        this.questions = findQuestions(this.list.lastText);
        if (this.target.path) void refreshBranches(this);
        break;
      case "tool_execution_start":
        this.activity.textContent = `${ev.toolName ?? "Tool"} …`;
        break;
      default:
        break;
    }
    if (ev.type !== "message_update") this.refresh();
  }

  private async onExit(stderr: string) {
    if (this.session.detached) {
      this.session.bgEnded(stderr);
      return;
    }
    this.session.alive = false;
    this.session.streaming = false;
    // another device may have sent this session to the background (the server then closes the live process)
    if (this.target.path && (await api.bgRunning(this.target.hostId, this.target.path).catch(() => false))) {
      const a = await this.session.follow();
      await this.afterAttach(a.joined);
      return;
    }
    const box = h(
      "div",
      { class: "chat-note error" },
      t("Pi has stopped."),
      stderr.trim() ? h("pre", {}, stderr.trim().slice(-1500)) : null,
      h("div", { class: "err-acts" }, button(t("Reconnect"), () => void this.reattach()), button(t("Diagnose"), () => this.diagnose(stderr.trim() || t("Pi has stopped.")))),
    );
    this.list.append(box);
    this.refresh();
  }

  private async backgroundDone(ok: boolean, stderr: string) {
    const follower = this.session.handle;
    socketSend({ type: "unsubscribe", handle: follower });
    await api.piClose(follower).catch(() => {});
    await this.reattach();
    if (stderr.trim()) this.list.append(h("div", { class: "chat-note hint" }, stderr.trim().slice(-800)));
    if (!ok) toast(`${t("In the background")}: ${t("The run ended without an answer – its log is on the host in ~/.pibar.")}`, "err");
  }

  // ------------------------------------------------------------------ header, status, scrolling

  refresh() {
    if (this.disposed) return;
    const s = this.session;
    const title = cleanTitle(s.meta.name || s.name || this.target.title) || t("New session");
    this.titleEl.textContent = title;
    const folder = (this.target.cwd || "~").split("/").filter(Boolean).pop() ?? "~";
    const marks = [s.planMode ? t("Plan") : "", s.contextMode === "public" ? t("Public") : ""].filter(Boolean);
    this.subEl.textContent = [this.target.hostName, folder, ...marks].join(" · ");
    this.modelChip.textContent = modelLabel(s);
    this.modelChip.classList.toggle("preset", !!s.presetId);
    this.modelChip.disabled = !s.alive;
    this.list.setMode(s.viewMode());
    this.activity.hidden = !s.streaming;
    if (!s.streaming) this.activity.textContent = "";
    else if (!this.activity.textContent) this.activity.textContent = s.detached ? t("Runs in the background …") : t("Pi is working …");
    this.composer.setState(s.streaming, s.detached, s.background);
    this.composer.setQueue(s.queue.steering, s.queue.followUp);
    renderStatusLine(this.statusLine, s);
    this.questionBar.hidden = !this.questions.length || s.streaming;
    this.questionBar.replaceChildren(
      h("span", {}, t("Pi asks")),
      button(t("Answer"), () => questionDialog(this.questions, (text) => this.send(text, [], "followUp").then(() => {})), "primary"),
    );
    if (this.target.path && state.chat === this.target) rememberChat();
  }

  showUndo(label: string, run: () => Promise<void>) {
    this.undoBar.hidden = false;
    this.undoBar.replaceChildren(
      h("span", {}, label),
      button(t("Undo"), () => {
        this.undoBar.hidden = true;
        void run().catch((e: unknown) => toast(errMsg(e), "err"));
      }),
      button("×", () => (this.undoBar.hidden = true)),
    );
  }

  private onScroll() {
    const m = this.scroller;
    this.stick = m.scrollHeight - m.scrollTop - m.clientHeight < 80;
  }

  scrollDown(force = false) {
    const mode = chatSettings().autoScroll ?? "auto";
    if (force || mode === "always" || (mode === "auto" && this.stick)) this.scroller.scrollTop = this.scroller.scrollHeight;
  }

  // ------------------------------------------------------------------ sending

  async send(text: string, att: FileAttachment[], when: QueueWhen): Promise<boolean> {
    const s = this.session;
    if (!s.alive) {
      toast(t("Pi has stopped."), "err");
      return false;
    }
    const images = att.filter((a) => a.kind === "image").map((a) => ({ data: (a as { data: string }).data, mimeType: a.mimeType }));
    const files = att.filter((a) => a.kind === "text").map((a) => ({ name: a.name, text: (a as { text: string }).text }));
    const message = withFiles(text, files);
    if (!message.trim() && !images.length) return false;
    if (images.length && !s.modelTakesImages()) toast(t("This model may not read images."));
    this.questions = [];
    try {
      if (s.background && !s.streaming && !images.length && s.target.path) {
        const live = s.handle;
        const ok = await s.sendToBackground(message);
        if (ok) {
          socketSend({ type: "unsubscribe", handle: live });
          await this.afterAttach(true);
        }
        return ok;
      }
      const queued = s.streaming;
      await s.send(message, images, when);
      if (queued) toast(when === "steer" ? t("Pi reads it before its next step.") : t("Queued – Pi reads it after the current answer."));
      this.stick = true;
      return true;
    } catch (e) {
      toast(errMsg(e), "err");
      return false;
    } finally {
      this.refresh();
    }
  }

  private async quick(a: QuickAction) {
    await this.send(a.text, [], "followUp");
  }

  private async unqueue() {
    try {
      const items = await this.session.clearQueue();
      if (items.length) this.composer.fill(items.join("\n\n"));
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }

  // ------------------------------------------------------------------ menus

  diagnose(error: string) {
    const m = this.session.model;
    diagnoseDialog(this.target.hostId, this.target.hostName, {
      provider: m?.provider,
      model: m?.id,
      error,
      handle: this.session.alive && !this.session.detached ? this.session.handle : undefined,
    });
  }

  rename() {
    const input = h("input", { type: "text", maxlength: 200 });
    input.value = this.session.meta.name || this.session.name || this.target.title || "";
    const save = () => {
      close();
      void this.session.rename(input.value.trim());
    };
    input.addEventListener("keydown", (e) => e.key === "Enter" && save());
    const close = openModal(t("Rename …"), h("div", { class: "form" }, input), [button(t("Cancel"), () => close()), button(t("Save"), save, "primary")]);
  }

  private details() {
    const row = (label: string, value: string) => h("div", { class: "detail-row" }, h("span", {}, label), h("code", {}, value || "–"));
    const close = openModal(
      this.titleEl.textContent || t("New session"),
      h(
        "div",
        { class: "detail" },
        row(t("Host"), this.target.hostName),
        row(t("Folder"), this.target.cwd),
        row(t("Session file"), this.target.path ?? ""),
        row(t("Session ID"), this.session.sessionId),
        this.session.meta.agentName ? row(t("Agent"), this.session.meta.agentName) : null,
      ),
      [button(t("Close"), () => close(), "primary")],
    );
  }

  private options() {
    optionsSheet(this.session, {
      rename: () => this.rename(),
      newSubagent: () => subagentDialog(this),
      diagnose: () => this.diagnose(""),
      details: () => this.details(),
      stats: () => void statsSheet(this.session),
      newSession: () => startNewSession({ hostId: this.target.hostId, hostName: this.target.hostName, cwd: this.target.cwd }),
      stopBackground: () => void this.session.stopBackground(),
    });
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
    v.start().catch((e: unknown) => v.list.note(errMsg(e), "error"));
  }
  root.replaceChildren(view.el);
}
