// Middle column and header: chat area, input, preset/model/thinking selection, chat view and answer style,
// theme toggle, keyboard shortcuts.
import { emit } from "@tauri-apps/api/event";
import type { AnswerMode, ChatMode, Theme } from "../shared/api";
import { $, h, errMsg, toast } from "../shared/dom";
import { cleanTitle, shortPath, stripAnswerStyle, thinkingLabel, withContext, withFiles } from "../shared/format";
import { hasAttachments, renderDock, takeAttachments, wireComposerTools } from "./composerTools";
import { Msg, t } from "../shared/i18n";
import { matchPreset, splitModelKey } from "../shared/presets";
import { applyTheme, nextTheme } from "../shared/theme";
import { iconSvg } from "../shared/icons";
import { showVoiceButtons, wireVoice } from "../shared/voice";
import { renderAutoScroll, scrollModeItems, showEnd, wireAutoScroll } from "./autoScroll";
import { wireShortcuts } from "./shortcuts";
import type { QueueItem, QueueWhen } from "./sessionTab";
import { applyLayout } from "./layout";
import { openMenu } from "./menu";
import { cleanupDialog } from "./cleanup";
import { displayTitle } from "./sessionGroups";
import { slashKey, wireSlashMenu } from "./slashMenu";
import { renderUsage, wireUsage } from "./usageStats";
import type { SessionTab } from "./sessionTab";
import { defaultHostId, loadAllSessions, newSessionDialog, openQuestions, undoBranch } from "./sessions";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";

const elChatScroll = $("chat-scroll");
const elEmpty = $("empty");
const elInput = $("input") as HTMLTextAreaElement;
const elSend = $("btn-send") as HTMLButtonElement;

const SEND_ICON: Record<"send" | "steer" | "stop", string> = {
  send: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/></svg>',
  steer:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12.5V9a3.5 3.5 0 0 1 3.5-3.5h5.5M9.5 2.5l3 3-3 3"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.6" fill="currentColor"/></svg>',
};
let sendMode: "send" | "steer" | "stop" | "" = "";

/** One round button: send · while Pi works: stop, or steer as soon as something is typed */
function renderSendButton() {
  const tab = state.active;
  const typed = !!elInput.value.trim() || hasAttachments();
  const mode = tab?.streaming ? (typed ? "steer" : "stop") : "send";
  elSend.disabled = !tab?.alive || (mode === "send" && !typed);
  if (mode === sendMode) return;
  sendMode = mode;
  elSend.innerHTML = SEND_ICON[mode];
  elSend.className = `send-btn ${mode}`;
  elSend.title =
    mode === "stop"
      ? t("Stop (Esc)")
      : mode === "steer"
        ? t("Queue: Pi gets it when done (Enter) · ⌥Enter: in between, before Pi's next step")
        : t("Send (Enter)");
}
const elPreset = $("sel-preset") as HTMLSelectElement;
const elModel = $("sel-model") as HTMLSelectElement;
const elThinking = $("sel-thinking") as HTMLSelectElement;
const elView = $("sel-view");
const elAnswer = $("sel-answer");
const elTheme = $("btn-theme");
const elActivity = $("activity");
const elSlash = $("btn-slash") as HTMLButtonElement;
const elMic = $("btn-mic") as HTMLButtonElement;
const elImprove = $("btn-improve") as HTMLButtonElement;
const elUsage = $("usage");
const elUsageModel = $("usage-model");
const elDefault = $("btn-default") as HTMLButtonElement;
const elTbSession = $("tb-session");
const elAddFolder = $("btn-add-folder") as HTMLButtonElement;
const elReloadFiles = $("btn-reload-files") as HTMLButtonElement;

const VIEWS: [ChatMode, Msg, Msg][] = [
  ["natural", "Natural", "Only Pi's answers, no thinking or tool blocks"],
  ["technical", "Technical", "Thinking and tool calls as small collapsed blocks"],
  ["debug", "Debug", "Thinking and tool calls open and live"],
];
const ANSWERS: [AnswerMode, Msg, Msg][] = [
  ["short", "Short", "Rather short answers"],
  ["normal", "Normal", "Normal answers"],
  ["technical", "Brief & technical", "As short as possible, but with technical details"],
];
const SVG = (body: string) =>
  `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3">${body}</svg>`;
const THEME_ICON: Record<Theme, string> = {
  auto: SVG('<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5a5.5 5.5 0 0 1 0 11z" fill="currentColor"/>'),
  light: SVG(
    '<circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  ),
  dark: SVG('<path d="M13 9.8A5.5 5.5 0 0 1 6.2 3a5.5 5.5 0 1 0 6.8 6.8z"/>'),
};
const THEME_NAME: Record<Theme, Msg> = { auto: "Automatic", light: "Light", dark: "Dark" };

function chatMode(): ChatMode {
  const m = state.config.ui.chatMode;
  return m === "natural" || m === "debug" ? m : "technical";
}

function answerMode(): AnswerMode {
  const a = state.config.ui.answerMode;
  return a === "short" || a === "technical" ? a : "normal";
}

/** Dropdown button: current choice plus its description as tooltip */
function ddLabel(btn: HTMLElement, list: [string, Msg, Msg][], value: string) {
  const cur = list.find(([v]) => v === value) ?? list[0];
  btn.replaceChildren(h("span", { class: "dd-val" }, t(cur[1])), h("span", { class: "dd-chev" }, "▾"));
  btn.title = t(cur[2]);
}

/** Menu with name and a short description per choice */
function ddOpen<V extends string>(btn: HTMLElement, list: [V, Msg, Msg][], value: V, choose: (v: V) => void) {
  openMenu(
    btn,
    list.map(([v, label, desc]) => ({
      label: t(label),
      desc: t(desc),
      selected: v === value,
      onSelect: () => choose(v),
    })),
  );
}

/** Open or close all thinking/tool cards of open sessions (debug view: open) */
function setCardsOpen(open: boolean) {
  for (const tab of state.tabs.values())
    tab.el.querySelectorAll<HTMLDetailsElement>(".part details.card").forEach((d) => (d.open = open));
}

/** Panels, chat view, answer style and theme according to the settings */
export function applyUiPrefs() {
  const ui = state.config.ui;
  applyLayout();
  const mode = chatMode();
  for (const [m] of VIEWS) elChatScroll.classList.toggle(`mode-${m}`, m === mode);
  elChatScroll.classList.toggle("show-times", !!ui.showTimes);
  const answer = answerMode();
  ddLabel(elView, VIEWS, mode);
  ddLabel(elAnswer, ANSWERS, answer);
  elAnswer.classList.toggle("set", answer !== "normal");
  showVoiceButtons({ mic: elMic, improveBtn: elImprove }, state.config.voice);
  const theme = ui.theme ?? "auto";
  elTheme.innerHTML = THEME_ICON[theme];
  elTheme.title = `${t("Colour scheme")}: ${t(THEME_NAME[theme])} (${t("click to change")})`;
}

/** Show a session's chat in the chat area */
export function showTab(tab: SessionTab) {
  elEmpty.hidden = true;
  elChatScroll.querySelectorAll(".messages").forEach((m) => m !== tab.el && m.remove());
  if (tab.el.parentElement !== elChatScroll) elChatScroll.append(tab.el);
  showEnd();
  elInput.focus();
}

/** Back to the welcome screen (no active session) */
export function showEmpty() {
  elChatScroll.querySelectorAll(".messages").forEach((m) => m.remove());
  elEmpty.hidden = false;
}

/** Update header and input for the active session */
export function renderToolbar() {
  const tab = state.active;
  const host = tab ? state.config.hosts.find((x) => x.id === tab.hostId) : undefined;
  elTbSession.replaceChildren(
    tab
      ? h(
          "strong",
          {},
          cleanTitle(tab.sessionPath ? displayTitle(`${tab.hostId}|${tab.sessionPath}`, tab.title) : tab.title) ||
            t("New session"),
        )
      : t("No session"),
    tab ? ` · ${host?.name ?? tab.hostId} · ${shortPath(tab.cwd)}` : "",
  );

  const ready = !!tab && tab.alive;
  elInput.disabled = !ready;
  renderSendButton();
  elAddFolder.disabled = !tab;
  elReloadFiles.disabled = !tab;
  elSlash.disabled = !ready;
  renderDock();
  $("undo-bar").hidden = !tab?.undo;
  renderAutoScroll();
  renderQueue(tab);
  $("question-bar").hidden = !tab?.questions.length || tab.streaming;

  // natural view: a small line shows that Pi is working (thinking and tools are hidden)
  elActivity.hidden = !(tab?.streaming && chatMode() === "natural");
  elActivity.textContent = tab?.activity ? t("Pi is working: {tool} …", { tool: tab.activity }) : t("Pi is working …");

  // Models, grouped by provider
  elModel.disabled = !ready || !tab.models.length;
  const cur = tab?.model ? `${tab.model.provider}/${tab.model.id}` : "";
  const groups = new Map<string, HTMLOptGroupElement>();
  const opts: HTMLElement[] = [];
  if (tab && !tab.models.length) opts.push(h("option", { value: "" }, tab.model?.name ?? t("no model configured")));
  for (const m of tab?.models ?? []) {
    let g = groups.get(m.provider);
    if (!g) {
      g = h("optgroup", { label: m.provider });
      groups.set(m.provider, g);
      opts.push(g);
    }
    const value = `${m.provider}/${m.id}`;
    g.append(h("option", { value, selected: value === cur }, m.name || m.id));
  }
  elModel.replaceChildren(...opts);
  elModel.value = cur;
  if (elModel.selectedIndex < 0 && elModel.options.length) elModel.selectedIndex = 0;

  // Thinking level
  const levels = tab?.levels.length ? tab.levels : tab?.thinkingLevel ? [tab.thinkingLevel] : [];
  elThinking.disabled = !ready || levels.length < 2;
  elThinking.replaceChildren(
    ...levels.map((l) => h("option", { value: l, selected: l === tab?.thinkingLevel }, thinkingLabel(l))),
  );

  // Presets: when one is chosen, the model and thinking dropdowns are hidden
  const presets = state.config.presets ?? [];
  let choice = "";
  if (tab && presets.length) {
    choice = tab.presetId ?? matchPreset(presets, cur, tab.thinkingLevel)?.id ?? "";
    if (!presets.some((p) => p.id === choice)) choice = "";
  }
  elPreset.replaceChildren(
    ...presets.map((p) => h("option", { value: p.id, selected: p.id === choice }, p.name)),
    h("option", { value: "", selected: choice === "" }, t("Custom")),
  );
  elPreset.value = choice;
  elPreset.disabled = !ready;
  $("fld-preset").hidden = !presets.length;
  const individual = !presets.length || (!!tab && choice === "");
  $("fld-model").hidden = !individual;
  $("fld-thinking").hidden = !individual;

  renderUsage(elUsage, elUsageModel, tab);

  // Star: model/preset of this session as default for new sessions
  const isDefault = !!tab && isSessionDefault(tab.presetId ?? choice, cur, tab.thinkingLevel);
  elDefault.disabled = !ready;
  elDefault.classList.toggle("on", isDefault);
  elDefault.title = isDefault
    ? t("Default for new sessions – click to remove")
    : t("Use this model and thinking level as default for new sessions");
}

/** Does the session's preset or model/thinking equal the default for new sessions? */
function isSessionDefault(presetId: string, model: string, thinking: string): boolean {
  const ui = state.config.ui;
  if (ui.defaultPreset) return presetId === ui.defaultPreset;
  return !!ui.defaultModel && ui.defaultModel === model && (ui.defaultThinking || "") === (thinking || "");
}

/** Label of the default for new sessions (settings, tooltips) */
export function defaultLabel(): string {
  const ui = state.config.ui;
  const preset = (state.config.presets ?? []).find((p) => p.id === ui.defaultPreset);
  if (preset) return `${t("Preset")}: ${preset.name}`;
  if (ui.defaultModel)
    return [ui.defaultModel, ui.defaultThinking ? `${t("Thinking")}: ${thinkingLabel(ui.defaultThinking)}` : ""]
      .filter(Boolean)
      .join(" · ");
  return t("Pi's default");
}

function toggleDefault() {
  const tab = state.active;
  if (!tab?.model) return;
  const ui = state.config.ui;
  const model = `${tab.model.provider}/${tab.model.id}`;
  const presets = state.config.presets ?? [];
  const presetId = tab.presetId ?? matchPreset(presets, model, tab.thinkingLevel)?.id ?? "";
  if (isSessionDefault(presetId, model, tab.thinkingLevel)) {
    ui.defaultPreset = ui.defaultModel = ui.defaultThinking = "";
    toast(t("Default removed – new sessions use Pi's default."));
  } else {
    const preset = presets.find((p) => p.id === presetId);
    ui.defaultPreset = preset?.id ?? "";
    ui.defaultModel = preset ? "" : model;
    ui.defaultThinking = preset ? "" : tab.thinkingLevel;
    toast(t("Default for new sessions: {name}", { name: defaultLabel() }));
  }
  saveConfig();
  renderToolbar();
}

/** Lines the input grows to before it scrolls */
const INPUT_LINES = 6;

/** Input grows with its text up to INPUT_LINES lines, then scrolls */
function autoGrow() {
  const cs = getComputedStyle(elInput);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.5;
  const extra =
    parseFloat(cs.paddingTop) +
    parseFloat(cs.paddingBottom) +
    parseFloat(cs.borderTopWidth) +
    parseFloat(cs.borderBottomWidth);
  const max = Math.round(line * INPUT_LINES + extra);
  elInput.style.height = "auto";
  const want = elInput.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
  elInput.style.height = `${Math.min(want, max)}px`;
  elInput.classList.toggle("scrolls", want > max);
}

// ---------- Queue: messages waiting while Pi works ----------

/** List above the input: each waiting message with "in between"/"after", switch, back into the input, remove */
function renderQueue(tab: SessionTab | null) {
  const bar = $("queue-bar");
  const items: QueueItem[] = tab
    ? [
        ...tab.queue.steering.map((text) => ({ text, when: "steer" as const })),
        ...tab.queue.followUp.map((text) => ({ text, when: "followUp" as const })),
      ]
    : [];
  bar.hidden = !items.length;
  if (!tab || !items.length) return bar.replaceChildren();
  const edit = (fn: (list: QueueItem[]) => QueueItem[]) =>
    tab.editQueue(fn).catch((e) => toast(`${t("Queue")}: ${errMsg(e)}`, "err"));
  const same = (a: QueueItem, b: QueueItem) => a.text === b.text && a.when === b.when;
  const act = (title: string, label: string, fn: () => void) =>
    h("button", { type: "button", class: "msg-act", title, "aria-label": title, onclick: fn }, label);
  bar.replaceChildren(
    ...items.map((it) => {
      const shown = stripAnswerStyle(it.text);
      const other: QueueWhen = it.when === "steer" ? "followUp" : "steer";
      return h(
        "div",
        { class: "queue-item", title: shown },
        h("span", { class: `queue-when ${it.when}` }, it.when === "steer" ? t("in between") : t("after")),
        h("span", { class: "queue-text" }, shown.replace(/\s+/g, " ")),
        act(
          it.when === "steer" ? t("Only after Pi is done") : t("In between: before Pi's next step"),
          it.when === "steer" ? "⇣" : "⇡",
          // steering messages come before follow-ups: moving one changes its place in the order
          () => edit((list) => list.map((x) => (same(x, it) ? { ...x, when: other } : x))),
        ),
        act(t("Back into the input"), "✎", () => {
          void edit((list) => list.filter((x) => !same(x, it)));
          fillInput(shown);
        }),
        act(t("Remove"), "×", () => edit((list) => list.filter((x) => !same(x, it)))),
      );
    }),
  );
}

/** Put a text into the input (earlier message to edit or reuse) */
export function fillInput(text: string) {
  elInput.value = text;
  autoGrow();
  elInput.focus();
  elInput.setSelectionRange(text.length, text.length);
}

async function sendInput(when: QueueWhen = "followUp") {
  const tab = state.active;
  const text = elInput.value.trim();
  if ((!text && !hasAttachments()) || !tab || !tab.alive) return;
  elInput.value = "";
  autoGrow();
  tab.undo = null; // working on in the branch: no undo any more
  renderToolbar();
  const files = takeAttachments();
  const texts = files.filter((f) => f.kind === "text").map((f) => ({ name: f.name, text: f.text ?? "" }));
  const images = files.filter((f) => f.kind === "image").map((f) => ({ data: f.data ?? "", mimeType: f.mimeType }));
  const refs = files.flatMap((f) =>
    f.path && (f.kind === "folder" || f.kind === "fileref")
      ? [{ kind: f.kind === "folder" ? ("folder" as const) : ("file" as const), path: f.path }]
      : [],
  );
  const fallback =
    texts.length || images.length ? t("Have a look at the attached files.") : t("Have a look at the context.");
  const msg = withContext(withFiles(text || fallback, texts), refs);
  try {
    await tab.send(msg, images, when);
  } catch (e) {
    toast(errMsg(e), "err");
    elInput.value = text;
  }
}

/** Wire header, input and global keyboard shortcuts */
export function wireChatView() {
  wireAutoScroll();
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendInput();
  });
  elInput.addEventListener("keydown", (e) => {
    if (slashKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      // while Pi works: Enter (and ⌘Enter) queue the message (after Pi is done), ⌥Enter puts it in between
      sendInput(e.altKey ? "steer" : "followUp");
    }
  });
  elInput.addEventListener("input", autoGrow);
  elSend.addEventListener("click", (e) => {
    if (sendMode !== "stop") return; // submit → sendInput
    e.preventDefault();
    state.active?.abort().catch((err) => toast(errMsg(err), "err"));
  });
  elInput.addEventListener("input", renderSendButton);

  elPreset.addEventListener("change", async () => {
    const tab = state.active;
    if (!tab) return;
    const p = (state.config.presets ?? []).find((x) => x.id === elPreset.value);
    tab.presetId = p?.id ?? "";
    renderToolbar();
    if (!p) return;
    const m = splitModelKey(p.model);
    try {
      if (m) await tab.setModel(m.provider, m.id);
      if (p.thinking) await tab.setThinking(p.thinking);
    } catch (e) {
      toast(`${p.name}: ${errMsg(e)}`, "err");
      renderToolbar();
    }
  });
  elModel.addEventListener("change", () => {
    const v = elModel.value;
    const i = v.indexOf("/");
    if (!state.active || i < 0) return;
    state.active.setModel(v.slice(0, i), v.slice(i + 1)).catch((e) => {
      toast(`${t("Model")}: ${errMsg(e)}`, "err");
      renderToolbar();
    });
  });
  elThinking.addEventListener("change", () => {
    state.active?.setThinking(elThinking.value).catch((e) => {
      toast(`${t("Thinking")}: ${errMsg(e)}`, "err");
      renderToolbar();
    });
  });
  elView.addEventListener("click", () => {
    const mode = chatMode();
    openMenu(elView, [
      ...VIEWS.map(([v, label, desc]) => ({
        label: t(label),
        desc: t(desc),
        selected: v === mode,
        onSelect: () => {
          state.config.ui.chatMode = v;
          setCardsOpen(v === "debug");
          applyUiPrefs();
          renderToolbar();
          saveConfig();
        },
      })),
      { separator: true },
      {
        label: t("Always show message times"),
        desc: t("Otherwise the time appears when you point at a message"),
        selected: !!state.config.ui.showTimes,
        onSelect: () => {
          state.config.ui.showTimes = !state.config.ui.showTimes;
          applyUiPrefs();
          saveConfig();
        },
      },
      { separator: true },
      ...scrollModeItems(),
    ]);
  });
  elAnswer.addEventListener("click", () =>
    ddOpen(elAnswer, ANSWERS, answerMode(), (v) => {
      state.config.ui.answerMode = v;
      applyUiPrefs();
      saveConfig();
      elInput.focus();
    }),
  );
  elTheme.addEventListener("click", () => setTheme(nextTheme(state.config.ui.theme)));
  elDefault.innerHTML = iconSvg("star", 15);
  $("btn-undo").addEventListener("click", () => state.active && undoBranch(state.active));
  $("btn-answer").addEventListener("click", () => state.active && openQuestions(state.active));
  $("btn-question-close").addEventListener("click", () => {
    if (state.active) state.active.questions = [];
    renderToolbar();
  });
  $("btn-undo-close").addEventListener("click", () => {
    if (state.active) state.active.undo = null;
    renderToolbar();
  });
  elDefault.addEventListener("click", toggleDefault);
  wireSlashMenu(elInput, $("slash-menu"), elSlash);
  wireComposerTools(elInput);
  wireVoice({
    input: elInput,
    mic: elMic,
    improveBtn: elImprove,
    config: async () => state.config.voice,
    onError: (msg) => toast(msg, "err", 8000),
    onText: autoGrow,
  });
  wireUsage($("usage-wrap"), $("usage-pop"));

  $("btn-settings").addEventListener("click", settingsDialog);
  $("btn-refresh").addEventListener("click", () => loadAllSessions());
  $("btn-cleanup").addEventListener("click", () => cleanupDialog());
  $("btn-new-empty").addEventListener("click", () => newSessionDialog(defaultHostId()));
  $("btn-new").addEventListener("click", () => newSessionDialog(defaultHostId()));

  wireShortcuts({ input: elInput, fillInput });
}

/** Change the colour scheme in both windows and save it */
export function setTheme(theme: Theme) {
  state.config.ui.theme = theme;
  applyTheme(theme);
  applyUiPrefs();
  saveConfig();
  emit("theme-changed", theme).catch(() => {});
}
