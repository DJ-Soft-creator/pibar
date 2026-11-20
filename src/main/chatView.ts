// Middle column and header: chat area, input, preset/model/thinking selection, chat view, answer style, plan/build
// mode, theme toggle, keyboard shortcuts.
import { emit } from "@tauri-apps/api/event";
import { api } from "../shared/api";
import type { AnswerMode, ChatMode, Theme } from "../shared/api";
import { VIEWS } from "../shared/chatViews";
import { $, h, errMsg, toast } from "../shared/dom";
import { cleanTitle, shortPath, stripAnswerStyle, thinkingLabel, withContext, withFiles } from "../shared/format";
import { hasAttachments, renderDock, swapAttachments, takeAttachments, wireComposerTools } from "./composerTools";
import { Msg, t } from "../shared/i18n";
import { CONTEXT_SECTIONS, type ContextMode } from "../shared/contextMode";
import { matchPreset } from "../shared/presets";
import { stripPlanMode } from "../shared/planMode";
import { TEMP_MAX, TEMP_MIN, TEMP_NEUTRAL, TEMP_STEP, formatTemp, tempHint } from "../shared/temperature";
import { applyTheme, nextTheme } from "../shared/theme";
import { iconSvg } from "../shared/icons";
import { showVoiceButtons, wireVoice } from "../shared/voice";
import { keepScroll, scrollModeItems, showEnd, wireAutoScroll } from "./autoScroll";
import { applyChatColors } from "./colors";
import { wireShortcuts } from "./shortcuts";
import type { QueueItem, QueueWhen } from "./sessionTab";
import { applyFontScale, applyLayout } from "./layout";
import { openMenu, type MenuEntry } from "./menu";
import { applyTermTheme } from "./terminal";
import { cleanupDialog } from "./cleanup";
import { displayTitle, setMeta } from "./sessionGroups";
import { slashKey, wireSlashMenu } from "./slashMenu";
import { renderUsage, wireUsage } from "./usageStats";
import { defaultViewMode, type SessionTab } from "./sessionTab";
import { defaultHostId, loadAllSessions, newSessionDialog, openQuestions, undoBranch } from "./sessions";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";

const elChatScroll = $("chat-scroll");
const elEmpty = $("empty");
const elInput = $("input") as HTMLTextAreaElement;
const elSend = $("btn-send") as HTMLButtonElement;
const elBg = $("btn-bg") as HTMLButtonElement;
const elCtx = $("btn-context") as HTMLButtonElement;

const SEND_ICON: Record<"send" | "steer" | "stop", string> = {
  send: '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 13V3.5M3.8 7.5 8 3.3l4.2 4.2"/></svg>',
  steer:
    '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 12.5V9a3.5 3.5 0 0 1 3.5-3.5h5.5M9.5 2.5l3 3-3 3"/></svg>',
  stop: '<svg width="16" height="16" viewBox="0 0 16 16"><rect x="4.5" y="4.5" width="7" height="7" rx="1.6" fill="currentColor"/></svg>',
};
let sendMode: "send" | "steer" | "stop" | "" = "";

/**
 * Background mode of the session on screen, visible in two places: the pill next to the input (click = off again) and
 * a dashed ring around the send button, so the user sees what the button will do before pressing it.
 */
function renderBackground(tab: SessionTab | null) {
  const on = !!tab?.background;
  elBg.hidden = !on;
  elSend.classList.toggle("background", on);
}

/** One round button: send · while Pi works (or a run in the background goes on): stop · otherwise steer */
function renderSendButton() {
  const tab = state.active;
  const typed = !!elInput.value.trim() || hasAttachments();
  const mode = tab?.bg ? "stop" : tab?.streaming ? (typed ? "steer" : "stop") : "send";
  elSend.disabled = !tab?.alive || (mode === "send" && !typed);
  if (mode !== sendMode) {
    sendMode = mode;
    elSend.innerHTML = SEND_ICON[mode];
    elSend.className = `send-btn ${mode}${tab?.background ? " background" : ""}`;
  }
  renderContext(tab);
  elSend.title =
    (mode === "stop" && tab?.bg
      ? t("Stop the run in the background")
      : mode === "stop"
        ? t("Stop (Esc)")
        : mode === "steer"
          ? t("Queue: Pi gets it when done (Enter) · ⌥Enter: in between, before Pi's next step")
          : t("Send (Enter) · ⇧⌘↩ in the background")) +
    (tab?.background ? ` · ${t("This session sends in the background")}` : "") +
    (tab?.contextMode ? ` · ${contextLabel(tab.contextMode)}` : "") +
    ` · ${t("Right-click: background menu")}`;
}

/** Mode names of the extension, not translated: they are the words the commands use */
function contextLabel(mode: Exclude<ContextMode, "">): string {
  return mode === "public" ? "☁ public" : "🔒 private";
}

/**
 * Context mode of the session (Pi extension mode-guard, shared/contextMode.ts), subtly around the send button: a thin
 * ring (dotted for public) plus a small pill next to it that opens the same menu as the answer dropdown.
 */
function renderContext(tab: SessionTab | null) {
  const mode = tab?.contextMode ?? "";
  elSend.classList.toggle("ctx-public", mode === "public");
  elSend.classList.toggle("ctx-private", mode === "private");
  const show = !!tab?.alive && !!mode && tab.contextAvailable();
  elCtx.hidden = !show;
  if (!show) return;
  elCtx.classList.toggle("public", mode === "public");
  elCtx.replaceChildren(
    h("span", { class: "ctx-mark" }, mode === "public" ? "☁" : "🔒"),
    h("span", {}, mode === "public" ? "public" : "private"),
  );
  elCtx.title = t("Context: {mode} – click for private/public and sections", { mode });
}
const elPreset = $("sel-preset") as HTMLSelectElement;
const elModel = $("sel-model") as HTMLSelectElement;
const elThinking = $("sel-thinking") as HTMLSelectElement;
const elView = $("sel-view");
const elAnswer = $("sel-answer");
const elTemp = $("sel-temp") as HTMLButtonElement;
const elPlan = $("sel-plan") as HTMLButtonElement;
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

const ANSWERS: [AnswerMode, Msg, Msg][] = [
  ["short", "Short", "Rather short answers"],
  ["normal", "Normal", "Normal answers"],
  ["technical", "Brief & technical", "As short as possible, but with technical details"],
];

/** Context modes of Pi's mode-guard extension (see shared/contextMode.ts) */
const CONTEXT_MODES: ["private" | "public", Msg, Msg][] = [
  ["private", "Private – full context", "AGENTS.md, skills and MCP servers are sent as usual"],
  ["public", "Public – reduced context", "Project context, skills and MCP servers stay out"],
];

/** Work modes of the session (src/shared/planMode.ts): Plan = read-only plus a plan, Build = normal work */
const PLANS: [string, Msg, Msg][] = [
  ["build", "Build", "Pi may read and change files and run commands"],
  ["plan", "Plan", "Pi only reads and analyses, then writes a numbered plan – nothing is changed"],
];

/** The Plan/Build dropdown shows the mode of the session on screen */
function renderPlan() {
  const tab = state.active;
  ddLabel(elPlan, PLANS, tab?.planMode ? "plan" : "build");
  elPlan.classList.toggle("set", !!tab?.planMode);
  elPlan.disabled = !tab;
}

/** Temperature of the session on screen (Pi extension pibar-temperature); "Default" = the model decides */
function renderTemp() {
  const tab = state.active;
  const v = tab?.temperature ?? null;
  const label = v === null ? t("Default") : formatTemp(v);
  elTemp.replaceChildren(h("span", { class: "dd-val" }, `🌡 ${label}`), h("span", { class: "dd-chev" }, "▾"));
  elTemp.classList.toggle("set", v !== null);
  elTemp.disabled = !tab;
  elTemp.title = !tab
    ? t("Temperature of this session")
    : v === null
      ? `${t("Temperature")}: ${t("the model's default – click to set a value")}`
      : `${t("Temperature")}: ${formatTemp(v)} – ${t(tempHint(v))}`;
}

/** Install the temperature extension on the session's host and restart the session so Pi loads it */
async function installTemperature(tab: SessionTab) {
  try {
    await api.tempInstall(tab.hostId);
    toast(t("Temperature extension installed – restarting the session."));
    await tab.restart();
  } catch (e) {
    toast(`${t("Temperature")}: ${errMsg(e)}`, "err");
  }
}

/**
 * Entries of the temperature dropdown: the slider with a live explanation, "Model's default" below it. Without the
 * extension the menu offers to install it on the host (it writes ~/.pi/agent/extensions/pibar-temperature.ts).
 */
function tempMenuItems(tab: SessionTab): MenuEntry[] {
  const items: MenuEntry[] = [{ heading: t("Temperature") }];
  if (!tab.tempAvailable()) {
    items.push({
      label: t("The temperature extension is not loaded"),
      desc: t("PiBar can install it on this host – the session then restarts once."),
      disabled: true,
      onSelect: () => {},
    });
    if (tab.alive && !tab.detached)
      items.push({
        label: t("Install extension and restart session"),
        desc: t("Writes pibar-temperature.ts to ~/.pi/agent/extensions on the host"),
        onSelect: () => void installTemperature(tab),
      });
    return items;
  }
  const v = tab.temperature;
  // while dragging: commit after a short pause, so a slow drag applies without waiting for the release
  let timer: number | undefined;
  const commit = (x: number) => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    void tab.setTemperature(x);
  };
  items.push({
    slider: true,
    min: TEMP_MIN,
    max: TEMP_MAX,
    step: TEMP_STEP,
    value: v ?? TEMP_NEUTRAL,
    label: t("Temperature of this session"),
    ends: [t("precise"), t("free")],
    format: formatTemp,
    hint: (x) => t(tempHint(x)),
    onInput: (x) => {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = window.setTimeout(() => commit(x), 250);
    },
    onChange: commit,
  });
  items.push(
    { separator: true },
    {
      label: t("Model's default"),
      desc: t("No fixed temperature – the model decides (often around 0.7–1.0)"),
      selected: v === null,
      onSelect: () => void tab.setTemperature(null),
    },
  );
  return items;
}

/**
 * Entries of the context menu (answer dropdown and the mode pill next to the input): private/public and the sections
 * that public mode leaves out. Only shown when Pi's mode-guard extension is loaded – otherwise sending "/mode" would
 * go to the model as a normal message.
 */
function contextMenuItems(tab: SessionTab | null): MenuEntry[] {
  if (!tab?.alive) return [];
  const items: MenuEntry[] = [{ separator: true }, { heading: t("Context") }];
  if (!tab.contextAvailable()) {
    items.push({
      label: t("The mode-guard extension is not loaded"),
      desc: t("Put it in ~/.pi/agent/extensions to switch private/public here."),
      disabled: true,
      onSelect: () => {},
    });
    return items;
  }
  for (const [mode, label, desc] of CONTEXT_MODES)
    items.push({
      label: t(label),
      desc: t(desc),
      selected: tab.contextMode === mode,
      onSelect: () => void tab.setContextMode(mode),
    });
  items.push({ separator: true }, { heading: t("Sections for public mode") });
  for (const name of CONTEXT_SECTIONS) {
    const out = tab.contextStripped.includes(name);
    items.push({
      label: name,
      desc: t(out ? "Stays out in public mode" : "Also sent in public mode"),
      selected: !out,
      onSelect: () => void tab.setContextSection(name, out),
    });
  }
  items.push(
    { separator: true },
    {
      label: t("Show what is sent now"),
      desc: t("Pi lists the sections in a notice"),
      onSelect: () => tab.showContextSections(),
    },
  );
  return items;
}
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

/** View of the session on screen (each session has its own, see SessionTab.viewMode); without one the setting */
function chatMode(): ChatMode {
  return state.active?.viewMode() ?? defaultViewMode();
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

/** Open or close all thinking/tool cards of the session on screen (debug view: open) */
function setCardsOpen(open: boolean) {
  state.active?.el.querySelectorAll<HTMLDetailsElement>(".part details.card").forEach((d) => (d.open = open));
}

/** Chat view classes and the view menu's label for the session on screen */
function applyViewMode() {
  const mode = chatMode();
  for (const [m] of VIEWS) elChatScroll.classList.toggle(`mode-${m}`, m === mode);
  ddLabel(elView, VIEWS, mode);
}

/** Panels, text size, chat view, answer style and theme according to the settings */
export function applyUiPrefs() {
  const ui = state.config.ui;
  applyLayout();
  applyFontScale();
  applyViewMode();
  elChatScroll.classList.toggle("show-times", !!ui.showTimes);
  const answer = answerMode();
  ddLabel(elAnswer, ANSWERS, answer);
  elAnswer.classList.toggle("set", answer !== "normal");
  showVoiceButtons({ mic: elMic, improveBtn: elImprove }, state.config.voice);
  const theme = ui.theme ?? "auto";
  elTheme.innerHTML = THEME_ICON[theme];
  elTheme.title = `${t("Colour scheme")}: ${t(THEME_NAME[theme])} (${t("click to change")})`;
}

/** Show a session's chat in the chat area */
export function showTab(tab: SessionTab, prev: SessionTab | null = null) {
  elEmpty.hidden = true;
  elChatScroll.querySelectorAll(".messages").forEach((m) => m !== tab.el && m.remove());
  if (tab.el.parentElement !== elChatScroll) elChatScroll.append(tab.el);
  swapComposer(prev, tab);
  showEnd();
  elInput.focus();
}

/**
 * Text and attachments belong to the session: put the draft of the session being left into its tab and show the
 * draft of the new one. Otherwise a half-typed message of one session would sit in front of another one.
 */
function swapComposer(prev: SessionTab | null, next: SessionTab) {
  if (prev === next) return; // same session (a click on its row): the text stays as typed
  if (prev) {
    prev.draft = elInput.value;
    prev.draftAttachments = swapAttachments([]);
  }
  elInput.value = next.draft;
  swapAttachments(next.draftAttachments);
  next.draftAttachments = [];
  autoGrow();
  renderSendButton();
}

/** Back to the welcome screen (no active session) */
export function showEmpty() {
  elChatScroll.querySelectorAll(".messages").forEach((m) => m.remove());
  elEmpty.hidden = false;
  elInput.value = "";
  swapAttachments([]);
  autoGrow();
  renderBackground(null);
  renderSendButton();
  applyViewMode();
  renderPlan();
  renderTemp();
  applyChatColors();
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
    tab?.background ? ` · ${t("In the background")}` : "",
  );

  const ready = !!tab && tab.alive;
  elInput.disabled = !ready;
  renderSendButton();
  elAddFolder.disabled = !tab;
  elReloadFiles.disabled = !tab;
  elSlash.disabled = !ready;
  renderDock();
  $("undo-bar").hidden = !tab?.undo;
  renderBackground(tab);
  renderQueue(tab);
  $("question-bar").hidden = !tab?.questions.length || tab.streaming;

  // switching sessions also switches their view
  applyViewMode();
  renderPlan();
  renderTemp();

  // natural view: a small line shows that Pi is working (thinking and tools are hidden)
  elActivity.hidden = !(tab?.streaming && chatMode() === "natural");
  elActivity.textContent = tab?.activity ? t("Pi is working: {tool} …", { tool: tab.activity }) : t("Pi is working …");

  // Models, grouped by provider
  elModel.disabled = !ready || !tab.models.length;
  const cur = tab?.model ? `${tab.model.provider}/${tab.model.id}` : "";
  const groups = new Map<string, HTMLOptGroupElement>();
  const opts: HTMLElement[] = [];
  const group = (provider: string) => {
    let g = groups.get(provider);
    if (!g) {
      g = h("optgroup", { label: provider });
      groups.set(provider, g);
      opts.push(g);
    }
    return g;
  };
  if (tab && !tab.models.length) opts.push(h("option", { value: cur }, tab.model?.name ?? t("no model configured")));
  for (const m of tab?.models ?? []) {
    const value = `${m.provider}/${m.id}`;
    group(m.provider).append(h("option", { value, selected: value === cur }, m.name || m.id));
  }
  // Pi can run a model that the host does not list (e.g. taken from the session file). Show it too: a dropdown that
  // falls back to its first entry would name another model than the one Pi uses, and picking it again would do nothing.
  if (tab?.model && !(tab.models ?? []).some((m) => `${m.provider}/${m.id}` === cur))
    group(tab.model.provider).append(
      h("option", { value: cur, selected: true }, `${tab.model.name || tab.model.id} – ${t("not in the list")}`),
    );
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
  keepScroll(() => {
    elInput.style.height = "auto";
    const want = elInput.scrollHeight + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    elInput.style.height = `${Math.min(want, max)}px`;
    elInput.classList.toggle("scrolls", want > max);
  });
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
      const shown = stripPlanMode(stripAnswerStyle(it.text));
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

async function sendInput(when: QueueWhen | "background" = "followUp") {
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
    if (when === "background" || tab.background) {
      if (!(await tab.sendToBackground(msg, images))) elInput.value = text;
      autoGrow();
      renderSendButton();
      return;
    }
    await tab.send(msg, images, when);
  } catch (e) {
    toast(errMsg(e), "err");
    elInput.value = text;
  }
}

/** Menu on the send button: one message in the background, or all messages of this session */
function backgroundMenu() {
  const tab = state.active;
  if (!tab) return;
  openMenu(
    elSend,
    [
      { heading: t("In the background") },
      {
        label: t("Send in the background"),
        desc: t("Keeps running when PiBar quits or the connection drops"),
        onSelect: () => void sendInput("background"),
      },
      {
        label: t("Always send in the background"),
        desc: t("For this session, until switched off"),
        selected: tab.background,
        onSelect: () => setBackground(tab, !tab.background),
      },
    ],
    "right",
  );
}

/** Sticky mode of one session (B): saved in sessionMeta, so it survives a restart */
export function setBackground(tab: SessionTab, on: boolean) {
  tab.background = on;
  if (tab.sessionPath) setMeta(`${tab.hostId}|${tab.sessionPath}`, { background: on ? "on" : "off" });
  renderToolbar();
  toast(t(on ? "Messages of this session run in the background." : "Messages of this session go the normal way."));
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
    if (e.key === "Enter" && e.shiftKey && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      sendInput("background");
      return;
    }
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
    const tab = state.active;
    if (!tab) return;
    if (tab.bg) void tab.stopBackground();
    else tab.abort().catch((err) => toast(errMsg(err), "err"));
  });
  elSend.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    backgroundMenu();
  });
  elInput.addEventListener("input", renderSendButton);
  elBg.addEventListener("click", () => {
    const tab = state.active;
    if (tab?.background) setBackground(tab, false);
  });

  elPreset.addEventListener("change", async () => {
    const tab = state.active;
    if (!tab) return;
    const p = (state.config.presets ?? []).find((x) => x.id === elPreset.value);
    try {
      await tab.setPreset(p?.id ?? null);
    } catch (e) {
      toast(`${p?.name ?? t("Preset")}: ${errMsg(e)}`, "err");
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
          // belongs to the session: another session keeps its own view. Without a session it changes the setting,
          // i.e. the default for new sessions.
          if (state.active) state.active.setViewMode(v);
          else state.config.ui.chatMode = v;
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
  // answer style and, below it, the context mode of the session (Pi extension mode-guard)
  elAnswer.addEventListener("click", () =>
    openMenu(elAnswer, [
      ...ANSWERS.map(([v, label, desc]) => ({
        label: t(label),
        desc: t(desc),
        selected: v === answerMode(),
        onSelect: () => {
          state.config.ui.answerMode = v;
          applyUiPrefs();
          saveConfig();
          elInput.focus();
        },
      })),
      ...contextMenuItems(state.active),
    ]),
  );
  elCtx.addEventListener("click", () => {
    const tab = state.active;
    if (tab) openMenu(elCtx, contextMenuItems(tab), "right");
  });
  // temperature of the session: slider with a short explanation (Pi extension pibar-temperature)
  elTemp.addEventListener("click", () => {
    const tab = state.active;
    if (tab) openMenu(elTemp, tempMenuItems(tab));
  });
  // Plan/Build of the session: Plan restricts Pi to read-only tools and asks for a plan (shared/planMode.ts)
  elPlan.addEventListener("click", () => {
    const tab = state.active;
    if (!tab) return;
    openMenu(
      elPlan,
      PLANS.map(([v, label, desc]) => ({
        label: t(label),
        desc: t(desc),
        selected: v === (tab.planMode ? "plan" : "build"),
        onSelect: () => {
          void tab.setPlanMode(v === "plan").then(() => {
            renderToolbar();
            elInput.focus();
          });
        },
      })),
    );
  });
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
  applyChatColors(); // the profile has its own colours for dark and light
  applyTermTheme();
  applyUiPrefs();
  saveConfig();
  emit("theme-changed", theme).catch(() => {});
}
