// Entry point of the main window (index.html). Loads settings, wires the modules
// and routes events from the Rust core to the right session.
import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { api, QuickSubmit } from "../shared/api";
import type { PiEvent } from "../shared/piProtocol";
import { errMsg, toast } from "../shared/dom";
import { getLang, setLang, t, translateDom } from "../shared/i18n";
import { applyTheme } from "../shared/theme";
import { applyChatColors, wireChatColors } from "./colors";
import { applyUiPrefs, wireChatView } from "./chatView";
import { wireFiles } from "./files";
import { wireLayout } from "./layout";
import { wireTerminal } from "./terminal";
import { wireSessionSelect } from "./sessionSelect";
import { broadcastActive, handleQuick } from "./quickBridge";
import { startReminderClock } from "./reminders";
import { wireSearch } from "./search";
import { loadAllSessions, renderHosts, restoreLastSession } from "./sessions";
import { updateBadge, wireActivity } from "./activity";
import { renderQuickActions } from "./quickActions";
import { wireConfigAutoSync } from "./configExchange";
import { state } from "./state";

async function init() {
  state.config = await api.getConfig();
  state.config.reminders ??= [];
  applyTheme(state.config.ui.theme);
  wireChatColors();
  applyChatColors();
  setLang(state.config.ui.language);
  translateDom();
  api.setLanguage(getLang()).catch(() => {});
  // A fresh window has no open sessions: stop Pi processes left over from a reload
  await api.piCloseAll().catch(() => {});
  await api.termCloseAll().catch(() => {});

  wireLayout();
  wireSearch();
  wireSessionSelect();
  wireChatView();
  applyUiPrefs();
  renderQuickActions();
  renderHosts();
  wireFiles();
  wireTerminal();
  // two-way sync of names, colours, groups and projects with the webapp; redraws the list when it brings changes
  wireConfigAutoSync(renderHosts);

  // Pi events (from src-tauri/src/pi.rs) go to the session with that process handle
  await listen<{ handle: number; event: PiEvent }>("pi-event", (e) => {
    state.tabsByHandle.get(e.payload.handle)?.onEvent(e.payload.event);
  });
  await listen<{ handle: number; stderr: string }>("pi-exit", (e) => {
    const tab = state.tabsByHandle.get(e.payload.handle);
    if (tab?.alive) tab.onExit(e.payload.stderr);
  });

  // Quick bar
  await listen<QuickSubmit>("quick-submit", (e) => handleQuick(e.payload).catch((err) => toast(errMsg(err), "err")));
  await listen("quick-request-active", () => broadcastActive());

  startReminderClock();
  wireActivity();
  window.addEventListener("pibar-activity", () => renderHosts());
  warnQuickBar();
  api
    .configLoadError()
    .then((e) => e && toast(e, "err", 30000))
    .catch(() => {});
  await loadAllSessions();
  // unread marks kept in the session meta are there again: show them on the Dock icon too
  updateBadge();
  // the session that was open when PiBar was closed comes back with its model and context mode (session meta)
  await restoreLastSession();
}

/** The quick bar cannot open if its shortcut is taken or the double tap lacks the macOS permission: say so */
function warnQuickBar() {
  api
    .hotkeyStatus()
    .then((s) => s.error && toast(s.error, "err", 15000))
    .catch(() => {});
  if ((state.config.ui.doubleTap ?? "option") === "off") return;
  // the keyboard listener starts in the background: ask a moment later
  setTimeout(() => {
    api
      .doubleTapStatus()
      .then(
        (st) =>
          st === "permission" &&
          toast(
            t(
              "Double tap: macOS permission missing. System Settings → Privacy & Security → Input Monitoring: remove PiBar (−), add it again, restart PiBar.",
            ),
            "err",
            20000,
          ),
      )
      .catch(() => {});
  }, 3000);
}

init().catch((e) => toast(`${t("Start failed")}: ${errMsg(e)}`, "err", 15000));
