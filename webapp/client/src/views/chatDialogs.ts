// Dialogs of the chat as bottom sheets: Pi's own dialogs (RPC extension UI select/confirm/input/editor, with Pi's
// timeout), choice questions at the end of an answer (src/shared/questions.ts) and the diagnosis of a failing session
// (diagnose command + hints, like src/main/answerDialog.ts and src/main/diagnose.ts).
import { api } from "@shared/api";
import { copyText, errMsg, h, openModal, toast } from "@shared/dom";
import { t, type Msg } from "@shared/i18n";
import { isStaleInstallError } from "@shared/piErrors";
import type { UiRequest } from "@shared/piProtocol";
import { composeAnswer, type QuestionGroup } from "@shared/questions";
import { button } from "../ui";

type Reply = { value?: string; confirmed?: boolean; cancelled?: boolean };

/** A dialog or notice from a Pi extension; dialogs must be answered (or cancelled), Pi waits for it */
export function uiRequest(handle: number, req: UiRequest, fillInput: (text: string) => void) {
  const reply = (msg: Reply) => api.piReply(handle, { id: req.id, ...msg }).catch((e: unknown) => toast(errMsg(e), "err"));
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
      return; // status line, widgets, title: nothing to show here
  }
  let answered = false;
  const done = (msg: Reply) => {
    answered = true;
    close();
    void reply(msg);
  };
  const children: (HTMLElement | null)[] = [req.message ? h("p", {}, req.message) : null];
  const actions: HTMLElement[] = [];
  const cancel = button(t("Cancel"), () => close());
  if (req.method === "confirm") {
    actions.push(cancel, button(t("No"), () => done({ confirmed: false })), button(t("Yes"), () => done({ confirmed: true }), "primary"));
  } else if (req.method === "select") {
    // one tap answers; an own answer instead is possible below the options
    const own = h("input", { type: "text", class: "q-own", placeholder: t("Own answer …") });
    children.push(
      h("div", { class: "q-options" }, ...(req.options ?? []).map((o) => button(o, () => done({ value: o }), "q-option"))),
      own,
    );
    const ok = () => {
      const v = own.value.trim();
      if (v) done({ value: v });
    };
    own.addEventListener("keydown", (e) => e.key === "Enter" && ok());
    actions.push(cancel, button(t("Send answer"), ok, "primary"));
  } else {
    const field =
      req.method === "editor"
        ? h("textarea", { class: "q-own", rows: 8 })
        : h("input", { type: "text", class: "q-own", placeholder: req.placeholder ?? "" });
    field.value = req.prefill ?? "";
    children.push(field);
    actions.push(cancel, button(t("Send answer"), () => done({ value: field.value }), "primary"));
  }
  const timer = req.timeout
    ? window.setTimeout(() => {
        // Pi answers by itself after its timeout: close the sheet without a second answer
        answered = true;
        close();
        toast(t("Pi did not wait any longer for the answer."));
      }, req.timeout)
    : 0;
  const close = openModal(req.title || t("Pi asks"), h("div", { class: "q-dialog" }, ...children), actions, () => {
    clearTimeout(timer);
    if (!answered) void reply({ cancelled: true });
  });
}

let questionsOpen = false;

/** Choice questions at the end of an answer: tick options, add an own answer, send it as the next message */
export function questionDialog(groups: QuestionGroup[], send: (text: string) => Promise<void>) {
  if (questionsOpen || !groups.length) return;
  questionsOpen = true;
  const fields = groups.map((g, gi) => {
    const boxes = g.options.map((o) => {
      const c = h("input", { type: "checkbox", value: o });
      c.addEventListener("change", update);
      return c;
    });
    const own = h("textarea", { class: "q-own", rows: 2, placeholder: t("Own answer …") });
    own.addEventListener("input", update);
    const el = h(
      "fieldset",
      { class: "q-group" },
      h("legend", {}, groups.length > 1 ? `${gi + 1}. ${g.question}` : g.question),
      ...boxes.map((c) => h("label", { class: "q-check" }, c, h("span", {}, c.value))),
      own,
    );
    return { el, boxes, own };
  });
  const answer = () =>
    composeAnswer(
      groups,
      fields.map((f) => ({ checked: f.boxes.filter((c) => c.checked).map((c) => c.value), own: f.own.value })),
    );
  const sendBtn = button(t("Send answer"), () => void submit(), "primary");
  sendBtn.disabled = true;
  function update() {
    sendBtn.disabled = !answer();
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
  const close = openModal(
    t("Pi asks"),
    h("div", { class: "q-dialog" }, h("p", { class: "muted" }, t("Tick one or more answers or write your own.")), ...fields.map((f) => f.el)),
    [button(t("Later"), () => close()), sendBtn],
    () => (questionsOpen = false),
  );
}

/** Plain-language hints for typical causes (src/main/diagnose.ts diagnoseHints, without the macOS-only ones) */
export function diagnoseHints(report: string, error = ""): Msg[] {
  const all = `${report}\n${error}`;
  const hints: Msg[] = [];
  const local = /https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|[^/\s]*\.local\b|[^/\s.]+:\d)/.test(all);
  if (/Could not resolve host|ENOTFOUND|getaddrinfo/i.test(all))
    hints.push(
      "A server name cannot be resolved. Names ending in .local also need the local network permission; otherwise use the IP address.",
    );
  if (/connect ECONNREFUSED (?!127\.0\.0\.1|::1)[\d[]/.test(all))
    hints.push("The server refuses the connection: is the model server running, and are address and port right?");
  if (/timed out|ETIMEDOUT|Timeout was reached/i.test(all)) hints.push("No answer in time: server switched off, wrong address, firewall or VPN.");
  if (isStaleInstallError(all))
    hints.push("Pi was updated or removed on the host while this session was running. Restart the session; the history stays.");
  if (/\(NOT SET\)/.test(report))
    hints.push("An API key variable used in models.json is not set in this environment (see Pi configuration).");
  if (/^pi: not found/m.test(report))
    hints.push("Pi is not found in this environment. Enter the full path as Pi command in the host settings.");
  if (/PROXY=/i.test(report) && local && !/NO_PROXY=/i.test(report))
    hints.push("A proxy is set but NO_PROXY is not: local model servers may be sent through the proxy.");
  if (/certificate|SSL|self.signed|UNABLE_TO_VERIFY/i.test(all))
    hints.push("Certificate problem: for your own certificates set NODE_EXTRA_CA_CERTS.");
  const curlOk = new Set([...report.matchAll(/^curl (\S+) -> .*HTTP [1-5]\d\d/gm)].map((m) => m[1]));
  if ([...report.matchAll(/^node (\S+) -> (?!HTTP)/gm)].some((m) => curlOk.has(m[1])))
    hints.push("curl reaches the server but Node (which Pi uses) does not – see the node line and its cause in the report.");
  if (/ECONNREFUSED ::1/.test(all))
    hints.push("localhost resolves to IPv6 (::1) where the server does not listen: use 127.0.0.1 in the base URL.");
  if (/HTTP 401|HTTP 403|invalid.*api.?key|Unauthorized/i.test(all)) hints.push("The server answers but rejects the login: check the API key.");
  return hints;
}

/** Run the diagnosis for a host and show it; `ctx` = the failing session (model, error, Pi process for stderr) */
export function diagnoseDialog(hostId: string, hostName: string, ctx: { provider?: string; model?: string; error?: string; handle?: number } = {}) {
  const body = h("div", { class: "diag" }, h("p", { class: "muted chat-note loading" }, t("Running diagnosis …")));
  let text = "";
  const copy = button(t("Copy report (still running …)"), () =>
    copyText(text).then(
      () => toast(t("Copied")),
      (e: unknown) => toast(errMsg(e), "err"),
    ),
  );
  copy.disabled = true;
  const close = openModal(t("Diagnosis"), body, [copy, button(t("Close"), () => close(), "primary")]);
  void (async () => {
    const [report, stderr] = await Promise.all([
      api.diagnose(hostId, ctx.provider ?? "", ctx.model ?? "").catch((e: unknown) => `Diagnosis failed: ${errMsg(e)}`),
      ctx.handle ? api.piStderr(ctx.handle).catch(() => "") : Promise.resolve(""),
    ]);
    const hints = diagnoseHints(report, `${ctx.error ?? ""}\n${stderr}`);
    text = [
      `PiBar diagnosis – ${hostName}`,
      ctx.error ? `\n== Error\n${ctx.error}` : "",
      stderr.trim() ? `\n== Pi stderr (last lines)\n${stderr.trim()}` : "",
      `\n${report}`,
    ].join("\n");
    copy.disabled = false;
    copy.textContent = t("Copy report");
    const parts: (HTMLElement | null)[] = [
      hints.length
        ? h("div", { class: "diag-hints" }, h("h4", {}, t("Likely causes")), h("ul", {}, ...hints.map((m) => h("li", {}, t(m)))))
        : h("p", { class: "muted" }, t("No obvious cause found – see the report below.")),
      ctx.error ? h("h4", {}, t("Error")) : null,
      ctx.error ? h("pre", { class: "diag-pre" }, ctx.error) : null,
      stderr.trim() ? h("h4", {}, t("Pi's error output")) : null,
      stderr.trim() ? h("pre", { class: "diag-pre" }, stderr.trim()) : null,
      h("h4", {}, t("Report")),
      h("pre", { class: "diag-pre" }, report),
    ];
    body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  })();
}
