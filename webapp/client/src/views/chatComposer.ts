// The input area of the chat: quick action bar (shared settings, kind "command"), attachments as chips (photos and
// camera as prompt images, text files inlined with withFiles – like src/main/composerTools.ts), the "/" menu of Pi's
// commands and skills (src/main/slashMenu.ts), the growing text field, dictation (voiceInput.ts), send/stop, and the
// queue of messages waiting while Pi works with the choice "after the answer" or "right away" (steer).
import type { PiCommand, QuickAction } from "@shared/api";
import { readAttachment, type FileAttachment } from "@shared/attach";
import { errMsg, h, toast } from "@shared/dom";
import { t } from "@shared/i18n";
import { createDictationButton, createImproveButton } from "../voiceInput";
import type { QueueWhen } from "./chatSession";

export interface ComposerCallbacks {
  /** Send; false = nothing was sent (text and attachments stay) */
  send(text: string, attachments: FileAttachment[], when: QueueWhen): Promise<boolean>;
  abort(): void;
  commands(): PiCommand[];
  /** Take the queued messages back into the input */
  unqueue(): void;
  /** A quick action was tapped (sent like a message) */
  quick(a: QuickAction): void;
}

/** Text to type for a command; Pi calls skills as /skill:name (slashMenu.ts commandText) */
export function commandText(c: PiCommand): string {
  return c.source === "skill" && !c.name.startsWith("skill:") ? `skill:${c.name}` : c.name;
}

const ORDER = ["skill", "prompt", "extension"];

export class Composer {
  readonly el: HTMLElement;
  readonly input: HTMLTextAreaElement;
  private readonly sendBtn: HTMLButtonElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly chips: HTMLElement;
  private readonly quickBar: HTMLElement;
  private readonly queueBox: HTMLElement;
  private readonly slash: HTMLElement;
  private readonly bgChip: HTMLElement;
  private attachments: FileAttachment[] = [];
  private streaming = false;
  private when: QueueWhen = "followUp";
  private queue: string[] = [];

  constructor(private readonly cb: ComposerCallbacks) {
    this.input = h("textarea", {
      rows: 1,
      placeholder: t("Message to Pi"),
      "aria-label": t("Message to Pi"),
      oninput: () => this.onInput(),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          void this.submit();
        } else if (e.key === "Escape") this.slash.hidden = true;
      },
      onblur: () => setTimeout(() => (this.slash.hidden = true), 200),
    });
    this.sendBtn = h("button", { class: "send-btn", type: "button", "aria-label": t("Send"), onclick: () => void this.submit() }, "↑");
    this.stopBtn = h("button", { class: "stop-btn", type: "button", "aria-label": t("Stop"), hidden: true, onclick: () => this.cb.abort() }, "■");
    const files = h("input", { type: "file", multiple: true, hidden: true, onchange: () => void this.addFiles(files) });
    const photos = h("input", { type: "file", accept: "image/*", multiple: true, hidden: true, onchange: () => void this.addFiles(photos) });
    const camera = h("input", { type: "file", accept: "image/*", capture: "environment", hidden: true, onchange: () => void this.addFiles(camera) });
    const attachMenu = h(
      "div",
      { class: "attach-menu", hidden: true },
      h("button", { type: "button", onclick: () => this.pick(camera) }, `📷 ${t("Camera")}`),
      h("button", { type: "button", onclick: () => this.pick(photos) }, `🖼 ${t("Photos")}`),
      h("button", { type: "button", onclick: () => this.pick(files) }, `📄 ${t("Text file")}`),
      h("button", { type: "button", onclick: () => this.openSlash(true) }, `/ ${t("Commands and skills")}`),
    );
    const plus = h(
      "button",
      {
        class: "icon-btn plus-btn",
        type: "button",
        "aria-label": t("Attach"),
        "aria-expanded": "false",
        onclick: () => {
          attachMenu.hidden = !attachMenu.hidden;
          plus.setAttribute("aria-expanded", String(!attachMenu.hidden));
        },
      },
      "+",
    );
    document.addEventListener("click", (e) => {
      if (!attachMenu.hidden && !attachMenu.contains(e.target as Node) && e.target !== plus) {
        attachMenu.hidden = true;
        plus.setAttribute("aria-expanded", "false");
      }
    });
    this.chips = h("div", { class: "chips", hidden: true });
    this.quickBar = h("div", { class: "quick-bar", hidden: true });
    this.queueBox = h("div", { class: "queue-box", hidden: true });
    this.slash = h("div", { class: "slash-menu", hidden: true, role: "listbox" });
    this.bgChip = h("div", { class: "bg-chip", hidden: true }, `☁ ${t("In the background")}`);
    const mic = createDictationButton((text) => this.insert(text));
    const improve = createImproveButton(this.input);
    this.el = h(
      "div",
      { class: "composer-wrap" },
      this.slash,
      this.queueBox,
      this.quickBar,
      this.chips,
      h("div", { class: "composer" }, plus, attachMenu, files, photos, camera, this.input, improve, mic, this.bgChip, this.stopBtn, this.sendBtn),
    );
  }

  private pick(input: HTMLInputElement) {
    (this.el.querySelector(".attach-menu") as HTMLElement).hidden = true;
    input.click();
  }

  private async addFiles(input: HTMLInputElement) {
    for (const f of Array.from(input.files ?? [])) {
      try {
        this.attachments.push(await readAttachment(f));
      } catch (e) {
        toast(`${f.name}: ${errMsg(e)}`, "err");
      }
    }
    input.value = "";
    this.renderChips();
  }

  private renderChips() {
    this.chips.hidden = !this.attachments.length;
    this.chips.replaceChildren(
      ...this.attachments.map((a, i) =>
        h(
          "span",
          { class: "chip" },
          a.kind === "image" ? h("img", { class: "chip-thumb", alt: "", src: `data:${a.mimeType};base64,${a.data}` }) : h("span", {}, "📄"),
          h("span", { class: "chip-name" }, a.name),
          h(
            "button",
            {
              type: "button",
              class: "chip-x",
              "aria-label": t("Remove"),
              onclick: () => {
                this.attachments.splice(i, 1);
                this.renderChips();
              },
            },
            "×",
          ),
        ),
      ),
    );
  }

  setQuickActions(list: QuickAction[]) {
    this.quickBar.hidden = !list.length;
    this.quickBar.replaceChildren(...list.map((a) => h("button", { type: "button", class: "quick-btn", title: a.text, onclick: () => this.cb.quick(a) }, a.name)));
  }

  setState(streaming: boolean, detached: boolean, background: boolean) {
    this.streaming = streaming;
    this.stopBtn.hidden = !streaming;
    this.bgChip.hidden = !background || streaming;
    this.sendBtn.disabled = detached;
    this.input.placeholder = detached ? t("Runs in the background …") : streaming ? t("Message while Pi works") : t("Message to Pi");
    this.renderQueue();
  }

  setQueue(steering: string[], followUp: string[]) {
    this.queue = [...steering.map((s) => `⇢ ${s}`), ...followUp];
    this.renderQueue();
  }

  private renderQueue() {
    const show = this.streaming && (this.queue.length > 0 || this.input.value.trim() !== "");
    this.queueBox.hidden = !show;
    if (!show) return;
    const seg = h(
      "div",
      { class: "seg small", role: "group", "aria-label": t("When Pi reads it") },
      h("button", { type: "button", class: this.when === "followUp" ? "on" : "", onclick: () => this.setWhen("followUp") }, t("After the answer")),
      h("button", { type: "button", class: this.when === "steer" ? "on" : "", onclick: () => this.setWhen("steer") }, t("Right away")),
    );
    const items = this.queue.map((q) => h("div", { class: "queue-item" }, q.length > 120 ? `${q.slice(0, 120)} …` : q));
    this.queueBox.replaceChildren(
      seg,
      ...(items.length
        ? [h("div", { class: "queue-head" }, t("Waiting ({n})", { n: items.length }), h("button", { type: "button", class: "link-btn", onclick: () => this.cb.unqueue() }, t("Back into the input"))), ...items]
        : []),
    );
  }

  private setWhen(w: QueueWhen) {
    this.when = w;
    this.renderQueue();
  }

  /** Put text into the input (reuse, dialogs, dictation) */
  fill(text: string) {
    this.input.value = text;
    this.onInput();
    this.input.focus();
  }

  insert(text: string) {
    const v = this.input.value;
    this.fill(v ? `${v}${v.endsWith(" ") || v.endsWith("\n") ? "" : " "}${text}` : text);
  }

  private onInput() {
    this.input.style.height = "auto";
    // an empty field keeps its one-line height (a long placeholder must not grow it)
    if (this.input.value) this.input.style.height = `${Math.min(this.input.scrollHeight, 200)}px`;
    if (/^\/\S*$/.test(this.input.value)) this.openSlash(false);
    else this.slash.hidden = true;
    if (this.streaming) this.renderQueue();
  }

  private openSlash(fromMenu: boolean) {
    (this.el.querySelector(".attach-menu") as HTMLElement).hidden = true;
    if (fromMenu && !this.input.value.startsWith("/")) this.input.value = "/";
    const query = this.input.value.slice(1).toLowerCase();
    const all = this.cb.commands();
    const items = all
      .filter((c) => !query || commandText(c).toLowerCase().includes(query) || c.description?.toLowerCase().includes(query))
      .sort((a, b) => ORDER.indexOf(a.source ?? "") - ORDER.indexOf(b.source ?? "") || commandText(a).localeCompare(commandText(b)))
      .slice(0, 60);
    const label = (s?: string) => (s === "skill" ? t("Skills") : s === "prompt" ? t("Prompt templates") : t("Commands"));
    const rows: HTMLElement[] = [];
    let group = "";
    for (const c of items) {
      const g = label(c.source);
      if (g !== group) {
        group = g;
        rows.push(h("div", { class: "slash-group" }, g));
      }
      rows.push(
        h(
          "button",
          {
            type: "button",
            class: "slash-item",
            role: "option",
            onmousedown: (e: MouseEvent) => e.preventDefault(),
            onclick: () => {
              this.slash.hidden = true;
              this.fill(`/${commandText(c)} `);
            },
          },
          h("span", { class: "slash-name" }, `/${commandText(c)}`),
          c.description ? h("span", { class: "slash-desc" }, c.description) : null,
        ),
      );
    }
    if (!rows.length) rows.push(h("div", { class: "slash-empty" }, all.length ? t("No match") : t("This session has no skills or commands.")));
    this.slash.replaceChildren(...rows);
    this.slash.hidden = false;
    if (fromMenu) this.input.focus();
  }

  private async submit() {
    const text = this.input.value.trim();
    if (!text && !this.attachments.length) return;
    this.sendBtn.disabled = true;
    try {
      const ok = await this.cb.send(text, this.attachments, this.when);
      if (ok) {
        this.input.value = "";
        this.attachments = [];
        this.renderChips();
        this.onInput();
      }
    } finally {
      this.sendBtn.disabled = false;
    }
  }
}
