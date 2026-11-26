// Session list of the webapp – the desktop's left column (src/main/sessions.ts) adapted to the phone: every host the
// user may use as a collapsible block (a host filter narrows it), the projects below with the sessions of their
// folders, reminders and full-text hits at the top, search, view sheet, select mode and pull to refresh. Rows,
// groups and sections: sessionsRows.ts; data and own list settings: sessionsData.ts; sheets: sessionsSheet.ts,
// sessionsOrg.ts. Opening a session = openChat (state.ts); a new one = startNewSession (newSession.ts).
import "./sessions.css";
import type { Project } from "@shared/api";
import { h } from "@shared/dom";
import { shortPath } from "@shared/format";
import { t } from "@shared/i18n";
import { colorLabel } from "@shared/sessionColors";
import { isSearching, matchesQuery } from "@shared/search";
import { passesFilter } from "@shared/listFilter";
import { go, isAdmin, state } from "../state";
import { button, empty, header } from "../ui";
import { startNewSession } from "./newSession";
import {
  data,
  isCollapsed,
  keyOf,
  loadActivity,
  loadHost,
  loadLabels,
  loadMeta,
  prefs,
  projects,
  reloadAll,
  rerender,
  setPrefs,
  setRenderer,
  toggleCollapsed,
  wireData,
} from "./sessionsData";
import { groupSheet, newSessionInProject, projectDialog, projectSheet, viewSheet } from "./sessionsOrg";
import { remindersBlock } from "./sessionsReminders";
import { hostRows, marks, projectIdOf, sessionSections, type ListRow, type RowActions } from "./sessionsRows";
import { hitsBlock, researchHosts, search, setQuery } from "./sessionsSearch";
import { selection, selectionBar, setSelecting } from "./sessionsSelect";
import { archiveKeys, colorPicker, deleteDialog, groupPicker, pinKeys, sessionSheet } from "./sessionsSheet";
import { actionSheet, run } from "./sessionsUi";

/** The parts of the view that survive a redraw of the list (the search field keeps focus and keyboard) */
const view = {
  root: null as HTMLElement | null,
  body: null as HTMLElement | null,
  bar: null as HTMLElement | null,
  host: null as HTMLSelectElement | null,
};

const actions: RowActions = { sheet: sessionSheet, groupSheet };

let started = false;
/** First visit: load what every list needs; the hosts' session lists load as their blocks appear */
function start() {
  if (started) return;
  started = true;
  wireData();
  void loadMeta();
  void loadLabels();
  void loadActivity();
  // due reminders turn red without a reload
  window.setInterval(() => rerender(), 30_000);
}

function newSession() {
  const host = prefs().host;
  const list = host ? state.hosts.filter((x) => x.id === host) : state.hosts;
  if (list.length === 1 && list[0]) return startNewSession({ hostId: list[0].id, hostName: list[0].name });
  actionSheet(
    t("New session"),
    list.map((x) => ({ label: x.name, desc: x.defaultDir || "~", onSelect: () => startNewSession({ hostId: x.id, hostName: x.name }) })),
  );
}

const iconBtn = (label: string, text: string, onclick: () => void, cls = "") =>
  h("button", { type: "button", class: `icon-btn ${cls}`, title: label, "aria-label": label, onclick }, text);

export function renderSessions(root: HTMLElement) {
  if (!state.hosts.length) {
    setRenderer(null);
    root.replaceChildren(
      header(t("Sessions")),
      isAdmin()
        ? empty(t("No hosts yet."), button(t("Add host"), () => go("admin/hosts"), "primary"))
        : empty(t("No host has been assigned to you yet. Ask the admin.")),
    );
    return;
  }
  start();
  const p = prefs();
  const input = h("input", {
    type: "search",
    class: "search",
    placeholder: t("Search"),
    "aria-label": t("Search"),
    value: search.query,
    enterkeyhint: "search",
    oninput: (e: Event) => setQuery((e.target as HTMLInputElement).value),
  });
  view.host =
    state.hosts.length > 1
      ? h(
          "select",
          {
            class: "host-picker",
            "aria-label": t("Host"),
            onchange: (e: Event) => {
              setPrefs({ host: (e.target as HTMLSelectElement).value });
              researchHosts();
            },
          },
          h("option", { value: "", selected: !p.host }, t("All hosts")),
          ...state.hosts.map((x) => h("option", { value: x.id, selected: x.id === p.host }, x.name)),
        )
      : null;
  view.body = h("div", { class: "sl-body" });
  view.bar = h("div", { class: "sl-bar-slot" });
  const head = header(t("Sessions"), [
    iconBtn(t("Select sessions …"), "☑", () => setSelecting(!selection.on), "sl-head-btn"),
    iconBtn(t("View"), "⇅", viewSheet, "sl-head-btn"),
    iconBtn(t("Reload"), "↻", reloadAll, "sl-head-btn"),
    iconBtn(t("New session"), "+", newSession),
  ]);
  const container = h("div", { class: "sl" }, head, h("div", { class: "toolbar" }, input, view.host), view.body, view.bar);
  root.replaceChildren(container);
  view.root = container;
  pullToRefresh(root, container);
  setRenderer(fill);
  fill();
}

/** Pull down at the top of the list: reload everything */
function pullToRefresh(scroller: HTMLElement, el: HTMLElement) {
  let y0 = -1;
  const hint = h("div", { class: "sl-pull", "aria-hidden": "true" }, "↓");
  el.prepend(hint);
  el.addEventListener(
    "touchstart",
    (e: TouchEvent) => {
      y0 = scroller.scrollTop <= 0 && e.touches[0] ? e.touches[0].clientY : -1;
    },
    { passive: true },
  );
  el.addEventListener(
    "touchmove",
    (e: TouchEvent) => {
      if (y0 < 0 || !e.touches[0]) return;
      const dy = e.touches[0].clientY - y0;
      hint.style.height = `${Math.max(0, Math.min(dy - 10, 70))}px`;
      hint.classList.toggle("ready", dy > 80);
    },
    { passive: true },
  );
  el.addEventListener("touchend", () => {
    if (hint.classList.contains("ready")) reloadAll();
    hint.classList.remove("ready");
    hint.style.height = "0";
    y0 = -1;
  });
}

/** What the filter chip says: "Only what I am working on · Red" */
function filterText(): string {
  const p = prefs();
  return [
    p.filter === "active" ? t("Only what I am working on") : "",
    p.colors.map((c) => (c === "none" ? t("No colour") : colorLabel(c, data.labels))).join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Draw the list part (blocks, hits, reminders, selection bar) */
function fill() {
  const body = view.body;
  if (!body || !view.root?.isConnected) return;
  const p = prefs();
  const searching = isSearching(search.query);
  const filtering = p.filter === "active" || p.colors.length > 0;
  const trimmed = searching || filtering;
  const hosts = state.hosts.filter((x) => !p.host || x.id === p.host);
  for (const x of hosts) if (!state.sessions.has(x.id) && !state.sessionErrors.has(x.id)) void loadHost(x.id);
  const open = state.chat?.path ? keyOf(state.chat.hostId, state.chat.path) : "";
  const keep = (r: ListRow) =>
    (!searching || matchesQuery([r.title, r.s.title, r.cwd], search.query)) &&
    (!filtering || passesFilter({ ...r, open: r.key === open }, p.filter, p.colors));
  const rowsByHost = new Map(hosts.map((x) => [x.id, hostRows(x.id).filter(keep)]));
  const shownProjects = projects().filter((pr) => rowsByHost.has(pr.hostId));
  const projectRows = (pr: Project) => (rowsByHost.get(pr.hostId) ?? []).filter((r) => projectIdOf(r) === pr.id);
  const inProject = new Set(shownProjects.flatMap((pr) => projectRows(pr).map((r) => r.key)));
  const visible: string[] = [];

  const out: (HTMLElement | null)[] = [];
  if (data.metaError) out.push(h("p", { class: "error banner" }, data.metaError));
  if (filtering)
    out.push(
      h(
        "div",
        { class: "sl-chip" },
        h("span", {}, h("strong", {}, `${t("Filter")}: `), filterText()),
        h(
          "button",
          { type: "button", class: "sl-chip-x", "aria-label": t("Clear filter"), onclick: () => setPrefs({ filter: "all", colors: [] }) },
          "×",
        ),
      ),
    );
  // while searching the hits take the top; the reminders come back with the whole list
  out.push(searching ? null : remindersBlock(), hitsBlock());

  for (const host of hosts) {
    const all = rowsByHost.get(host.id) ?? [];
    const own = all.filter((r) => !inProject.has(r.key));
    const err = state.sessionErrors.get(host.id);
    const list = state.sessions.get(host.id);
    if (trimmed && !own.length && !err) continue;
    visible.push(...own.map((r) => r.key));
    const id = `h:${host.id}`;
    const closed = isCollapsed(id);
    const where = `SSH · ${host.sshUser ? `${host.sshUser}@` : ""}${host.sshTarget}`;
    out.push(
      h(
        "section",
        { class: `sl-block sl-host ${closed ? "collapsed" : ""}` },
        h(
          "div",
          { class: "sl-block-row" },
          h(
            "button",
            { type: "button", class: "sl-block-head", "aria-expanded": closed ? "false" : "true", onclick: () => toggleCollapsed(id) },
            h("span", { class: "sl-chev" }, "▾"),
            h("span", { class: "sl-block-name" }, host.name, h("small", {}, where)),
            ...marks(own),
            data.loading.has(host.id) ? h("span", { class: "sl-spin", title: t("Loading …") }) : null,
            h("span", { class: "sl-count" }, list ? String(own.length) : "…"),
          ),
          iconBtn(t("New session on {host}", { host: host.name }), "+", () => startNewSession({ hostId: host.id, hostName: host.name }), "sl-add"),
        ),
        closed
          ? null
          : h(
              "div",
              { class: "sl-block-body" },
              err ? h("div", { class: "sl-error" }, err, " ", button(t("Reload"), () => void loadHost(host.id))) : null,
              !list && !err ? h("div", { class: "sl-hint" }, t("Loading …")) : null,
              ...sessionSections(own, id, actions, searching),
              list && !own.length && !trimmed
                ? h("div", { class: "sl-hint" }, list.length ? t("All sessions are in projects") : t("No sessions yet"))
                : null,
            ),
      ),
    );
  }

  const projBlocks = shownProjects
    .map((pr) => ({ pr, rows: projectRows(pr) }))
    .filter((x) => !trimmed || x.rows.length)
    .map(({ pr, rows }) => {
      visible.push(...rows.map((r) => r.key));
      const id = `p:${pr.id}`;
      const closed = isCollapsed(id);
      const where = [shortPath(pr.dir) || "~", state.hosts.length > 1 ? state.hosts.find((x) => x.id === pr.hostId)?.name : ""]
        .filter(Boolean)
        .join(" · ");
      return h(
        "section",
        { class: `sl-block sl-proj ${closed ? "collapsed" : ""}` },
        h(
          "div",
          { class: "sl-block-row" },
          h(
            "button",
            { type: "button", class: "sl-block-head", "aria-expanded": closed ? "false" : "true", onclick: () => toggleCollapsed(id) },
            h("span", { class: "sl-chev" }, "▾"),
            h("span", { class: "sl-block-name" }, pr.name, h("small", {}, where)),
            ...marks(rows),
            h("span", { class: "sl-count" }, String(rows.length)),
          ),
          iconBtn(t("New session in {project}", { project: pr.name }), "+", () => newSessionInProject(pr), "sl-add"),
          iconBtn(`${t("More …")} ${pr.name}`, "⋯", () => projectSheet(pr), "sl-add"),
        ),
        closed
          ? null
          : h(
              "div",
              { class: "sl-block-body" },
              ...sessionSections(rows, id, actions, searching),
              rows.length ? null : h("div", { class: "sl-hint" }, t("No sessions yet")),
            ),
      );
    });
  if (!trimmed || projBlocks.length) {
    out.push(
      h(
        "div",
        { class: "sl-projects" },
        h("h2", { class: "sl-rubric" }, t("Projects")),
        ...projBlocks,
        trimmed ? null : h("button", { type: "button", class: "sl-new-proj", onclick: () => projectDialog() }, `＋ ${t("New project …")}`),
      ),
    );
  }
  if (trimmed && !visible.length && !searching)
    out.push(empty(t("No session matches this filter."), button(t("Show everything"), () => setPrefs({ filter: "all", colors: [] }))));
  if (searching && !visible.length && search.done && !search.hits.size) out.push(empty(t("No session matches.")));

  body.replaceChildren(...out.filter((x): x is HTMLElement => !!x));
  // the selection only keeps what is still in the list
  for (const k of [...selection.keys]) if (!visible.includes(k)) selection.keys.delete(k);
  view.bar?.replaceChildren(
    ...(selection.on
      ? [
          selectionBar(visible, {
            group: groupPicker,
            color: colorPicker,
            pin: pinKeys,
            archive: (keys) => run(() => archiveKeys(keys)),
            remove: deleteDialog,
          }),
        ]
      : []),
  );
  view.root.classList.toggle("selecting", selection.on);
}
