// Settings dialog (⚙): language, quick launcher (double tap, shortcut, position) and hosts.
import { emit } from "@tauri-apps/api/event";
import { api, DoubleTapStatus, HostCfg } from "../shared/api";
import { h, errMsg, openModal, toast } from "../shared/dom";
import { LANGUAGES, t } from "../shared/i18n";
import { loadAllSessions, renderHosts } from "./sessions";
import { saveConfig, state } from "./state";

function tapOptions(): [string, string][] {
  return [
    ["off", t("Off")],
    ["option", t("⌥ Option (left or right)")],
    ["rightOption", t("right ⌥ Option")],
    ["command", "⌘ Command"],
    ["rightCommand", t("right ⌘ Command")],
    ["control", "⌃ Control"],
    ["shift", "⇧ Shift"],
  ];
}

function tapStatusText(choice: string, st: DoubleTapStatus | ""): string {
  if (choice === "off") return t("Double tap is off.");
  switch (st) {
    case "active":
      return t("Active. Tap the key twice quickly.");
    case "permission":
      return t(
        "macOS permission missing: System Settings → Privacy & Security → Input Monitoring → enable Terminal (or PiBar), then restart PiBar.",
      );
    case "unsupported":
      return t("Double tap is only available on macOS.");
    case "error":
      return t("Double tap could not be started.");
    default:
      return "";
  }
}

export function settingsDialog() {
  const draft: HostCfg[] = JSON.parse(JSON.stringify(state.config.hosts));
  const list = h("div", {});

  const field = (label: string, input: HTMLElement) => h("div", { class: "row" }, h("label", {}, label), input);
  const text = (host: HostCfg, key: keyof HostCfg, ph = "") => {
    const i = h("input", { type: "text", placeholder: ph, value: String(host[key] ?? "") }) as HTMLInputElement;
    i.addEventListener("input", () => ((host as any)[key] = i.value));
    return i;
  };

  const render = () => {
    list.replaceChildren(
      ...draft.map((host, idx) => {
        const kind = h(
          "select",
          {},
          h("option", { value: "local", selected: host.kind === "local" }, t("Local")),
          h("option", { value: "ssh", selected: host.kind === "ssh" }, "SSH"),
        ) as HTMLSelectElement;
        kind.addEventListener("change", () => {
          host.kind = kind.value as HostCfg["kind"];
          render();
        });
        const port = h("input", { type: "number", placeholder: "22", value: host.sshPort ?? "" }) as HTMLInputElement;
        port.addEventListener("input", () => (host.sshPort = port.value ? Number(port.value) : null));
        const herdr = h("input", { type: "checkbox", checked: host.useHerdr, style: "width:auto" }) as HTMLInputElement;
        herdr.addEventListener("change", () => (host.useHerdr = herdr.checked));
        const result = h("p", { class: "test-result" });
        const test = async () => {
          result.className = "test-result";
          result.textContent = t("Testing … (saves first)");
          state.config.hosts = draft;
          await saveConfig();
          try {
            const v = await api.testHost(host.id);
            result.className = "test-result ok";
            result.textContent = t("Connected. Pi version: {v}", { v });
          } catch (e) {
            result.className = "test-result err";
            result.textContent = errMsg(e);
          }
        };
        return h(
          "div",
          { class: "host-card" },
          h(
            "div",
            { class: "hc-head" },
            h("strong", {}, host.name || t("(unnamed)")),
            h("button", { class: "ghost", onclick: test }, t("Test connection")),
            h("button", { class: "ghost", onclick: () => (draft.splice(idx, 1), render()) }, t("Remove")),
          ),
          field(t("Name"), text(host, "name", "my-server")),
          field(t("Type"), kind),
          host.kind === "ssh"
            ? field(t("SSH host / alias"), text(host, "sshTarget", t("my-server (from ~/.ssh/config)")))
            : null,
          host.kind === "ssh" ? field(t("User"), text(host, "sshUser", t("optional"))) : null,
          host.kind === "ssh" ? field(t("Port"), port) : null,
          field(t("Pi command"), text(host, "piCommand", "pi")),
          field(t("Default folder"), text(host, "defaultDir", "~")),
          host.kind === "ssh"
            ? field(
                t("Use herdr"),
                h("div", {}, herdr, h("span", { class: "muted" }, `  ${t("(prepared, no function yet)")}`)),
              )
            : null,
          result,
        );
      }),
    );
  };
  render();

  const add = () => {
    draft.push({
      id: `host${Date.now()}`,
      name: `Host ${draft.length + 1}`,
      kind: "ssh",
      sshTarget: "",
      sshUser: "",
      sshPort: null,
      piCommand: "pi",
      defaultDir: "~",
      useHerdr: false,
    });
    render();
  };

  const lang = h(
    "select",
    {},
    ...LANGUAGES.map(([v, l]) =>
      h(
        "option",
        { value: v, selected: v === (state.config.ui.language || "auto") },
        v === "auto" ? t("Automatic") : l,
      ),
    ),
  ) as HTMLSelectElement;

  const hotkey = h("input", {
    type: "text",
    value: state.config.ui.quickHotkey || "Alt+Shift+Space",
    placeholder: "Alt+Shift+Space",
  }) as HTMLInputElement;
  const hotkeyHint = h(
    "p",
    { class: "hint" },
    t("Examples: Alt+Shift+Space, CommandOrControl+Shift+K, Control+Alt+P. Alt = ⌥ Option."),
  );

  const curTap = state.config.ui.doubleTap ?? "option";
  const tapSel = h(
    "select",
    {},
    ...tapOptions().map(([v, l]) => h("option", { value: v, selected: v === curTap }, l)),
  ) as HTMLSelectElement;
  const tapStatus = h("p", { class: "hint" }, "");
  const showTapStatus = async () => {
    const st = await api.doubleTapStatus().catch(() => "" as const);
    tapStatus.textContent = tapStatusText(tapSel.value, st);
    tapStatus.style.color = st === "permission" && tapSel.value !== "off" ? "var(--danger)" : "";
  };
  showTapStatus();
  tapSel.addEventListener("change", showTapStatus);

  const save = async () => {
    state.config.hosts = draft;
    state.config.ui.doubleTap = tapSel.value;
    await api.setDoubleTap(tapSel.value).catch(() => {});
    const hk = hotkey.value.trim() || "Alt+Shift+Space";
    try {
      await api.setHotkey(hk);
      state.config.ui.quickHotkey = hk;
    } catch (e) {
      hotkeyHint.textContent = errMsg(e);
      hotkeyHint.style.color = "var(--danger)";
      return;
    }
    const langChanged = (state.config.ui.language || "auto") !== lang.value;
    state.config.ui.language = lang.value;
    await saveConfig();
    close();
    // A new language needs a fresh render of both windows
    if (langChanged) {
      await emit("language-changed").catch(() => {});
      return window.location.reload();
    }
    renderHosts();
    loadAllSessions();
  };

  const close = openModal(
    t("Settings"),
    h(
      "div",
      {},
      h("h4", { class: "set-head" }, t("General")),
      h("div", { class: "row" }, h("label", {}, t("Language")), lang),
      h("h4", { class: "set-head" }, t("Quick launcher")),
      h("div", { class: "row" }, h("label", {}, t("Double tap")), tapSel),
      tapStatus,
      h("div", { class: "row" }, h("label", {}, t("Keyboard shortcut")), hotkey),
      hotkeyHint,
      h(
        "div",
        { class: "row" },
        h("label", {}, t("Bar position")),
        h(
          "div",
          {},
          h(
            "button",
            { class: "ghost", onclick: () => api.quickResetPos().then(() => toast(t("Position reset"))) },
            t("Reset"),
          ),
          h("span", { class: "muted" }, `  ${t("The bar remembers where you drag it.")}`),
        ),
      ),
      h("h4", { class: "set-head" }, t("Hosts")),
      h(
        "p",
        { class: "hint" },
        t("SSH uses your ~/.ssh/config and ssh-agent. Login must work without a password prompt (key)."),
      ),
      list,
      h("button", { class: "ghost", onclick: add }, t("+ Add host")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: save }, t("Save")),
    ],
  );
}
