// Middle column and header: chat area, input, model/thinking selection, panel toggles, keyboard shortcuts.
import { $, h, errMsg, toast } from "../shared/dom";
import { cleanTitle, fmtTokens, shortPath, thinkingLabel } from "../shared/format";
import { t } from "../shared/i18n";
import { isEditorOpen, saveEditor } from "./files";
import type { SessionTab } from "./sessionTab";
import { closeSession, defaultHostId, loadAllSessions, newSessionDialog } from "./sessions";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";

const elChatScroll = $("chat-scroll");
const elEmpty = $("empty");
const elInput = $("input") as HTMLTextAreaElement;
const elSend = $("btn-send") as HTMLButtonElement;
const elStop = $("btn-stop") as HTMLButtonElement;
const elModel = $("sel-model") as HTMLSelectElement;
const elThinking = $("sel-thinking") as HTMLSelectElement;
const elTgTools = $("tg-tools");
const elTgThinking = $("tg-thinking");
const elUsage = $("usage");
const elTbSession = $("tb-session");
const elAddFolder = $("btn-add-folder") as HTMLButtonElement;

/** Show/hide side panels, tool calls and thinking according to the settings */
export function applyUiPrefs() {
  const ui = state.config.ui;
  $("app").classList.toggle("no-left", !!ui.leftCollapsed);
  $("app").classList.toggle("no-right", !!ui.rightCollapsed);
  $("tg-left").classList.toggle("off", !!ui.leftCollapsed);
  $("tg-right").classList.toggle("off", !!ui.rightCollapsed);
  elTgTools.classList.toggle("on", ui.showTools);
  elTgThinking.classList.toggle("on", ui.showThinking);
  elChatScroll.classList.toggle("hide-tools", !ui.showTools);
  elChatScroll.classList.toggle("hide-thinking", !ui.showThinking);
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
    tab ? h("strong", {}, cleanTitle(tab.title) || t("New session")) : t("No session"),
    tab ? ` · ${host?.name ?? tab.hostId} · ${shortPath(tab.cwd)}` : "",
  );

  const ready = !!tab && tab.alive;
  elInput.disabled = !ready;
  elSend.disabled = !ready;
  elSend.textContent = tab?.streaming ? t("Steer") : t("Send");
  elStop.hidden = !tab?.streaming;
  elAddFolder.disabled = !tab;

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

  elUsage.textContent = tab && tab.usage.tokens ? `${fmtTokens(tab.usage.tokens)} · $${tab.usage.cost.toFixed(2)}` : "";
}

function togglePanel(which: "left" | "right") {
  const ui = state.config.ui;
  if (which === "left") ui.leftCollapsed = !ui.leftCollapsed;
  else ui.rightCollapsed = !ui.rightCollapsed;
  applyUiPrefs();
  saveConfig();
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
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendInput();
    }
  });
  elInput.addEventListener("input", autoGrow);
  elStop.addEventListener("click", () => state.active?.abort().catch((e) => toast(errMsg(e), "err")));

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
  elTgTools.addEventListener("click", () => {
    state.config.ui.showTools = !state.config.ui.showTools;
    applyUiPrefs();
    saveConfig();
  });
  elTgThinking.addEventListener("click", () => {
    state.config.ui.showThinking = !state.config.ui.showThinking;
    applyUiPrefs();
    saveConfig();
  });

  $("btn-settings").addEventListener("click", settingsDialog);
  $("tg-left").addEventListener("click", () => togglePanel("left"));
  $("tg-right").addEventListener("click", () => togglePanel("right"));
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
