// Link to the quick launcher window (src/quick/index.ts) via Tauri events.
import { emit } from "@tauri-apps/api/event";
import { api, QuickSubmit } from "../shared/api";
import { errMsg, toast } from "../shared/dom";
import { withFiles, withScreenText } from "../shared/format";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { activate, openSession } from "./sessions";
import { state } from "./state";

/** Tell the quick bar which session is active (for the target "Current session") */
export function broadcastActive() {
  const tab = state.active;
  emit("main-active", tab ? { hostId: tab.hostId, path: tab.sessionPath, title: tab.title } : null).catch(() => {});
}

/** Message from the quick bar: open the target session, set model/thinking, send, show the main window */
export async function handleQuick(q: QuickSubmit) {
  await api.showMain();
  let tab: SessionTab;
  if (q.target.kind === "active" && state.active) {
    tab = state.active;
    activate(tab);
  } else if (q.target.kind === "session" && q.target.hostId && q.target.path) {
    const open = state.tabs.get(`${q.target.hostId}|${q.target.path}`);
    if (open) activate((tab = open));
    else tab = await openSession(q.target.hostId, q.target.path, q.target.cwd || "~", q.target.title || "");
  } else {
    const hostId = q.target.hostId ?? state.config.hosts[0]?.id;
    if (!hostId) throw new Error(t("No host configured"));
    const cwd = q.target.cwd || state.config.hosts.find((x) => x.id === hostId)?.defaultDir || "~";
    tab = await openSession(hostId, null, cwd, t("New session"));
  }
  if (!tab.alive) return;
  if (q.preset || q.model || q.thinking) tab.presetId = q.preset;
  if (tab.detached) {
    // no live process to ask: model and thinking level go with the run in the background
    if (q.model) tab.model = { provider: q.model.provider, id: q.model.id, name: q.model.id };
    if (q.thinking) tab.thinkingLevel = q.thinking;
  } else {
    if (q.model)
      await tab.setModel(q.model.provider, q.model.id).catch((e) => toast(`${t("Model")}: ${errMsg(e)}`, "err"));
    if (q.thinking) await tab.setThinking(q.thinking).catch((e) => toast(`${t("Thinking")}: ${errMsg(e)}`, "err"));
  }
  tab.readNext = true; // auto read (Settings → Voice: "answers to quick bar messages")
  await tab.send(withFiles(withScreenText(q.text, q.ocr), q.files ?? []), q.images);
}
