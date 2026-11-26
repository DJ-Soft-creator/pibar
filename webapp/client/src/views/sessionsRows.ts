// Rows of the session list and their order inside one block (a host or a project), like sessionSections in
// src/main/sessions.ts: pinned first, then the groups (coloured, collapsible, the archive last), then the rest in
// date or folder sections that can be closed. Older versions of a session (Pi's forks, versionFamilies of
// src/shared/branches.ts) hang folded under the newest one. A row opens the chat; "⋯" or a long press opens its sheet.
import type { SessionGroup, SessionInfo } from "@shared/api";
import { versionFamilies } from "@shared/branches";
import { h } from "@shared/dom";
import { cleanTitle, relTime, shortPath } from "@shared/format";
import { getLang, t } from "@shared/i18n";
import { projectAt } from "@shared/projects";
import { colorLabel } from "@shared/sessionColors";
import { rowTime, sectionRows, sortRows, type OrderRow } from "@shared/sessionOrder";
import { openChat, state } from "../state";
import {
  data,
  groupClosed,
  groups,
  isCollapsed,
  keyOf,
  markSeen,
  metaOf,
  prefs,
  projects,
  setMeta,
  titleOf,
  toggleCollapsed,
  toggleGroup,
} from "./sessionsData";
import { selection, toggleSelected } from "./sessionsSelect";

/** Fixed id of the archive group (src/main/cleanup.ts) */
export const ARCHIVE = "archive";

export interface ListRow extends OrderRow {
  key: string;
  hostId: string;
  s: SessionInfo;
  running: boolean;
  unread: boolean;
  color: string;
}

/** Session rows of a host from its loaded list */
export function hostRows(hostId: string): ListRow[] {
  return (state.sessions.get(hostId) ?? []).map((s) => {
    const key = keyOf(hostId, s.path);
    const m = metaOf(key);
    return {
      key,
      hostId,
      s,
      title: titleOf(hostId, s),
      cwd: s.cwd,
      created: Date.parse(s.timestamp) || 0,
      modified: (s.modified ?? 0) * 1000,
      running: data.working.has(key) || !!m.backgroundAt,
      unread: !!m.unread || data.unseen.has(key),
      color: m.color ?? "",
    };
  });
}

/**
 * Project a row belongs to: the one chosen in its sheet ("Move to project", meta.project, same host), otherwise the
 * project whose folder holds its working folder (src/shared/projects.ts).
 */
export function projectIdOf(r: Pick<ListRow, "key" | "hostId" | "cwd">): string | undefined {
  const own = metaOf(r.key).project;
  if (own && projects().some((p) => p.id === own && p.hostId === r.hostId)) return own;
  return projectAt(projects(), r.hostId, r.cwd)?.id;
}

export function hostName(hostId: string): string {
  return state.hosts.find((x) => x.id === hostId)?.name ?? hostId;
}

/** Open a session in the chat; its unread marks go away */
export function openRow(r: Pick<ListRow, "key" | "hostId" | "s">) {
  markSeen(r.key);
  openChat({ hostId: r.hostId, hostName: hostName(r.hostId), path: r.s.path, cwd: r.s.cwd, title: cleanTitle(titleOf(r.hostId, r.s)) });
}

export function sectionLabel(key: string, by: string): string {
  if (by === "folder") return shortPath(key) || "~";
  const fixed: Record<string, string> = {
    today: t("Today"),
    yesterday: t("Yesterday"),
    week: t("Last 7 days"),
    month: t("Last 30 days"),
  };
  if (fixed[key]) return fixed[key];
  const [y, m] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, 1).toLocaleDateString(getLang(), { month: "long", year: "numeric" });
}

/** Working / unread counts of some rows, as small pills at a heading */
export function marks(rows: ListRow[]): HTMLElement[] {
  const working = rows.filter((r) => r.running).length;
  const unread = rows.filter((r) => !r.running && r.unread).length;
  return [
    working ? h("span", { class: "sl-mark busy", title: t("Pi is working …") }, h("span", { class: "sl-spin" }), String(working)) : null,
    unread ? h("span", { class: "sl-mark unread", title: t("Not read yet") }, `● ${unread}`) : null,
  ].filter((x): x is HTMLElement => !!x);
}

/** Press and hold (500 ms, finger still): `fn`; the click that follows the release is swallowed */
export function onLongPress(el: HTMLElement, fn: () => void) {
  let timer = 0;
  let x = 0;
  let y = 0;
  let fired = false;
  const cancel = () => clearTimeout(timer);
  el.addEventListener("pointerdown", (e: PointerEvent) => {
    fired = false;
    x = e.clientX;
    y = e.clientY;
    cancel();
    timer = window.setTimeout(() => {
      fired = true;
      navigator.vibrate?.(10);
      fn();
    }, 500);
  });
  el.addEventListener("pointermove", (e: PointerEvent) => {
    if (Math.abs(e.clientX - x) > 10 || Math.abs(e.clientY - y) > 10) cancel();
  });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, cancel);
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener(
    "click",
    (e) => {
      if (!fired) return;
      fired = false;
      e.stopImmediatePropagation();
      e.preventDefault();
    },
    true,
  );
}

export interface RowActions {
  /** The sheet of a session (rename, colour, …) */
  sheet(r: ListRow): void;
  /** The sheet of a group */
  groupSheet(g: SessionGroup): void;
}

const PIN =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.8 1.5 14.5 6.2l-1.4.4-2.6 2.6.3 3.3-1.2 1.2-2.9-2.9-3.6 3.6-.7-.7 3.6-3.6L3.1 7.3l1.2-1.2 3.3.3 2.6-2.6z"/></svg>';

/** One session row: colour, pin, spinner, title, folder · time, pill and "⋯" */
export function sessionRow(r: ListRow, act: RowActions, versions?: { root: string; count: number }): HTMLElement {
  const m = metaOf(r.key);
  const selecting = selection.on;
  const selected = selection.keys.has(r.key);
  const title = h("span", { class: "sl-title" }, cleanTitle(r.title) || t("New session"));
  if (r.running) title.prepend(h("span", { class: "sl-spin", title: t("Pi is working …") }));
  if (m.pinned) {
    const pin = h("span", { class: "sl-pin" });
    pin.innerHTML = PIN;
    title.prepend(pin);
  }
  if (m.remindAt) title.append(h("span", { class: "sl-bell", title: t("Reminder") }, "⏰"));
  const when = rowTime(r, prefs().sort);
  const metaLine = r.running
    ? [t("Pi is working …"), shortPath(r.cwd)]
    : [shortPath(r.cwd) || "~", when ? relTime(when) : ""];
  const el = h(
    "div",
    {
      class: `sl-row ${r.color ? `colored c-${r.color}` : ""} ${r.unread ? "unread" : ""} ${r.running ? "working" : ""} ${selected ? "selected" : ""}`,
      role: "button",
      tabindex: 0,
      "data-key": r.key,
      "aria-label": cleanTitle(r.title),
      title: [cleanTitle(r.title), r.cwd, r.color ? colorLabel(r.color, data.labels) : ""].filter(Boolean).join("\n"),
      onclick: () => (selecting ? toggleSelected(r.key) : openRow(r)),
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter") (selecting ? toggleSelected(r.key) : openRow(r));
      },
    },
    selecting ? h("span", { class: `sl-check ${selected ? "on" : ""}`, "aria-hidden": "true" }, selected ? "✓" : "") : null,
    versions
      ? h(
          "button",
          {
            type: "button",
            class: `sl-chev ver ${metaOf(versions.root).versionsCollapsed ? "collapsed" : ""}`,
            title: t("Versions"),
            "aria-label": t("Versions"),
            "aria-expanded": metaOf(versions.root).versionsCollapsed ? "false" : "true",
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              void setMeta(versions.root, { versionsCollapsed: !metaOf(versions.root).versionsCollapsed });
            },
          },
          "▾",
        )
      : null,
    h("div", { class: "sl-main" }, title, h("span", { class: "sl-meta" }, metaLine.filter(Boolean).join(" · "))),
    r.running
      ? h("span", { class: "sl-pill busy" }, t("working"))
      : r.unread
        ? h("span", { class: "sl-pill unread", title: t("Not read yet") }, t("unread"))
        : null,
    selecting
      ? null
      : h(
          "button",
          {
            type: "button",
            class: "sl-more",
            title: t("More …"),
            "aria-label": t("More …"),
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              act.sheet(r);
            },
          },
          "⋯",
        ),
  );
  if (!selecting) onLongPress(el, () => act.sheet(r));
  return el;
}

/** Older versions per main row among `rows` (parent links from the host's whole list, so families stay whole) */
function versionMap(rows: ListRow[]): Map<string, { root: string; older: ListRow[] }> {
  const parentOf = new Map<string, string>();
  for (const hostId of new Set(rows.map((r) => r.hostId))) {
    for (const s of state.sessions.get(hostId) ?? []) if (s.parent) parentOf.set(keyOf(hostId, s.path), keyOf(hostId, s.parent));
  }
  return versionFamilies(rows, parentOf);
}

function head(id: string, label: string, rows: ListRow[], extra: (HTMLElement | null)[] = [], cls = ""): HTMLElement {
  const closed = isCollapsed(id);
  return h(
    "button",
    {
      type: "button",
      class: `sl-sec ${cls} ${closed ? "collapsed" : ""}`,
      "aria-expanded": closed ? "false" : "true",
      onclick: () => toggleCollapsed(id),
    },
    h("span", { class: "sl-chev" }, "▾"),
    h("span", { class: "sl-sec-name" }, label),
    ...marks(rows),
    ...extra,
    h("span", { class: "sl-count" }, String(rows.length)),
  );
}

/**
 * The rows of one block in display order. `block` ("h:<host>" or "p:<project>") keeps the open/closed state of its
 * groups and sections apart from the other blocks; while searching everything stays flat.
 */
export function sessionSections(rows: ListRow[], block: string, act: RowActions, searching: boolean): HTMLElement[] {
  const { sort, sections: by } = prefs();
  const versions = searching ? new Map<string, { root: string; older: ListRow[] }>() : versionMap(rows);
  const older = new Set([...versions.values()].flatMap((v) => v.older.map((r) => r.key)));
  const mains = rows.filter((r) => !older.has(r.key));
  const item = (r: ListRow): HTMLElement[] => {
    const v = versions.get(r.key);
    if (!v) return [sessionRow(r, act)];
    const closed = !!metaOf(v.root).versionsCollapsed;
    return [
      sessionRow(r, act, { root: v.root, count: v.older.length }),
      closed
        ? h("div", { class: "sl-vers-note" }, `${t("Versions")}: ${v.older.length}`)
        : h("div", { class: "sl-vers" }, ...v.older.map((o) => sessionRow(o, act))),
    ];
  };
  const out: HTMLElement[] = [];
  const pinned = sortRows(
    mains.filter((r) => metaOf(r.key).pinned),
    sort,
  );
  const rest = mains.filter((r) => !metaOf(r.key).pinned);
  if (pinned.length) {
    out.push(h("div", { class: "sl-sec static" }, h("span", { class: "sl-sec-name" }, `📌 ${t("Pinned")}`)), ...pinned.flatMap(item));
  }
  const ids = new Set(groups().map((g) => g.id));
  const ordered = [...groups().filter((g) => g.id !== ARCHIVE), ...groups().filter((g) => g.id === ARCHIVE)];
  for (const g of ordered) {
    const inGroup = sortRows(
      rest.filter((r) => metaOf(r.key).group === g.id),
      sort,
    );
    if (!inGroup.length) continue;
    const closed = groupClosed(block, g);
    out.push(
      h(
        "div",
        { class: `sl-group ${g.color ? `c-${g.color}` : ""} ${closed ? "collapsed" : ""} ${g.id === ARCHIVE ? "archive" : ""}` },
        h(
          "div",
          { class: "sl-group-head" },
          h(
            "button",
            {
              type: "button",
              class: "sl-group-toggle",
              "aria-expanded": closed ? "false" : "true",
              onclick: () => toggleGroup(block, g),
            },
            h("span", { class: "sl-chev" }, "▾"),
            h("span", { class: "sl-dot", title: g.color ? colorLabel(g.color, data.labels) : t("Colour of the group") }),
            h("span", { class: "sl-group-name" }, g.name),
            ...marks(inGroup),
            h("span", { class: "sl-count" }, String(inGroup.length)),
          ),
          h(
            "button",
            {
              type: "button",
              class: "sl-more",
              title: t("More …"),
              "aria-label": `${t("More …")} ${g.name}`,
              onclick: () => act.groupSheet(g),
            },
            "⋯",
          ),
        ),
        ...(closed ? [] : inGroup.flatMap(item)),
      ),
    );
  }
  const loose = rest.filter((r) => !ids.has(metaOf(r.key).group ?? ""));
  for (const sec of sectionRows(loose, sort, by)) {
    if (!sec.key) {
      out.push(...sec.rows.flatMap(item));
      continue;
    }
    const id = `s:${block}|${by}|${sec.key}`;
    out.push(head(id, sectionLabel(sec.key, by), sec.rows, [], "date"));
    if (!isCollapsed(id)) out.push(...sec.rows.flatMap(item));
  }
  return out;
}

export { head as blockSectionHead };
