// Entry point of the main window (index.html). Loads settings, wires the modules
// and routes events from the Rust core to the right session.
import "./styles.css";
import { listen } from "@tauri-apps/api/event";
import { api, QuickSubmit } from "../shared/api";
import { errMsg, toast } from "../shared/dom";
import { getLang, setLang, t, translateDom } from "../shared/i18n";
import { applyUiPrefs, wireChatView } from "./chatView";
import { wireFiles } from "./files";
import { broadcastActive, handleQuick } from "./quickBridge";
import { startReminderClock } from "./reminders";
import { loadAllSessions, renderHosts } from "./sessions";
import { state } from "./state";

async function init() {
  state.config = await api.getConfig();
  state.config.reminders ??= [];
  setLang(state.config.ui.language);
  translateDom();
  api.setLanguage(getLang()).catch(() => {});
  // A fresh window has no open sessions: stop Pi processes left over from a reload
  await api.piCloseAll().catch(() => {});

  applyUiPrefs();
  renderHosts();
  wireChatView();
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
  await loadAllSessions();
}

init().catch((e) => toast(`${t("Start failed")}: ${errMsg(e)}`, "err", 15000));
