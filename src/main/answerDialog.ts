// Dialogs for questions to the user:
// - choice questions at the end of an answer (found by src/shared/questions.ts): options to tick, always an own answer
// - Pi's own dialogs (RPC extension UI: select, confirm, input, editor); Pi waits until they are answered
import { api } from "../shared/api";
import { errMsg, h, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import type { UiRequest } from "../shared/piProtocol";
import { composeAnswer, type QuestionGroup } from "../shared/questions";
import type { SessionTab } from "./sessionTab";

let questionsOpen = false;

/** Answer choice questions: tick options, add an own answer, send it as the next message */
export function questionDialog(groups: QuestionGroup[], send: (text: string) => Promise<void>) {
  if (questionsOpen || !groups.length) return;
  questionsOpen = true;
  const fields = groups.map((g, gi) => {
    const boxes = g.options.map((o) => {
      const c = h("input", { type: "checkbox", value: o }) as HTMLInputElement;
      c.addEventListener("change", update);
      return c;
    });
    const own = h("textarea", {
      class: "q-own",
      rows: 2,
      placeholder: t("Own answer …"),
    }) as HTMLTextAreaElement;
    own.addEventListener("input", update);
    const el = h(
      "fieldset",
      { class: "q-group" },
      h("legend", {}, groups.length > 1 ? `${gi + 1}. ${g.question}` : g.question),
      ...boxes.map((c) => h("label", { class: "check q-option" }, c, h("span", {}, c.value))),
      own,
    );
    return { el, boxes, own };
  });
  const answer = () =>
    composeAnswer(
      groups,
      fields.map((f) => ({ checked: f.boxes.filter((c) => c.checked).map((c) => c.value), own: f.own.value })),
    );
  const sendBtn = h("button", { class: "primary", disabled: true, onclick: submit }, t("Send answer"));
  function update() {
    (sendBtn as HTMLButtonElement).disabled = !answer();
  }
  async function submit() {
    const text = answer();
    if (!text) return;
    close();
    try {
      await send(text);
    } catch (e) {
      toast(errMsg(e), "err");
    }
  }
  const body = h(
    "div",
    {
      class: "q-dialog",
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
          e.preventDefault();
          submit();
        }
      },
    },
    h("p", { class: "hint" }, t("Tick one or more answers or write your own. ⌘Enter sends.")),
    ...fields.map((f) => f.el),
  );
  const close = openModal(
    t("Pi asks"),
    body,
    [h("button", { class: "ghost", onclick: () => close() }, t("Later")), sendBtn],
    () => (questionsOpen = false),
  );
}

/** A dialog or notice from a Pi extension. Dialogs must be answered (or cancelled), Pi waits for it. */
export function uiRequest(tab: SessionTab, req: UiRequest, fillInput: (text: string) => void) {
  const reply = (msg: { value?: string; confirmed?: boolean; cancelled?: boolean }) =>
    api.piReply(tab.handle, { id: req.id, ...msg }).catch((e) => toast(errMsg(e), "err"));
  switch (req.method) {
    case "notify":
      toast(req.message ?? "", req.notifyType === "error" ? "err" : "info");
      return;
    case "set_editor_text":
      if (req.text !== undefined) fillInput(req.text);
      return;
    case "select":
    case "confirm":
    case "input":
    case "editor":
      break;
    default:
      return; // status line, widgets, title: nothing to show in PiBar
  }
  let answered = false;
  const done = (msg: { value?: string; confirmed?: boolean; cancelled?: boolean }) => {
    answered = true;
    close();
    void reply(msg);
  };
  const children: (HTMLElement | null)[] = [req.message ? h("p", {}, req.message) : null];
  const actions: HTMLElement[] = [];
  const cancel = h("button", { class: "ghost", onclick: () => close() }, t("Cancel"));
  if (req.method === "confirm") {
    actions.push(
      cancel,
      h("button", { class: "ghost", onclick: () => done({ confirmed: false }) }, t("No")),
      h("button", { class: "primary", onclick: () => done({ confirmed: true }) }, t("Yes")),
    );
  } else if (req.method === "select") {
    // one choice (Pi expects one value) – or an own answer instead
    const name = `sel-${req.id}`;
    const radios = (req.options ?? []).map((o) => h("input", { type: "radio", name, value: o }) as HTMLInputElement);
    const own = h("input", { type: "text", class: "q-own", placeholder: t("Own answer …") }) as HTMLInputElement;
    own.addEventListener("input", () => own.value && radios.forEach((r) => (r.checked = false)));
    radios.forEach((r) => r.addEventListener("change", () => (own.value = "")));
    const ok = () => {
      const v = own.value.trim() || radios.find((r) => r.checked)?.value;
      if (v) done({ value: v });
    };
    own.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    children.push(
      h(
        "fieldset",
        { class: "q-group" },
        ...radios.map((r) => h("label", { class: "check q-option" }, r, h("span", {}, r.value))),
        own,
      ),
    );
    actions.push(cancel, h("button", { class: "primary", onclick: ok }, t("Send answer")));
  } else {
    const field =
      req.method === "editor"
        ? (h("textarea", { class: "q-own", rows: 8 }, req.prefill ?? "") as HTMLTextAreaElement)
        : (h("input", { type: "text", class: "q-own", placeholder: req.placeholder ?? "" }) as HTMLInputElement);
    const ok = () => done({ value: field.value });
    if (field instanceof HTMLInputElement) field.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    children.push(field);
    actions.push(cancel, h("button", { class: "primary", onclick: ok }, t("Send answer")));
  }
  const close = openModal(req.title || t("Pi asks"), h("div", { class: "q-dialog" }, ...children), actions, () => {
    clearTimeout(timer);
    if (!answered) void reply({ cancelled: true });
  });
  // Pi answers by itself after the timeout: close the dialog then (without a second answer)
  const timer = req.timeout
    ? window.setTimeout(() => {
        answered = true;
        close();
      }, req.timeout)
    : 0;
}
