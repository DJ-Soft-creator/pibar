// Versions of a session in the left column: the older files of a branch family (Pi's forks) hang indented and
// collapsible under the newest one, like the subagents. Family logic: shared/branches.ts (versionFamilies).
import { h } from "../shared/dom";
import { t } from "../shared/i18n";
import { versionFamilies } from "../shared/branches";
import { isWorking } from "./activity";
import { metaOf, setMeta } from "./sessionGroups";
import { state } from "./state";
import type { ListRow } from "./sessions";

/** The older versions of one family: the family root (stable meta key) and the rows below the newest version */
export interface VersionNode {
  root: string;
  older: ListRow[];
}

/**
 * Branch families among the rows of a list block: main row key → older versions (newest first). The parent links
 * come from the whole session list of each host, so a family stays together even when some of its files are
 * filtered out of the block.
 */
export function versionMap(rows: ListRow[]): Map<string, VersionNode> {
  const withFile = rows.filter((r) => r.ref.path);
  const out = new Map<string, VersionNode>();
  if (withFile.length < 2) return out;
  const parentOf = new Map<string, string>();
  for (const hostId of new Set(withFile.map((r) => r.ref.hostId))) {
    for (const s of state.sessionsByHost.get(hostId) ?? []) {
      if (s.parent) parentOf.set(`${hostId}|${s.path}`, `${hostId}|${s.parent}`);
    }
  }
  const entries = withFile.map((r) => ({
    key: `${r.ref.hostId}|${r.ref.path}`,
    modified: r.modified,
    created: r.created,
    row: r,
  }));
  for (const [key, v] of versionFamilies(entries, parentOf)) {
    out.set(key, { root: v.root, older: v.older.map((e) => e.row) });
  }
  return out;
}

/** Fold the older versions away / bring them back; the state lives on the family root (SessionMeta) */
function toggleVersions(root: string, closed: boolean) {
  setMeta(root, { versionsCollapsed: !closed });
}

/**
 * The fold triangle in front of the newest version's session row (the same language as the group heads): a click
 * folds the older versions away, the row itself still opens the session. Turns sideways when folded.
 */
export function versionChevron(node: VersionNode): HTMLElement {
  const closed = !!metaOf(node.root).versionsCollapsed;
  return h(
    "button",
    {
      type: "button",
      class: `chev sess-ver-chev ${closed ? "collapsed" : ""}`,
      title: closed ? t("Expand") : t("Collapse"),
      "aria-expanded": closed ? "false" : "true",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        toggleVersions(node.root, closed);
      },
    },
    "▾",
  );
}

/**
 * The "Versions" block under the newest version's row: a heading that folds the older versions away (saved on the
 * family root, so the state survives when another version becomes the newest) and one session row per older file.
 * A folded block still shows a dot when the version in the chat is one of its children.
 */
export function versionKids(node: VersionNode, renderItem: (r: ListRow) => HTMLElement): HTMLElement {
  const closed = !!metaOf(node.root).versionsCollapsed;
  const working = node.older.some((r) => r.running || isWorking(r.ref.tab ?? undefined));
  const activeInside = node.older.some((r) => !!r.ref.tab && r.ref.tab === state.active);
  const head = h(
    "button",
    {
      type: "button",
      class: `sess-kids-head ${closed ? "collapsed" : ""}`,
      title: closed ? t("Expand") : t("Collapse"),
      "aria-expanded": closed ? "false" : "true",
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        toggleVersions(node.root, closed);
      },
    },
    h("span", { class: "chev" }, "▾"),
    t("Versions"),
    working ? h("span", { class: "sess-state busy sa-spin", title: t("Pi is working …") }) : null,
    closed && activeInside
      ? h("span", { class: "ver-active", title: t("The version shown in the chat is in here") })
      : null,
    h("span", { class: "count" }, String(node.older.length)),
  );
  return h(
    "div",
    { class: "sess-kids" },
    head,
    ...(closed ? [] : node.older.map((r) => h("div", { class: "sess-kid" }, renderItem(r)))),
  );
}
