// Which sessions are working, and which finished while you looked elsewhere: marks in the session list, counters at
// the hosts, a badge on the app icon and (in the background) a system notification.
import { getCurrentWindow } from "@tauri-apps/api/window";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { h } from "../shared/dom";
import { cleanTitle } from "../shared/format";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { state } from "./state";

/** Working, finished-but-unseen and failed sessions of one block of the list */
export interface Activity {
  working: number;
  done: number;
  failed: number;
}

/** Is a run of this session going on: a live one at Pi, or one started as a run in the background? */
export function isWorking(tab: SessionTab | undefined): boolean {
  return !!tab && (!!tab.bg || (tab.alive && tab.streaming));
}

/** One row of the session list as far as the marks are concerned: its tab (if open), its "running" and "unread" marks */
export interface ActivityRow {
  ref: { tab?: SessionTab };
  running?: boolean;
  /** "Mark as unread" in the session meta: counts as not read, also without an open tab */
  unread?: boolean;
}

/** Count the sessions of a block (a host heading, a project, a group) by their state; `running` also counts */
export function activityOfRows(rows: ActivityRow[]): Activity {
  let working = 0;
  let done = 0;
  let failed = 0;
  for (const row of rows) {
    const tab = row.ref.tab;
    if (row.running || isWorking(tab)) working++;
    else if (tab?.unseen && tab.failed) failed++;
    else if (tab?.unseen || row.unread) done++;
  }
  return { working, done, failed };
}

/** Same for a list of tabs (the host switcher has no rows) */
export function activityOfTabs(tabs: (SessionTab | undefined)[]): Activity {
  return activityOfRows(tabs.map((tab) => ({ ref: { tab } })));
}

/**
 * Working and unread sessions of a host (all hosts without id). Besides the open tabs this counts sessions marked
 * "unread" in the session meta – also when their tab is closed (the badge and the host tabs then show it as well).
 */
export function activityOf(hostId?: string): Activity {
  const a = activityOfTabs([...state.tabs.values()].filter((tab) => !hostId || tab.hostId === hostId));
  const prefix = hostId ? `${hostId}|` : "";
  for (const [key, m] of Object.entries(state.config.sessionMeta ?? {})) {
    if (!m?.unread || !key.startsWith(prefix)) continue;
    if (state.tabs.get(key)?.unseen) continue; // the tab already counts this session
    a.done++;
  }
  return a;
}

/**
 * Pi finished a run: mark it until it is looked at; notify if PiBar is in the background. The mark lives on the tab
 * (`unseen`); the caller also keeps it in the session meta (`unread`, see `onSettled` in sessions.ts), so the row, the
 * ✓ counters and the Dock badge are there again after a restart.
 */
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

/**
 * Mark at the left of a session row: a spinner while Pi works (also a run in the background, `running`). Nothing else:
 * unread and failed sessions are named in the pill on the right – a dot nobody can read is gone.
 */
export function sessionMark(tab: SessionTab | undefined, running = false): HTMLElement | null {
  if (running || isWorking(tab)) return h("span", { class: "sess-state busy", title: t("Pi is working …") });
  return null;
}

/**
 * Pill on the right of a session row, with words instead of a dot: "working", "unread" or "Error".
 * `unread` is the session's mark in the list (a finished run nobody looked at, or "Mark as unread").
 */
export function sessionPill(tab: SessionTab | undefined, running = false, unread = false): HTMLElement | null {
  if (running || isWorking(tab)) return h("span", { class: "sess-pill busy" }, t("working"));
  if (!tab?.unseen && !unread) return null;
  if (tab?.unseen && tab.failed) return h("span", { class: "sess-pill failed" }, t("Error"));
  return h("span", { class: "sess-pill unread", title: t("Not read yet") }, t("unread"));
}

/**
 * Counters in a host header, a project heading or a host tab: a spinner and "2" while sessions work, "✓ 1" for
 * finished ones. Glyphs instead of coloured dots – a dot in front of a name reads like a notification.
 */
export function marks(a: Activity): HTMLElement[] {
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
          title: t("{n} unread", { n: a.done + a.failed }),
        },
        h("span", { class: "act-mark" }, a.failed ? "!" : "✓"),
        String(a.done + a.failed),
      ),
    );
  return out;
}

/** Counters of a whole host (its tab in the switcher, whatever its projects are doing) */
export function hostMarks(hostId?: string): HTMLElement[] {
  return marks(activityOf(hostId));
}

/** Back in the window: the session on screen counts as seen */
export function wireActivity() {
  window.addEventListener("focus", () => {
    markSeen(state.active);
    // the list shows the marks
    window.dispatchEvent(new Event("pibar-activity"));
  });
}
