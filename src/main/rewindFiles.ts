// Going back to an own message also restores files: what Pi changed since then goes back to the state PiBar recorded
// before the turn (src-tauri/src/snapshot.rs). Only those files – everything else in the folder stays as it is, and
// nothing is written for folders that are no Git repository. Called from the "go back" of an own message and from the
// undo after it (src/main/sessions.ts).
import { api, type RewindChange, type RewindPreview } from "../shared/api";
import { branchFamily } from "../shared/branches";
import { errMsg, h, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import type { SessionTab } from "./sessionTab";
import { state } from "./state";

/** What going back does with the files, after the user agreed to it */
export interface RewindPlan {
  /** Working folder of the session (repository or a folder inside it) */
  cwd: string;
  /** Session files that may hold the state: a branch keeps the history of the session it came from */
  sessionIds: string[];
  /** Entry id of the own message whose state is the target */
  tag: string;
  /** Paths Pi changed since then, as Pi named them */
  paths: string[];
  /** The files that actually change */
  changes: RewindChange[];
}

/**
 * Ask whether the files may go back as well. `tag` = entry id of the own message to go back to (its answer ends the
 * target state), `after` = entry ids of the messages behind it: everything Pi changed in those is restored. Entry ids
 * are used instead of counting, so compaction and branches cannot shift the point. Returns null if cancelled.
 */
export async function planRewind(tab: SessionTab, tag: string, after: string[]): Promise<RewindPlan | null> {
  const plan: RewindPlan = { cwd: tab.cwd, sessionIds: [], tag, paths: [], changes: [] };
  const path = tab.sessionPath;
  if (!path || !tag) return plan;
  let paths: string[];
  try {
    const touched = await api.sessionTouches(tab.hostId, path);
    const wanted = new Set(after);
    paths = [...new Set(touched.filter((m) => wanted.has(m.id)).flatMap((m) => m.paths))];
  } catch {
    return plan; // session file unreadable: going back then only touches the conversation
  }
  if (!paths.length) return plan;
  const sessionIds = familyIds(tab);
  let preview: RewindPreview;
  try {
    preview = await api.rewindPreview(tab.hostId, tab.cwd, sessionIds, tag, paths);
  } catch (e) {
    toast(`${t("Files")}: ${errMsg(e)}`, "err");
    return null;
  }
  if (!preview.repo) return plan; // no Git repository: no states, nothing to restore
  if (!preview.commit) return (await askNevertheless()) ? plan : null;
  if (!preview.changes.length) return plan; // the files already are in that state
  return (await confirmChanges(preview.changes)) ? { ...plan, sessionIds, paths, changes: preview.changes } : null;
}

/**
 * Restore the files of the plan; the state before stays recorded, so the undo of the branch can put it back.
 * Returns how many files were restored or deleted (0 = nothing to do).
 */
export async function applyRewind(tab: SessionTab, plan: RewindPlan): Promise<number> {
  if (!plan.changes.length || !plan.sessionIds.length) return 0;
  try {
    const res = await api.rewindRestore(tab.hostId, plan.cwd, plan.sessionIds, plan.tag, plan.paths);
    if (!res) {
      toast(t("No file state for this point – only the conversation went back."), "info");
      return 0;
    }
    const done = res.restored.length + res.deleted.length;
    if (res.backup && tab.undo) tab.undo.files = { cwd: plan.cwd, commit: res.backup, paths: plan.paths };
    if (res.failed.length) {
      toast(`${t("{n} files restored, {failed} failed.", { n: done, failed: res.failed.length })}`, "err");
    } else if (done) {
      toast(t("{n} files restored.", { n: done }), "info");
    }
    return done;
  } catch (e) {
    toast(`${t("Files")}: ${errMsg(e)}`, "err");
    return 0;
  }
}

/** Undo a restore: the files of the branch undo go back to the state they had before going back */
export async function undoFiles(tab: SessionTab, files: { cwd: string; commit: string; paths: string[] }) {
  try {
    const res = await api.rewindUndo(tab.hostId, files.cwd, files.commit, files.paths);
    return res.restored.length + res.deleted.length;
  } catch (e) {
    toast(`${t("Files")}: ${errMsg(e)}`, "err");
    return 0;
  }
}

/** Ids of the session files that share the history of this one (a Pi fork keeps the states of its original) */
function familyIds(tab: SessionTab): string[] {
  const list = state.sessionsByHost.get(tab.hostId) ?? [];
  const own = tab.sessionId ? [tab.sessionId] : [];
  const paths = tab.sessionPath ? branchFamily(list, tab.sessionPath) : [];
  const ids = paths.map((p) => list.find((s) => s.path === p)?.id ?? "").filter(Boolean);
  return [...own, ...ids].filter((id, i, all) => all.indexOf(id) === i);
}

function row(change: RewindChange): HTMLElement {
  return h(
    "li",
    {},
    h("span", { class: `rewind-status s-${change.status}` }, change.status),
    h("span", { class: "rewind-path" }, change.path),
  );
}

/** Confirm the list of files that go back; true = restore them */
function confirmChanges(changes: RewindChange[]): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const close = openModal(
      t("Go back and restore files"),
      h(
        "div",
        {},
        h("p", {}, t("These files go back to the state before this message:")),
        h("ul", { class: "rewind-list" }, ...changes.map(row)),
        h("p", { class: "hint" }, t("M changed · A created (goes away) · D deleted (comes back)")),
      ),
      [
        h("button", { onclick: () => close() }, t("Cancel")),
        h(
          "button",
          {
            class: "primary",
            onclick: () => {
              answer = true;
              close();
            },
          },
          t("Go back"),
        ),
      ],
      () => resolve(answer),
    );
  });
}

/** No state recorded for that point (e.g. the message came from the Pi CLI): go back anyway? */
function askNevertheless(): Promise<boolean> {
  return new Promise((resolve) => {
    let answer = false;
    const close = openModal(
      t("Go back"),
      h("p", {}, t("No file state was recorded for this point – only the conversation goes back.")),
      [
        h("button", { onclick: () => close() }, t("Cancel")),
        h(
          "button",
          {
            class: "primary",
            onclick: () => {
              answer = true;
              close();
            },
          },
          t("Go back anyway"),
        ),
      ],
      () => resolve(answer),
    );
  });
}
