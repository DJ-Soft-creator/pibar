// Which sessions are working, and which finished while you looked elsewhere: marks in the session list, counters at
// the hosts, a badge on the app icon and (in the background) a system notification.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { h } from "../shared/dom";
import { cleanTitle } from "../shared/format";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { state } from "./state";

/** Working and finished-but-unseen sessions of a host (all hosts without id) */
export function activityOf(hostId?: string): { working: number; done: number; failed: number } {
  let working = 0;
  let done = 0;
  let failed = 0;
  for (const tab of state.tabs.values()) {
    if (hostId && tab.hostId !== hostId) continue;
    if (tab.alive && tab.streaming) working++;
    else if (tab.unseen && tab.failed) failed++;
    else if (tab.unseen) done++;
  }
  return { working, done, failed };
}

/** Pi finished a run: mark it until it is looked at; notify if PiBar is in the background */
export function markSettled(tab: SessionTab) {
  const looking = tab === state.active && document.hasFocus();
  if (!looking) {
    tab.unseen = true;
    if (!document.hasFocus() && state.config.ui.notifyDone !== false) void notifyDone(tab);
  }
  updateBadge();
}

/** The session is on screen: drop its "finished" mark */
export function markSeen(tab: SessionTab | null) {
  if (!tab?.unseen) return;
  tab.unseen = false;
  updateBadge();
}

/** Number of finished, unseen sessions on the app icon (Dock) */
export function updateBadge() {
  const { done, failed } = activityOf();
  const n = done + failed;
  getCurrentWindow()
    .setBadgeCount(n > 0 ? n : undefined)
    .catch(() => {});
}

async function notifyDone(tab: SessionTab) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (!ok) return;
    const title = cleanTitle(tab.title) || t("New session");
    sendNotification({
      title: tab.failed ? t("Pi stopped with an error") : t("Pi is done"),
      body: title,
    });
  } catch {
    /* notifications unavailable: the marks in the list remain */
  }
}

/** Mark at a session in the list: spinner while working, "Done"/"Error" until opened, else a dot if open */
export function sessionMark(tab: SessionTab | undefined): HTMLElement | null {
  if (!tab?.alive && !tab?.unseen) return null;
  if (tab.alive && tab.streaming) return h("span", { class: "sess-state busy", title: t("Pi is working …") });
  if (tab.unseen)
    return h("span", {
      class: `sess-state ${tab.failed ? "failed" : "done"}`,
      title: tab.failed ? t("Error") : t("Done"),
    });
  return h("span", { class: "sess-state open", title: t("Open") });
}

/** Pill on the right of a session row */
export function sessionPill(tab: SessionTab | undefined): HTMLElement | null {
  if (!tab) return null;
  if (tab.alive && tab.streaming) return h("span", { class: "sess-pill busy" }, t("working"));
  if (tab.unseen)
    return h("span", { class: `sess-pill ${tab.failed ? "failed" : "done"}` }, tab.failed ? t("Error") : t("Done"));
  return null;
}

/** Counters in a host header or host tab: "● 2" working, "✓ 1" done */
export function hostMarks(hostId?: string): HTMLElement[] {
  const a = activityOf(hostId);
  const out: HTMLElement[] = [];
  if (a.working)
    out.push(
      h(
        "span",
        { class: "act-count busy", title: t("{n} working", { n: a.working }) },
        h("span", { class: "sess-state busy" }),
        String(a.working),
      ),
    );
  if (a.done + a.failed)
    out.push(
      h(
        "span",
        {
          class: `act-count ${a.failed ? "failed" : "done"}`,
          title: t("{n} finished, not looked at yet", { n: a.done + a.failed }),
        },
        h("span", { class: `sess-state ${a.failed ? "failed" : "done"}` }),
        String(a.done + a.failed),
      ),
    );
  return out;
}

/** Back in the window: the session on screen counts as seen */
export function wireActivity() {
  window.addEventListener("focus", () => {
    markSeen(state.active);
    // the list shows the marks
    window.dispatchEvent(new Event("pibar-activity"));
  });
}
