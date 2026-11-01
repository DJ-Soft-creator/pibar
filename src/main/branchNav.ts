// Versions of a message: where the current session and its branches (Pi forks) part, shown as "‹ 2/3 ›" under the
// own messages (SessionTab.showBranches). The logic lives in src/shared/branches.ts, the data comes from the session
// list (`parent`) and the Rust core (`session_outlines`).
import { api } from "../shared/api";
import { branchesAt, branchFamily, type BranchChoice } from "../shared/branches";
import type { SessionTab } from "./sessionTab";
import { state } from "./state";

/** Recompute and show the versions for a session; `pick` switches to one of them */
export async function refreshBranches(tab: SessionTab, pick: (choice: BranchChoice, index: number) => void) {
  const path = tab.sessionPath;
  const list = state.sessionsByHost.get(tab.hostId) ?? [];
  const family = path ? branchFamily(list, path) : [];
  if (!path || !tab.alive || family.length < 2) return tab.showBranches(new Map(), 0, pick);
  const [points, outlines] = await Promise.all([tab.forkPoints(), api.sessionOutlines(tab.hostId, family)]);
  if (tab.sessionPath !== path) return; // switched meanwhile
  const created = new Map(list.map((s) => [s.path, s.timestamp]));
  for (const o of outlines) o.created = created.get(o.path);
  const ids = points.map((p) => ({ id: p.entryId, text: p.text }));
  tab.showBranches(branchesAt(path, ids, outlines), Math.max(0, ids.length - tab.userMessages), pick);
}
