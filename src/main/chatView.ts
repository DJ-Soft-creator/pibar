// Middle column and header: chat area, input, preset/model/thinking selection, chat view and answer style,
// theme toggle, keyboard shortcuts.
import { emit } from "@tauri-apps/api/event";
import type { AnswerMode, ChatMode, Theme } from "../shared/api";
import { $, h, errMsg, toast } from "../shared/dom";
import { cleanTitle, shortPath, thinkingLabel } from "../shared/format";
import { Msg, t } from "../shared/i18n";
import { matchPreset, splitModelKey } from "../shared/presets";
import { applyTheme, nextTheme } from "../shared/theme";
import { showVoiceButtons, wireVoice } from "../shared/voice";
import { isEditorOpen, saveEditor } from "./files";
import { applyLayout, togglePanel } from "./layout";
import { openMenu } from "./menu";
import { displayTitle } from "./sessionGroups";
import { slashKey, wireSlashMenu } from "./slashMenu";
import { usageSummary, wireUsage } from "./usageStats";
import type { SessionTab } from "./sessionTab";
import { closeSession, defaultHostId, loadAllSessions, newSessionDialog } from "./sessions";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";

const elChatScroll = $("chat-scroll");
const elEmpty = $("empty");
const elInput = $("input") as HTMLTextAreaElement;
const elSend = $("btn-send") as HTMLButtonElement;
const elStop = $("btn-stop") as HTMLButtonElement;
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
const elTbSession = $("tb-session");
const elAddFolder = $("btn-add-folder") as HTMLButtonElement;

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
  elChatScroll.scrollTop = elChatScroll.scrollHeight;
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
  elSend.disabled = !ready;
  elSend.textContent = tab?.streaming ? t("Steer") : t("Send");
  elStop.hidden = !tab?.streaming;
  elAddFolder.disabled = !tab;
  elSlash.disabled = !ready;

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

  elUsage.textContent = usageSummary(tab);
}

function autoGrow() {
  elInput.style.height = "auto";
  elInput.style.height = `${Math.min(elInput.scrollHeight, 240)}px`;
}

async function sendInput() {
  const tab = state.active;
  const text = elInput.value.trim();
  if (!text || !tab || !tab.alive) return;
  elInput.value = "";
  autoGrow();
  try {
    await tab.send(text);
  } catch (e) {
    toast(errMsg(e), "err");
    elInput.value = text;
  }
}

/** Wire header, input and global keyboard shortcuts */
export function wireChatView() {
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    sendInput();
  });
  elInput.addEventListener("keydown", (e) => {
    if (slashKey(e)) return;
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendInput();
    }
  });
  elInput.addEventListener("input", autoGrow);
  elStop.addEventListener("click", () => state.active?.abort().catch((e) => toast(errMsg(e), "err")));

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
  elView.addEventListener("click", () =>
    ddOpen(elView, VIEWS, chatMode(), (v) => {
      state.config.ui.chatMode = v;
      setCardsOpen(v === "debug");
      applyUiPrefs();
      renderToolbar();
      saveConfig();
    }),
  );
  elAnswer.addEventListener("click", () =>
    ddOpen(elAnswer, ANSWERS, answerMode(), (v) => {
      state.config.ui.answerMode = v;
      applyUiPrefs();
      saveConfig();
      elInput.focus();
    }),
  );
  elTheme.addEventListener("click", () => setTheme(nextTheme(state.config.ui.theme)));
  wireSlashMenu(elInput, $("slash-menu"), elSlash);
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
  $("btn-new-empty").addEventListener("click", () => newSessionDialog(defaultHostId()));
  $("btn-new").addEventListener("click", () => newSessionDialog(defaultHostId()));

  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    if (mod && e.code === "KeyB") {
      e.preventDefault();
      togglePanel(e.altKey ? "right" : "left");
    } else if (mod && e.key === "s" && isEditorOpen()) {
      e.preventDefault();
      saveEditor();
    } else if (mod && e.key === "n") {
      e.preventDefault();
      newSessionDialog(defaultHostId());
    } else if (mod && e.key === "w" && state.active) {
      // ⌘W closes the active session, not the window
      e.preventDefault();
      closeSession(state.active);
    } else if (e.key === "Escape" && state.active?.streaming && document.activeElement === elInput) {
      state.active.abort().catch(() => {});
    }
  });
}

/** Change the colour scheme in both windows and save it */
export function setTheme(theme: Theme) {
  state.config.ui.theme = theme;
  applyTheme(theme);
  applyUiPrefs();
  saveConfig();
  emit("theme-changed", theme).catch(() => {});
}
