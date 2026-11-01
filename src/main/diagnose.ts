// Diagnosis dialog for chat errors ("Connection error" and the like): shows the error, what Pi wrote to stderr,
// hints derived from the report and the full report of diag.rs (runs on the host with Pi's rights and environment).
import { api } from "../shared/api";
import { errMsg, h, openModal, toast } from "../shared/dom";
import { Msg, t } from "../shared/i18n";
import { state } from "./state";

/** Plain-language hints for typical causes, derived from the report and the error text */
export function diagnoseHints(report: string, error = ""): Msg[] {
  const all = `${report}\n${error}`;
  const hints: Msg[] = [];
  const local = /https?:\/\/(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.|[^/\s]*\.local\b|[^/\s.]+:\d)/.test(all);
  if (/No route to host|Network is unreachable|EHOSTUNREACH|ENETUNREACH|Operation not permitted/i.test(all) && local)
    hints.push(
      "macOS blocks the local network for PiBar: System Settings → Privacy & Security → Local Network → enable PiBar, then restart PiBar.",
    );
  if (/Could not resolve host|ENOTFOUND|getaddrinfo/i.test(all))
    hints.push(
      "A server name cannot be resolved. Names ending in .local also need the local network permission; otherwise use the IP address.",
    );
  if (/Connection refused|ECONNREFUSED|Couldn't connect to server/i.test(all))
    hints.push("The server refuses the connection: is the model server running, and are address and port right?");
  if (/timed out|ETIMEDOUT|Timeout was reached/i.test(all))
    hints.push("No answer in time: server switched off, wrong address, firewall or VPN.");
  if (/\(NOT SET\)/.test(report))
    hints.push("An API key variable used in models.json is not set in this environment (see Pi configuration).");
  if (/^pi: not found/m.test(report))
    hints.push("Pi is not found in this environment. Enter the full path as Pi command in the host settings.");
  if (/shell environment loaded: 0 variables/.test(report))
    hints.push("PiBar could not read your shell environment; variables from ~/.zshrc are missing for Pi.");
  if (/PROXY=/i.test(report) && local && !/NO_PROXY=/i.test(report))
    hints.push("A proxy is set but NO_PROXY is not: local model servers may be sent through the proxy.");
  if (/certificate|SSL|self.signed|UNABLE_TO_VERIFY/i.test(all))
    hints.push("Certificate problem: for your own certificates set NODE_EXTRA_CA_CERTS.");
  const curlOk = /^curl \S+ -> .*HTTP [1-5]\d\d/m.test(report);
  const nodeFails = /^node \S+ -> (?!HTTP)/m.test(report);
  if (curlOk && nodeFails)
    hints.push(
      "curl reaches the server but Node (which Pi uses) does not – see the node line and its cause in the report.",
    );
  if (/ECONNREFUSED ::1|connect ECONNREFUSED ::1/.test(all))
    hints.push("localhost resolves to IPv6 (::1) where the server does not listen: use 127.0.0.1 in the base URL.");
  if (/HTTP 401|HTTP 403|invalid.*api.?key|Unauthorized/i.test(all))
    hints.push("The server answers but rejects the login: check the API key.");
  return hints;
}

/**
 * Run the diagnosis for a host and show it. `ctx` = the failing session: its model, error text and Pi process
 * (for Pi's stderr).
 */
export function diagnoseDialog(
  hostId: string,
  ctx: { provider?: string; model?: string; error?: string; handle?: number } = {},
) {
  const body = h("div", { class: "diag" }, h("p", { class: "muted" }, t("Running diagnosis …")));
  let text = "";
  const copy = h("button", { class: "ghost", disabled: true }, t("Copy report"));
  copy.addEventListener("click", () =>
    navigator.clipboard.writeText(text).then(
      () => toast(t("Copied")),
      (e) => toast(errMsg(e), "err"),
    ),
  );
  const close = openModal(t("Diagnosis"), body, [
    copy,
    h("button", { class: "primary", onclick: () => close() }, t("Close")),
  ]);

  (async () => {
    const host = state.config.hosts.find((x) => x.id === hostId);
    const [report, stderr] = await Promise.all([
      api.diagnose(hostId, ctx.provider ?? "", ctx.model ?? "").catch((e) => `Diagnosis failed: ${errMsg(e)}`),
      ctx.handle ? api.piStderr(ctx.handle).catch(() => "") : Promise.resolve(""),
    ]);
    const hints = diagnoseHints(report, `${ctx.error ?? ""}\n${stderr}`);
    text = [
      `PiBar diagnosis – ${host?.name ?? hostId}`,
      ctx.error ? `\n== Error\n${ctx.error}` : "",
      stderr.trim() ? `\n== Pi stderr (last lines)\n${stderr.trim()}` : "",
      `\n${report}`,
    ].join("\n");
    copy.disabled = false;
    const parts: (HTMLElement | null)[] = [
      hints.length
        ? h(
            "div",
            { class: "diag-hints" },
            h("div", { class: "sub-head" }, t("Likely causes")),
            h("ul", {}, ...hints.map((m) => h("li", {}, t(m)))),
          )
        : h("p", { class: "muted" }, t("No obvious cause found – see the report below.")),
      ctx.error ? h("div", { class: "sub-head" }, t("Error")) : null,
      ctx.error ? h("pre", { class: "diag-pre" }, ctx.error) : null,
      stderr.trim() ? h("div", { class: "sub-head" }, t("Pi's error output")) : null,
      stderr.trim() ? h("pre", { class: "diag-pre" }, stderr.trim()) : null,
      h("div", { class: "sub-head" }, t("Report")),
      h("pre", { class: "diag-pre" }, report),
    ];
    body.replaceChildren(...parts.filter((x): x is HTMLElement => !!x));
  })();
}
