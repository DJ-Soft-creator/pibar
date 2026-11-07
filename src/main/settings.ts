// Settings dialog (gear icon): language, colour scheme, quick launcher, voice (double tap, shortcut, position), model presets and hosts.
import { getVersion } from "@tauri-apps/api/app";
import { emit } from "@tauri-apps/api/event";
import { api, ChatMode, DoubleTapStatus, HostCfg, ModelPreset, SessionPreset, Theme } from "../shared/api";
import { h, errMsg, openModal, toast, type KeysWith } from "../shared/dom";
import { thinkingLabel, THINKING_LEVELS } from "../shared/format";
import { LANGUAGES, t, type Msg } from "../shared/i18n";
import { scaleLabel } from "../shared/textScale";
import { cleanPresets } from "../shared/presets";
import { VIEWS } from "../shared/chatViews";
import { applyUiPrefs, defaultLabel, renderToolbar, setTheme } from "./chatView";
import { renderFiles } from "./files";
import { setFontScale, stepFontScale } from "./layout";
import { scrollMode, type ScrollMode } from "./autoScroll";
import { defaultViewMode } from "./sessionTab";
import { loadAllSessions, renderHosts } from "./sessions";
import { saveConfig, state } from "./state";
import { colorEditor } from "./colorSettings";
import { applyChatColors } from "./colors";
import { voiceEditor } from "./voiceSettings";
import { diagnoseDialog } from "./diagnose";

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
        "macOS permission missing: System Settings → Privacy & Security → Input Monitoring → enable PiBar (in development mode: the terminal). If it is already on: remove it (−), add it again, restart PiBar.",
      );
    case "unsupported":
      return t("Double tap is only available on macOS.");
    case "error":
      return t("Double tap could not be started.");
    default:
      return "";
  }
}

/** Editor for model presets; returns the element and a getter for the cleaned list */
function presetEditor(): { el: HTMLElement; get: () => ModelPreset[] } {
  const draft: ModelPreset[] = JSON.parse(JSON.stringify(state.config.presets ?? []));
  const list = h("div", { class: "preset-list" });
  // Model suggestions: models of open sessions right away, all hosts in the background
  const models = h("datalist", { id: "preset-models" });
  const known = new Set<string>();
  const addModels = (keys: string[]) => {
    for (const k of keys) {
      if (known.has(k)) continue;
      known.add(k);
      models.append(h("option", { value: k }));
    }
  };
  for (const tab of state.tabs.values()) addModels(tab.models.map((m) => `${m.provider}/${m.id}`));
  for (const host of state.config.hosts)
    api
      .listModels(host.id)
      .then((l) => addModels(l.map((m) => `${m.provider}/${m.id}`)))
      .catch(() => {});

  const render = () => {
    list.replaceChildren(
      ...draft.map((p, idx) => {
        const name = h("input", { type: "text", value: p.name, placeholder: t("Name") }) as HTMLInputElement;
        name.addEventListener("input", () => (p.name = name.value));
        const model = h("input", {
          type: "text",
          value: p.model,
          placeholder: t("Model: keep"),
          list: "preset-models",
        }) as HTMLInputElement;
        model.addEventListener("input", () => (p.model = model.value));
        const thinking = h(
          "select",
          {},
          h("option", { value: "", selected: !p.thinking }, t("Thinking: keep")),
          ...THINKING_LEVELS.map((l) => h("option", { value: l, selected: l === p.thinking }, thinkingLabel(l))),
        ) as HTMLSelectElement;
        thinking.addEventListener("change", () => (p.thinking = thinking.value));
        const remove = h("button", { class: "ghost", title: t("Remove") }, "×");
        remove.addEventListener("click", () => (draft.splice(idx, 1), render()));
        return h("div", { class: "preset-row" }, name, model, thinking, remove);
      }),
    );
  };
  render();

  const add = (model = "", thinking = "") => {
    draft.push({ id: `preset${Date.now()}`, name: "", model, thinking });
    render();
    list.querySelector<HTMLInputElement>(".preset-row:last-child input")?.focus();
  };
  const cur = state.active;
  const el = h(
    "div",
    {},
    h(
      "p",
      { class: "hint" },
      t(
        "Quick choice of model and thinking level in the toolbar and the quick bar. Choosing a preset hides the other two dropdowns.",
      ),
    ),
    list,
    models,
    h(
      "div",
      { class: "preset-actions" },
      h("button", { class: "ghost", onclick: () => add() }, t("+ Add preset")),
      cur?.model
        ? h(
            "button",
            { class: "ghost", onclick: () => add(`${cur.model!.provider}/${cur.model!.id}`, cur.thinkingLevel) },
            t("+ From current session"),
          )
        : null,
    ),
  );
  return { el, get: () => cleanPresets(draft) };
}

/** Section shown last in the settings dialog (kept while PiBar runs, so reopening lands where you left off) */
let lastSection = 0;

export function settingsDialog() {
  const draft: HostCfg[] = JSON.parse(JSON.stringify(state.config.hosts));
  const list = h("div", {});
  // profiles are edited here and picked per host below, so a change re-renders the host cards
  const colors = colorEditor(() => render());

  const field = (label: string, input: HTMLElement) => h("div", { class: "row" }, h("label", {}, label), input);
  /** Colour profile of a host; "Theme colours" = the profile from the colour section (or none) */
  const profileSelect = (host: HostCfg) => {
    const sel = h(
      "select",
      {},
      h("option", { value: "", selected: !host.colorProfile }, t("Theme colours")),
      ...colors.get().map((p) => h("option", { value: p.id, selected: host.colorProfile === p.id }, p.name)),
    ) as HTMLSelectElement;
    sel.addEventListener("change", () => (host.colorProfile = sel.value));
    return sel;
  };
  const text = (host: HostCfg, key: KeysWith<HostCfg, string>, ph = "") => {
    const i = h("input", { type: "text", placeholder: ph, value: String(host[key] ?? "") }) as HTMLInputElement;
    i.addEventListener("input", () => (host[key] = i.value));
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
            h(
              "button",
              {
                class: "ghost",
                onclick: async () => {
                  state.config.hosts = draft;
                  await saveConfig();
                  diagnoseDialog(host.id);
                },
              },
              t("Diagnose"),
            ),
            h("button", { class: "ghost", onclick: () => (draft.splice(idx, 1), render()) }, t("Remove")),
          ),
          field(t("Name"), text(host, "name", "my-server")),
          field(t("Type"), kind),
          host.kind === "ssh"
            ? field(t("SSH host / alias"), text(host, "sshTarget", t("my-server (from ~/.ssh/config)")))
            : null,
          host.kind === "ssh" ? field(t("User"), text(host, "sshUser", t("optional"))) : null,
          host.kind === "ssh" ? field(t("Port"), port) : null,
          field(t("Colour profile"), profileSelect(host)),
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
      colorProfile: "",
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

  const curTheme = state.config.ui.theme ?? "auto";
  const theme = h(
    "select",
    {},
    h("option", { value: "auto", selected: curTheme === "auto" }, t("Automatic (system)")),
    h("option", { value: "light", selected: curTheme === "light" }, t("Light")),
    h("option", { value: "dark", selected: curTheme === "dark" }, t("Dark")),
  ) as HTMLSelectElement;

  // Default for new sessions: Pi's default, a preset, the current default model or the active session's model
  const ui0 = state.config.ui;
  const curDefault = ui0.defaultPreset
    ? `preset:${ui0.defaultPreset}`
    : ui0.defaultModel
      ? `model:${ui0.defaultModel}|${ui0.defaultThinking ?? ""}`
      : "";
  const act = state.active;
  const actKey = act?.model ? `model:${act.model.provider}/${act.model.id}|${act.thinkingLevel}` : "";
  const defOpts: [string, string][] = [["", t("Pi's default")]];
  for (const p of state.config.presets ?? []) defOpts.push([`preset:${p.id}`, `${t("Preset")}: ${p.name}`]);
  if (curDefault.startsWith("model:")) defOpts.push([curDefault, defaultLabel()]);
  if (actKey && actKey !== curDefault)
    defOpts.push([
      actKey,
      `${t("Current session")}: ${act!.model!.provider}/${act!.model!.id} · ${thinkingLabel(act!.thinkingLevel)}`,
    ]);
  const defaultSel = h(
    "select",
    {},
    ...defOpts.map(([v, l]) => h("option", { value: v, selected: v === curDefault }, l)),
  ) as HTMLSelectElement;

  const notifyDone = h("input", {
    type: "checkbox",
    checked: state.config.ui.notifyDone !== false,
    style: "width:auto",
  }) as HTMLInputElement;

  // Text size of the whole window: − / + steps in percent, applied right away (see src/main/layout.ts)
  const sizeVal = h("span", { class: "size-val" }, scaleLabel(state.config.ui.fontScale));
  const showSize = () => (sizeVal.textContent = scaleLabel(state.config.ui.fontScale));
  const sizeCtl = h(
    "div",
    { class: "size-ctl" },
    h(
      "button",
      {
        class: "ghost small",
        type: "button",
        title: t("Smaller text (⌘−)"),
        onclick: () => (stepFontScale(-1), showSize()),
      },
      "−",
    ),
    sizeVal,
    h(
      "button",
      {
        class: "ghost small",
        type: "button",
        title: t("Larger text (⌘+)"),
        onclick: () => (stepFontScale(1), showSize()),
      },
      "+",
    ),
    h(
      "button",
      {
        class: "ghost small",
        type: "button",
        title: t("Text size back to 100 % (⌘0)"),
        onclick: () => (setFontScale(1), showSize()),
      },
      t("Reset"),
    ),
  );

  const showTimes = h("input", {
    type: "checkbox",
    checked: !!state.config.ui.showTimes,
    style: "width:auto",
  }) as HTMLInputElement;

  // Default of the header's view menu; a session keeps the view chosen there for itself
  const viewSel = h(
    "select",
    {},
    ...VIEWS.map(([v, label]) => h("option", { value: v, selected: defaultViewMode() === v }, t(label))),
  ) as HTMLSelectElement;

  const autoScroll = h(
    "select",
    {},
    ...(
      [
        ["auto", "Automatic"],
        ["always", "Always"],
        ["off", "Off"],
      ] as [ScrollMode, Msg][]
    ).map(([v, l]) => h("option", { value: v, selected: scrollMode() === v }, t(l))),
  ) as HTMLSelectElement;

  const showGit = h("input", {
    type: "checkbox",
    checked: !!state.config.ui.showGit,
    style: "width:auto",
  }) as HTMLInputElement;

  const background = h("input", {
    type: "checkbox",
    checked: !!state.config.ui.background,
    style: "width:auto",
  }) as HTMLInputElement;

  const termFollow = h("input", {
    type: "checkbox",
    checked: state.config.ui.termFollowSession !== false,
    style: "width:auto",
  }) as HTMLInputElement;

  const termOwn = h("input", {
    type: "checkbox",
    checked: !!state.config.ui.termAutoOpen,
    style: "width:auto",
  }) as HTMLInputElement;

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
  // registration at start-up may have failed (shortcut taken): show why
  api
    .hotkeyStatus()
    .then((s) => {
      if (!s.error) return;
      hotkeyHint.textContent = s.error;
      hotkeyHint.style.color = "var(--danger)";
    })
    .catch(() => {});

  const version = h("p", { class: "app-version" }, "PiBar");
  getVersion()
    .then((v) => (version.textContent = `PiBar ${v}`))
    .catch(() => {});

  const presets = presetEditor();
  const voice = voiceEditor();

  // Quick start: 4 presets with a fixed folder each, clicked at the top of the new-session dialog
  const qsDraft: SessionPreset[] = JSON.parse(JSON.stringify(state.config.ui.sessionPresets ?? [])).slice(0, 4);
  while (qsDraft.length < 4) qsDraft.push({ name: "", dir: "" });
  const qsList = h("div", {});
  const qsRender = () => {
    qsList.replaceChildren(
      ...qsDraft.map((p, i) => {
        const name = h("input", { type: "text", value: p.name, placeholder: t("Name") }) as HTMLInputElement;
        name.addEventListener("input", () => (p.name = name.value));
        const dir = h("input", { type: "text", value: p.dir, placeholder: "~/project" }) as HTMLInputElement;
        dir.addEventListener("input", () => (p.dir = dir.value));
        return h("div", { class: "preset-row" }, h("span", { class: "muted" }, `${i + 1}`), name, dir);
      }),
    );
  };
  qsRender();

  const save = async () => {
    state.config.hosts = draft;
    state.config.colorProfiles = colors.get();
    state.config.ui.colorProfile = colors.getDefault();
    state.config.presets = presets.get();
    state.config.voice = voice.get();
    state.config.ui.sessionPresets = qsDraft
      .map((p) => ({ name: p.name.trim(), dir: p.dir.trim() }))
      .filter((p) => p.name || p.dir);
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
    if (theme.value !== curTheme) setTheme(theme.value as Theme);
    const d = defaultSel.value;
    state.config.ui.defaultPreset = d.startsWith("preset:") ? d.slice(7) : "";
    const [dm, dt] = d.startsWith("model:") ? d.slice(6).split("|") : ["", ""];
    state.config.ui.defaultModel = dm;
    state.config.ui.defaultThinking = dt ?? "";
    const gitChanged = !!state.config.ui.showGit !== showGit.checked;
    state.config.ui.showGit = showGit.checked;
    state.config.ui.showTimes = showTimes.checked;
    state.config.ui.chatMode = viewSel.value as ChatMode;
    state.config.ui.termFollowSession = termFollow.checked;
    state.config.ui.termAutoOpen = termOwn.checked;
    state.config.ui.autoScroll = autoScroll.value as ScrollMode;
    state.config.ui.notifyDone = notifyDone.checked;
    state.config.ui.background = background.checked;
    await saveConfig();
    close();
    // A new language needs a fresh render of both windows
    if (langChanged) {
      await emit("language-changed").catch(() => {});
      return window.location.reload();
    }
    if (gitChanged) renderFiles();
    renderHosts();
    applyChatColors();
    applyUiPrefs();
    renderToolbar();
    loadAllSessions();
  };

  // The dialog is too big for one long list: a section list on the left, only the chosen section on the right.
  // The last section stays chosen when the dialog is opened again.
  const secs: { label: Msg; el: HTMLElement }[] = [];
  const section = (label: Msg, ...children: (HTMLElement | null)[]) =>
    secs.push({ label, el: h("section", { class: "set-sec" }, ...children.filter((c): c is HTMLElement => !!c)) });

  section(
    "General",
    h("div", { class: "row" }, h("label", {}, t("Language")), lang),
    h("div", { class: "row" }, h("label", {}, t("Colour scheme")), theme),
    h("div", { class: "row" }, h("label", {}, t("Text size")), sizeCtl),
    h("p", { class: "hint" }, t("Text size of the whole window – also with ⌘+ and ⌘−, ⌘0 goes back to 100 %.")),
    // where the shortcuts are listed, the text-size keys included (shortcuts.ts, ⌘/ in the main window)
    h("div", { class: "row" }, h("label", {}, t("Keyboard shortcuts")), h("kbd", { class: "kbd" }, "⌘ /")),
    h(
      "p",
      { class: "hint" },
      t("Shows every shortcut while you work – the keys for bigger and smaller text (⌘+ and ⌘−) are listed there too."),
    ),
  );

  section(
    "Chat",
    h(
      "div",
      { class: "row" },
      h("label", {}, t("Messages")),
      h(
        "div",
        {},
        h("label", { class: "check" }, showTimes, ` ${t("Always show message times")}`),
        h("label", { class: "check" }, `${t("Auto scroll")}: `, autoScroll),
        h("label", { class: "check" }, `${t("View")}: `, viewSel),
        h(
          "p",
          { class: "hint" },
          t(
            "View that sessions start with. The header switches it for the session on screen, the other sessions keep theirs.",
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, t("Notification")),
      h(
        "label",
        { class: "check" },
        notifyDone,
        ` ${t("Notify me when Pi is done (while PiBar is in the background)")}`,
      ),
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, t("Sending")),
      h(
        "div",
        {},
        h("label", { class: "check" }, background, ` ${t("Start sessions in the background by default")}`),
        h(
          "p",
          { class: "hint" },
          t(
            "Messages then keep running when PiBar quits or the connection drops; the answer is there on the next start.",
          ),
        ),
      ),
    ),
    h(
      "div",
      { class: "row" },
      h("label", {}, "Git"),
      h("label", { class: "check" }, showGit, ` ${t("Show Git status in the file tree")}`),
    ),
  );

  section(
    "Models & presets",
    h("div", { class: "row" }, h("label", {}, t("Default model")), defaultSel),
    h(
      "p",
      { class: "hint" },
      t("Model and thinking level for new sessions. Tip: the star in the header sets the current session's choice."),
    ),
    presets.el,
  );

  section(
    "Quick start",
    qsList,
    h(
      "p",
      { class: "hint" },
      t(
        "Up to 4 presets at the top of the new-session dialog: each starts a session right away in its own fixed folder. Leave a row empty to hide it.",
      ),
    ),
  );

  section(
    "Terminal",
    h(
      "div",
      { class: "row" },
      h("label", {}, t("Shells")),
      h(
        "div",
        {},
        h("label", { class: "check" }, termFollow, ` ${t("Terminal follows the session")}`),
        h(
          "p",
          { class: "hint" },
          t(
            "Switching to another session also shows that session's shell. Off: the terminal keeps the shell it is showing.",
          ),
        ),
        h("label", { class: "check" }, termOwn, ` ${t("Own terminal tab per session")}`),
        h(
          "p",
          { class: "hint" },
          t(
            "On: every session started while the terminal is open gets its own shell. Off: only the + button starts one, in the session's folder.",
          ),
        ),
      ),
    ),
  );

  section(
    "Quick launcher",
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
  );

  section("Voice", voice.el);
  section("Chat colours", colors.el);

  section(
    "Hosts",
    h(
      "p",
      { class: "hint" },
      t("SSH uses your ~/.ssh/config and ssh-agent. Login must work without a password prompt (key)."),
    ),
    list,
    h("button", { class: "ghost", onclick: add }, t("+ Add host")),
    version,
  );

  const nav = h("nav", { class: "set-nav" });
  // only the chosen section is in the dialog, so the first visible field can take the focus
  const pane = h("div", { class: "set-body" });
  const show = (i: number) => {
    lastSection = i;
    pane.replaceChildren(secs[i].el);
    nav.querySelectorAll("button").forEach((b, j) => b.classList.toggle("active", j === i));
  };
  nav.replaceChildren(
    ...secs.map((s, i) => h("button", { type: "button", class: "set-nav-btn", onclick: () => show(i) }, t(s.label))),
  );
  show(Math.min(lastSection, secs.length - 1));

  const close = openModal(
    t("Settings"),
    h("div", { class: "set-layout" }, nav, pane),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: save }, t("Save")),
    ],
    undefined,
    "settings-modal",
  );
}
