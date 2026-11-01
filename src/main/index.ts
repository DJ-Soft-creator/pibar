// Entry point of the main window (index.html). Loads settings, wires the modules
// and routes events from the Rust core to the right session.
import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { api, QuickSubmit } from "../shared/api";
import { errMsg, toast } from "../shared/dom";
import { getLang, setLang, t, translateDom } from "../shared/i18n";
import { applyTheme } from "../shared/theme";
import { applyUiPrefs, wireChatView } from "./chatView";
import { wireFiles } from "./files";
import { wireLayout } from "./layout";
import { wireSessionSelect } from "./sessionSelect";
import { broadcastActive, handleQuick } from "./quickBridge";
import { startReminderClock } from "./reminders";
import { loadAllSessions, renderHosts } from "./sessions";
import { wireActivity } from "./activity";
import { state } from "./state";

async function init() {
  state.config = await api.getConfig();
  state.config.reminders ??= [];
  applyTheme(state.config.ui.theme);
  setLang(state.config.ui.language);
  translateDom();
  api.setLanguage(getLang()).catch(() => {});
  // A fresh window has no open sessions: stop Pi processes left over from a reload
  await api.piCloseAll().catch(() => {});

  wireLayout();
  wireSessionSelect();
  wireChatView();
  applyUiPrefs();
  renderHosts();
  wireFiles();

  // Pi events (from src-tauri/src/pi.rs) go to the session with that process handle
  await listen<{ handle: number; event: any }>("pi-event", (e) => {
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
