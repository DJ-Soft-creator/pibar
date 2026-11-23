// Left column: hosts and sessions (pinned, in coloured groups, the rest), the "Projects" rubric below the hosts;
// open, activate, close and create sessions.
import { folderField } from "./folderPicker";
import {
  activityOfRows,
  hostMarks,
  isWorking,
  markSeen,
  markSettled,
  marks,
  sessionMark,
  sessionPill,
} from "./activity";
import { ARCHIVE } from "./cleanup";
import {
  api,
  type HostCfg,
  type Project,
  type SearchHit,
  type SessionInfo,
  type SessionMeta,
  type SessionPreset,
} from "../shared/api";
import { $, h, copyText, errMsg, openModal, toast } from "../shared/dom";
import { icon, IconName } from "../shared/icons";
import { cleanTitle, relTime, shortPath, splitScreenText, stripAnswerStyle } from "../shared/format";
import { PLAN_TOOLS, stripPlanMode } from "../shared/planMode";
import { presetForNewSession, splitModelKey } from "../shared/presets";
import { filterSet, passesFilter, type SessionFilterMode } from "../shared/listFilter";
import { highlight, isSearching, matchesQuery, roleLabel } from "../shared/search";
import {
  rowTime,
  sectionRows,
  sortRows,
  type OrderRow,
  type SessionGroupBy,
  type SessionSort,
} from "../shared/sessionOrder";
import { openMenu, type MenuEntry } from "./menu";
import { COLORS } from "../shared/sessionColors";
import { getLang, t, type Msg } from "../shared/i18n";
import { fillInput, renderToolbar, showEmpty, showTab } from "./chatView";
import { closeEditor, reloadFiles, renderFiles } from "./files";
import { refreshBranches } from "./branchNav";
import { applyRewind, planRewind, undoFiles, type RewindPlan } from "./rewindFiles";
import { questionDialog, uiRequest } from "./answerDialog";
import { answerStarted } from "./autoScroll";
import { applyChatColors } from "./colors";
import { broadcastActive } from "./quickBridge";
import { blockDrop, blockGrip } from "./blockDrag";
import { projects, projectOf, renderProjects } from "./projects";
import { reminderFor, reminderDialog, renderReminders } from "./reminders";
import {
  applyOrder,
  clearUnread,
  colorName,
  displayTitle,
  groupMenu,
  groups,
  metaOf,
  refKey,
  renameDialog as renameDialogFor,
  SessionRef,
  sessionMenu,
  setMeta,
  setMetaMany,
  groupCollapsed,
  toggleGroup,
} from "./sessionGroups";
import { sessionKids, subagentClosed } from "./subagents";
import { versionChevron, versionKids, versionMap, type VersionNode } from "./sessionVersions";
import {
  blockKeysOf,
  dragStart,
  dropTarget,
  noteVisible,
  renderSelectionBar,
  resetOrder,
  selectClick,
  selection,
  startBlock,
} from "./sessionSelect";
import { SessionTab, TabCallbacks, UserAction } from "./sessionTab";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";
import { focusSessionTab, refreshTermTabs } from "./terminal";

const elHostList = $("host-list");
const elFilterBtn = $("btn-list-filter");
$("btn-session-view").addEventListener("click", (e) => viewMenu(e.currentTarget as HTMLElement));
elFilterBtn.addEventListener("click", (e) => filterMenu(e.currentTarget as HTMLElement));
const elHostTabs = $("host-tabs");

// The session on screen counts as read: back in the window, its "unread" mark goes away too (activity.ts marks
// `unseen` on the tab; the mark that outlives the tab – "Mark as unread" and an unseen run – lives in the meta)
window.addEventListener("focus", () => {
  if (state.active) clearUnread(state.active.key);
});

/** What the dot in front of a host or a project means: its connection state (title of the dot) */
export function hostStatusTitle(st?: { state: string; error?: string }): string {
  if (st?.state === "err") return st.error || t("Not reachable");
  if (st?.state === "busy") return t("Checking …");
  return st?.state === "ok" ? t("Connected") : t("Checking …");
}

/**
 * Connection dot of a host or a project: only when there is something to report (not reachable, checking). A green
 * dot for "connected" looked like a notification and confused – the normal case needs no mark.
 */
export function hostStatusDot(st?: { state: string; error?: string }): HTMLElement | null {
  if (!st || !st.state || st.state === "ok") return null;
  return h("span", { class: `dot ${st.state}`, title: hostStatusTitle(st) });
}

// ---------- Loading ----------

export async function loadSessions(hostId: string) {
  state.hostStatus.set(hostId, { state: "busy" });
  renderHosts();
  try {
    state.sessionsByHost.set(hostId, await api.listSessions(hostId));
    state.hostStatus.set(hostId, { state: "ok" });
  } catch (e) {
    state.hostStatus.set(hostId, { state: "err", error: errMsg(e) });
  }
  renderHosts();
}

export function loadAllSessions() {
  return Promise.all(state.config.hosts.map((x) => loadSessions(x.id)));
}

// ---------- Host switcher (top left) ----------

/** Selected host ("all" = all hosts, grouped) */
export function selectedHost(): string {
  const sel = state.config.ui.selectedHost || "all";
  return sel === "all" || state.config.hosts.some((x) => x.id === sel) ? sel : "all";
}

function selectHost(id: string) {
  state.config.ui.selectedHost = id;
  saveConfig();
  renderHosts();
  // the search only asks the hosts that are shown (src/main/search.ts)
  window.dispatchEvent(new Event("pibar-host-changed"));
  void restoreHostSession(id);
}

/** Remember which session was shown for a host, so switching hosts brings it back */
function rememberSession(tab: SessionTab | null) {
  if (!tab?.sessionPath) return;
  const map = (state.config.ui.sessionByHost ??= {});
  if (map[tab.hostId] === tab.sessionPath) return;
  map[tab.hostId] = tab.sessionPath;
  saveConfig();
}

/** Another host chosen: show the session that was last shown there (nothing to do for "All") */
async function restoreHostSession(hostId: string) {
  if (hostId === "all" || state.active?.hostId === hostId) return;
  const path = state.config.ui.sessionByHost?.[hostId];
  if (!path) return;
  const open = [...state.tabs.values()].find((x) => x.hostId === hostId && x.sessionPath === path);
  if (open) {
    activate(open);
    return;
  }
  const info = state.sessionsByHost.get(hostId)?.find((s) => s.path === path);
  if (!info) return; // deleted or not loaded: the chat stays as it is
  await openSession(hostId, path, info.cwd, info.name || info.title);
}

/**
 * After PiBar started: bring back the session that was open when it was closed, so the chat comes back with the model
 * and context mode saved for it (see SessionTab.applyChoice/applyContext). The host tab remembers one session per host.
 */
export function restoreLastSession() {
  const sel = selectedHost();
  if (sel === "all") return Promise.resolve();
  return restoreHostSession(sel);
}

function toggleCollapsed(id: string) {
  const c = new Set(state.config.ui.collapsedHosts ?? []);
  if (c.has(id)) c.delete(id);
  else c.add(id);
  state.config.ui.collapsedHosts = [...c];
  saveConfig();
  renderHosts();
}

/** Open sessions of a host that are not saved yet (no session file) */
function unsavedTabs(hostId: string): SessionTab[] {
  const list = state.sessionsByHost.get(hostId) ?? [];
  return [...state.tabs.values()].filter((x) => x.hostId === hostId && !list.some((s) => s.path === x.sessionPath));
}

function sessionCount(hostId: string): number {
  return (state.sessionsByHost.get(hostId)?.length ?? 0) + unsavedTabs(hostId).length;
}

function renderHostTabs() {
  const sel = selectedHost();
  // two or more hosts no longer fit side by side in the narrow column: one row per host, names in full
  elHostTabs.classList.toggle("stacked", state.config.hosts.length >= 2);
  const tab = (id: string, label: string, count: number, st?: { state: string; error?: string }) =>
    h(
      "button",
      { class: `host-tab ${sel === id ? "active" : ""}`, onclick: () => selectHost(id), title: label },
      hostStatusDot(st),
      h("span", { class: "host-tab-name" }, label),
      ...hostMarks(id === "all" ? undefined : id),
      h("span", { class: "count" }, String(count)),
    );
  elHostTabs.replaceChildren(
    tab(
      "all",
      t("All"),
      state.config.hosts.reduce((n, x) => n + sessionCount(x.id), 0),
    ),
    ...state.config.hosts.map((x) => tab(x.id, x.name, sessionCount(x.id), state.hostStatus.get(x.id))),
  );
}

// ---------- List ----------

/** Move a host block before or after another one (drag by the grip); the order in the config is saved */
function moveHost(fromId: string, toId: string, after: boolean) {
  const list = state.config.hosts;
  const from = list.findIndex((x) => x.id === fromId);
  if (from < 0 || fromId === toId) return;
  const [moved] = list.splice(from, 1);
  let to = list.findIndex((x) => x.id === toId);
  if (to < 0) {
    list.splice(from, 0, moved);
    return;
  }
  if (after) to += 1;
  list.splice(to, 0, moved);
  saveConfig();
  renderHosts();
}

/** Session rows of a host: open sessions without a file first, then Pi's session list */
export function hostRows(host: HostCfg): ListRow[] {
  const list = state.sessionsByHost.get(host.id) ?? [];
  const openNew = unsavedTabs(host.id);
  return [
    ...openNew.map((x) => ({
      ref: { hostId: host.id, path: x.sessionPath ?? "", title: x.title, cwd: x.cwd, tab: x },
      title: x.title,
      cwd: x.cwd,
      created: 0,
      modified: 0,
      fresh: true,
      // a tab without a file yet is by definition something being worked on
      open: true,
      color: metaOf(x.key).color,
    })),
    ...list.map((s) => {
      const key = `${host.id}|${s.path}`;
      const tab = state.tabs.get(key);
      const ref: SessionRef = { hostId: host.id, path: s.path, title: s.name || s.title, cwd: s.cwd, tab };
      return {
        ref,
        title: displayTitle(key, s.name || s.title),
        cwd: s.cwd,
        id: s.id,
        created: Date.parse(s.timestamp) || 0,
        modified: (s.modified ?? 0) * 1000,
        // a run in the background is known from the session meta, also while its tab is closed
        running: isWorking(tab) || (!tab && !!metaOf(key).backgroundAt),
        unread: !!metaOf(key).unread || !!tab?.unseen,
        color: metaOf(key).color,
        // an open tab is part of what is being worked on, also when its Pi ended with an error
        open: !!tab,
        // its place in "Own order" (dragged in the list, see applyOrder in sessionGroups.ts)
        order: metaOf(key).order ?? 0,
      };
    }),
  ];
}

/**
 * A run in the background is known from the session meta while its tab is closed. Ask the host now and then whether it
 * is still going: a run that ended while PiBar was closed leaves its mark behind. Until the host answers, the mark
 * stays – better a mark too many than a hidden running session.
 */
const bgChecked = new Map<string, number>();
function verifyBackgroundRun(hostId: string, path: string) {
  const key = `${hostId}|${path}`;
  const last = bgChecked.get(key) ?? 0;
  if (Date.now() - last < 3000) return;
  bgChecked.set(key, Date.now());
  api
    .bgRunning(hostId, path)
    .catch(() => true) // unknown: keep the mark
    .then((running) => {
      if (running) return;
      bgChecked.delete(key);
      // the run ended while PiBar was closed: nobody read the answer, so the row keeps its unread mark (✓ counter)
      setMeta(key, { backgroundAt: 0, unread: true });
    });
}

/** While a run is only known from the session meta, ask again now and then (the list renders itself after that) */
let bgPoll = 0;
function pollBackgroundRuns(any: boolean) {
  if (any && !bgPoll) bgPoll = window.setInterval(() => renderHosts(), 5000);
  if (!any && bgPoll) {
    clearInterval(bgPoll);
    bgPoll = 0;
  }
}

export function renderHosts() {
  resetOrder();
  renderHostTabs();
  renderReminders();
  // the funnel shows that the list is trimmed, and says how when you point at it
  const only = filtering();
  elFilterBtn.classList.toggle("on", only);
  elFilterBtn.title = only
    ? `${t("Filter")}: ${filterLabel()}`
    : t("Filter the list: what I am working on, or a colour");
  const sel = selectedHost();
  const hosts = sel === "all" ? state.config.hosts : state.config.hosts.filter((x) => x.id === sel);
  const collapsed = new Set(state.config.ui.collapsedHosts ?? []);
  // while searching, the list keeps only what matches the query (the messages themselves are in the block above)
  const query = state.search.query;
  const searching = isSearching(query);
  // the list shows less than everything: empty hosts, projects and groups are hidden
  const trimmed = searching || only;
  const rowsCache = new Map<string, ListRow[]>();
  /** Session rows of a host, built once per render: projects and the host block use the same rows */
  const rowsOf = (hostId: string) => {
    const cached = rowsCache.get(hostId);
    if (cached) return cached;
    const host = hosts.find((x) => x.id === hostId);
    const all = host ? hostRows(host) : [];
    const keep = (r: ListRow) =>
      (!searching || matchesQuery([r.title, r.ref.title, r.cwd], query)) &&
      (!only || passesFilter(r, filterMode(), filterColors()));
    const built = trimmed ? all.filter(keep) : all;
    rowsCache.set(hostId, built);
    return built;
  };
  // sessions in a project's folder appear under the project instead of in the host's own list
  const shown = projects().filter((p) => hosts.some((x) => x.id === p.hostId));
  const rowsOfProject = (p: Project) => rowsOf(p.hostId).filter((r) => projectOf(p.hostId, r.ref.cwd)?.id === p.id);
  const inProject = new Set(shown.flatMap((p) => rowsOfProject(p)).map((r) => refKey(r.ref)));
  // a host or project without a match has nothing to say while the list is trimmed – an unreachable host keeps its
  // error line
  const shownHosts = trimmed
    ? hosts.filter((h) => rowsOf(h.id).length > 0 || state.hostStatus.get(h.id)?.state === "err")
    : hosts;
  const shownProjects = trimmed ? shown.filter((p) => rowsOfProject(p).length > 0) : shown;
  const hitsBlock = searchHitsBlock();
  const chip = only ? filterChip() : null;
  elHostList.replaceChildren(
    ...(chip ? [chip] : []),
    ...(hitsBlock ? [hitsBlock] : []),
    ...shownHosts.map((host) => {
      const st = state.hostStatus.get(host.id);
      const list = state.sessionsByHost.get(host.id) ?? [];
      const openNew = unsavedTabs(host.id);
      const isCollapsed = collapsed.has(host.id);
      // sessions in a project's folder are shown under the project, not here
      const own = rowsOf(host.id).filter((r) => !inProject.has(refKey(r.ref)));
      const where =
        host.kind === "ssh" ? `SSH · ${host.sshUser ? host.sshUser + "@" : ""}${host.sshTarget}` : t("This computer");
      // only this heading's own sessions: what runs in a project is counted at the project
      const act = activityOfRows(own);
      const box = h(
        "div",
        { class: `block host ${isCollapsed ? "collapsed" : ""} ${act.working ? "working" : ""}` },
        h(
          "div",
          { class: "block-head host-head" },
          blockGrip("host", host.id, host.name),
          h(
            "button",
            {
              class: "chev",
              title: isCollapsed ? t("Expand") : t("Collapse"),
              onclick: () => toggleCollapsed(host.id),
            },
            "▾",
          ),
          hostStatusDot(st),
          h(
            "span",
            { class: "host-name", title: hostStatusTitle(st), onclick: () => toggleCollapsed(host.id) },
            host.name,
            h("span", { class: "host-where" }, where),
          ),
          ...marks(act),
          h("span", { class: "count" }, String(own.length)),
          h("button", { class: "icon-btn", title: t("Reload"), onclick: () => loadSessions(host.id) }, "↻"),
          h(
            "button",
            {
              class: "icon-btn",
              title: t("New session on {host}", { host: host.name }),
              onclick: () => newSessionDialog(host.id),
            },
            "＋",
          ),
        ),
        isCollapsed
          ? null
          : h(
              "div",
              { class: "block-body" },
              st?.state === "err" ? h("div", { class: "host-err" }, st.error ?? "") : null,
              ...sessionSections(own, "", `h:${host.id}`),
              own.length || trimmed
                ? null
                : list.length === 0 && openNew.length === 0
                  ? st?.state === "ok"
                    ? h("div", { class: "hint-line" }, t("No sessions yet"))
                    : null
                  : h("div", { class: "hint-line" }, t("All sessions are in projects")),
            ),
      );
      blockDrop(box, "host", host.id, (fromId, after) => moveHost(fromId, host.id, after));
      return box;
    }),
    ...renderProjects(shownProjects, rowsOfProject),
  );
  // a view with nothing in it explains itself (and offers the way back to everything)
  if (only && !searching && !shownHosts.length && !shownProjects.length) elHostList.append(filterEmpty());
  renderSelectionBar();

  // keep the "running in the background" marks of closed sessions honest, and refresh them while they hold
  const closedRuns = [...rowsCache.values()].flat().filter((r) => r.running && !r.ref.tab && r.ref.path);
  for (const r of closedRuns) verifyBackgroundRun(r.ref.hostId, r.ref.path);
  pollBackgroundRuns(closedRuns.length > 0);
}

// ---------- Messages that contain the search text ----------

/** One hit of the search: the host, the matching message and – if it is in the list – the session's entry */
interface HitRow {
  hostId: string;
  hit: SearchHit;
  info?: SessionInfo;
}

/**
 * The sessions whose messages contain the search text (state.search, filled by search.ts), newest first. They sit above
 * the hosts because they belong to no host in particular – the list below only keeps what matches in name or folder.
 */
function searchHitsBlock(): HTMLElement | null {
  const { query, hits, pending, error } = state.search;
  if (!query) return null;
  const sel = selectedHost();
  const rows: HitRow[] = [];
  for (const [hostId, list] of hits) {
    if (sel !== "all" && sel !== hostId) continue;
    const sessions = state.sessionsByHost.get(hostId) ?? [];
    // an older session outside the list still shows: folder and title come from its file
    for (const hit of list) rows.push({ hostId, hit, info: sessions.find((x) => x.path === hit.path) });
  }
  rows.sort((a, b) => (b.info?.modified ?? 0) - (a.info?.modified ?? 0));
  // before the hosts answer (the input waits for a pause) there is nothing to report yet
  const line = pending ? t("Searching …") : !state.search.done ? "" : rows.length ? "" : t("No messages found");
  return h(
    "div",
    { class: "block search-block" },
    h(
      "div",
      { class: "sec-head search-head" },
      h("span", { class: "sec-name" }, t("In messages")),
      h("span", { class: "count" }, String(rows.length)),
      line ? h("span", { class: "search-state" }, line) : null,
    ),
    error ? h("div", { class: "hit-err" }, error) : null,
    ...rows.slice(0, 60).map(hitItem),
  );
}

/** One session the search found: role of the message, host, title and the text around the match */
function hitItem({ hostId, hit, info }: HitRow): HTMLElement {
  const cwd = info?.cwd || hit.cwd;
  const title = info?.name || info?.title || hit.title;
  const host = state.config.hosts.find((x) => x.id === hostId);
  const open = () => openSession(hostId, hit.path, cwd, title);
  const parts = highlight(hit.snippet, state.search.query);
  return h(
    "div",
    {
      class: "hit",
      role: "button",
      tabindex: 0,
      title: cwd,
      onclick: open,
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter") open();
      },
    },
    h(
      "div",
      { class: "hit-head" },
      h("span", { class: "hit-role" }, t(roleLabel(hit.role))),
      selectedHost() === "all" && host ? h("span", { class: "hit-host" }, host.name) : null,
      h("span", { class: "hit-title" }, cleanTitle(displayTitle(`${hostId}|${hit.path}`, title)) || t("New session")),
    ),
    h("div", { class: "hit-snip" }, ...(parts ? [parts[0], h("mark", {}, parts[1]), parts[2]] : [hit.snippet])),
  );
}

const ICON_PIN =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M9.8 1.5 14.5 6.2l-1.4.4-2.6 2.6.3 3.3-1.2 1.2-2.9-2.9-3.6 3.6-.7-.7 3.6-3.6L3.1 7.3l1.2-1.2 3.3.3 2.6-2.6z"/></svg>';

/** Pinned sessions first, then each group (coloured header, collapsible), then the rest */
export type ListRow = OrderRow & {
  ref: SessionRef;
  /** A run of this session is going on (live or in the background, also with the tab closed: see hostRows) */
  running?: boolean;
  /** Nobody looked at the newest answer yet (finished while away, or "Mark as unread") */
  unread?: boolean;
  /** Colour from the session meta (session menu); empty = none */
  color?: string;
  /** The session is open in a tab – part of "Only what I am working on" */
  open?: boolean;
  /** Session id from the file header: full id in the tooltip, short id on subagent rows */
  id?: string;
};

/** Time shown in a row: matches the order (last activity, or creation when sorted by it) */
function rowTs(r: ListRow): string {
  const ms = rowTime(r, sortMode());
  return ms ? new Date(ms).toISOString() : "";
}

function sortMode(): SessionSort {
  return state.config.ui.sessionSort ?? "activity";
}

function groupMode(): SessionGroupBy {
  return state.config.ui.sessionGroup ?? "date";
}

/** View of the list: everything, or only what I am working on (src/shared/listFilter.ts) */
function filterMode(): SessionFilterMode {
  return state.config.ui.sessionFilter ?? "all";
}

/** Colour filter of the list: colour names or "none"; empty = every colour */
function filterColors(): string[] {
  return state.config.ui.sessionColors ?? [];
}

/** Is a view set (so hosts, projects and groups without a match are hidden)? */
function filtering(): boolean {
  return filterSet(filterMode(), filterColors());
}

/** Change the view of the list; an empty filter leaves no entry in the settings */
function setFilter(patch: { sessionFilter?: SessionFilterMode; sessionColors?: string[] }) {
  const ui = state.config.ui;
  Object.assign(ui, patch);
  if ((ui.sessionFilter ?? "all") === "all" && !ui.sessionColors?.length) {
    delete ui.sessionFilter;
    delete ui.sessionColors;
  }
  saveConfig();
  renderHosts();
}

/** Heading of a section of the session list */
function sectionLabel(key: string): string {
  if (groupMode() === "folder") return shortPath(key) || "~";
  const fixed: Record<string, string> = {
    today: t("Today"),
    yesterday: t("Yesterday"),
    week: t("Last 7 days"),
    month: t("Last 30 days"),
  };
  if (fixed[key]) return fixed[key];
  const [y, m] = key.split("-").map(Number);
  return new Date(y, m - 1, 1).toLocaleDateString(getLang(), { month: "long", year: "numeric" });
}

/** Header button: order and sections of the session list */
function viewMenu(anchor: HTMLElement) {
  const ui = state.config.ui;
  const set = (patch: Partial<typeof ui>) => {
    Object.assign(ui, patch);
    saveConfig();
    renderHosts();
  };
  const sorts: [SessionSort, Msg][] = [
    ["activity", "Last activity"],
    ["created", "Created"],
    ["name", "Name"],
    ["folder", "Folder"],
    ["own", "Own order"],
  ];
  const groupsBy: [SessionGroupBy, Msg][] = [
    ["date", "Date"],
    ["folder", "Folder"],
    ["none", "No sections"],
  ];
  openMenu(
    anchor,
    [
      { heading: t("Sort by") },
      ...sorts.map(([v, l]) => ({
        label: t(l),
        // "Own order" is dragged: one list, so the sections switch off with it
        ...(v === "own" ? { desc: t("Drag a session where you want it") } : {}),
        selected: sortMode() === v,
        onSelect: () => set(v === "own" ? { sessionSort: v, sessionGroup: "none" } : { sessionSort: v }),
      })),
      { separator: true },
      { heading: t("Sections") },
      ...groupsBy.map(([v, l]) => ({
        label: t(l),
        selected: groupMode() === v,
        onSelect: () => set({ sessionGroup: v }),
      })),
    ],
    "right",
  );
}

/** Header button: the view of the list – only what I am working on, and/or only one colour */
function filterMenu(anchor: HTMLElement) {
  const mode = filterMode();
  const colors = filterColors();
  const pickColor = (c: string) => setFilter({ sessionColors: [c] });
  const entries: MenuEntry[] = [
    { heading: t("Show") },
    {
      label: t("Everything"),
      desc: t("Every session of the shown hosts"),
      selected: mode === "all" && !colors.length,
      onSelect: () => setFilter({ sessionFilter: "all", sessionColors: [] }),
    },
    {
      label: t("Only what I am working on"),
      desc: t("Pi is working, an answer is unread or the session is open"),
      selected: mode === "active",
      onSelect: () => setFilter({ sessionFilter: "active" }),
    },
    { separator: true },
    { heading: t("Colour") },
    { label: t("Every colour"), selected: !colors.length, onSelect: () => setFilter({ sessionColors: [] }) },
    ...COLORS.map((c): MenuEntry => ({
      label: colorName(c),
      color: c,
      selected: colors.includes(c),
      onSelect: () => pickColor(c),
    })),
    { label: t("Without colour"), selected: colors.includes("none"), onSelect: () => pickColor("none") },
  ];
  if (filtering()) {
    entries.push(
      { separator: true },
      { label: t("Clear filter"), onSelect: () => setFilter({ sessionFilter: "all", sessionColors: [] }) },
    );
  }
  openMenu(anchor, entries, "right");
}

/** What the view is, in words: "working · Red" */
function filterLabel(): string {
  return [
    filterMode() === "active" ? t("Only what I am working on") : "",
    filterColors()
      .map((c) => (c === "none" ? t("No colour") : colorName(c)))
      .join(", "),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the list is showing while a view is set: "Filter: working · Red ×" */
function filterChip(): HTMLElement {
  const label = filterLabel();
  const clear = () => setFilter({ sessionFilter: "all", sessionColors: [] });
  return h(
    "div",
    { class: "filter-chip", title: t("Filter the list: what I am working on, or a colour") },
    h("span", { class: "filter-chip-label" }, h("span", { class: "filter-chip-what" }, t("Filter")), label),
    h(
      "button",
      {
        type: "button",
        class: "filter-chip-clear",
        title: t("Clear filter"),
        "aria-label": t("Clear filter"),
        onclick: clear,
      },
      "×",
    ),
  );
}

/** The view found nothing: say so and offer everything again */
function filterEmpty(): HTMLElement {
  return h(
    "div",
    { class: "hint-line filter-empty" },
    t("No session matches this filter."),
    h(
      "button",
      { type: "button", onclick: () => setFilter({ sessionFilter: "all", sessionColors: [] }) },
      t("Show everything"),
    ),
  );
}

/** Tooltip of a group's colour dot: its description (Settings → Session colours), otherwise the general hint */
function groupColorTitle(g: { color: string }): string {
  return g.color ? t("Colour: {name}", { name: colorName(g.color) }) : t("Colour of the group");
}

/**
 * `sectionPrefix` keeps the collapse state of a project's date or folder sections apart from the host's; `block` is the
 * context of the list ("h:<hostId>" or "p:<projectId>"): a group opens and closes per block, so closing it in a
 * project leaves it open on the host.
 */
export function sessionSections(rows: ListRow[], sectionPrefix = "", block = sectionPrefix): HTMLElement[] {
  const meta = (r: SessionRef) => metaOf(refKey(r));
  startBlock(block);
  // subagent sessions appear indented under their parent, not as rows of their own; while searching everything
  // stays flat so a hit is visible even when its parent is not in the list (src/main/subagents.ts)
  const nest = !isSearching(state.search.query);
  const present = new Set(rows.map((r) => refKey(r.ref)));
  // versions of a session (Pi forks): only the newest file of a family stays a row of its own, the older ones
  // hang under it, newest first (src/main/sessionVersions.ts)
  const versions = nest ? versionMap(rows) : new Map<string, VersionNode>();
  const inVersions = new Set([...versions.values()].flatMap((v) => v.older.map((r) => refKey(r.ref))));
  const mains = nest
    ? rows.filter((r) => {
        const parent = meta(r.ref).parentKey;
        return (!parent || !present.has(parent)) && !inVersions.has(refKey(r.ref));
      })
    : rows;
  const item = (r: ListRow): HTMLElement[] => {
    const v = nest ? versions.get(`${r.ref.hostId}|${r.ref.path}`) : undefined;
    const out: HTMLElement[] = [sessionItem(r, rowTs(r), v)];
    if (nest) {
      const kids = sessionKids(r, rows, (k) => sessionItem(k, rowTs(k)));
      if (kids) out.push(kids);
      if (v) out.push(versionKids(v, (k) => sessionItem(k, rowTs(k))));
    }
    return out;
  };
  // "Own order" is one list to drag in: date or folder sections would break it up
  const by: SessionGroupBy = sortMode() === "own" ? "none" : groupMode();
  const pinned = sortRows(
    mains.filter((r) => meta(r.ref).pinned),
    sortMode(),
  );
  const rest = mains.filter((r) => !meta(r.ref).pinned);
  const out: HTMLElement[] = [];
  if (pinned.length) {
    const head = h("div", { class: "sec-head" }, h("span", { class: "sec-icon" }), t("Pinned"));
    head.querySelector(".sec-icon")!.innerHTML = ICON_PIN;
    dropTarget(head, (keys) => setMetaMany(keys, { pinned: true }));
    out.push(head, ...pinned.flatMap((r) => item(r)));
  }
  const ids = new Set(groups().map((g) => g.id));
  // the archive always comes last
  const ordered = [...groups().filter((g) => g.id !== ARCHIVE), ...groups().filter((g) => g.id === ARCHIVE)];
  for (const g of ordered) {
    const inGroup = sortRows(
      rest.filter((r) => meta(r.ref).group === g.id),
      sortMode(),
    );
    // empty groups only show while dragging, so sessions can be dropped into them (not while searching)
    if (!inGroup.length) {
      if (isSearching(state.search.query) || filtering()) continue;
      const empty = h(
        "div",
        { class: `group empty-group ${g.color ? `c-${g.color}` : ""}` },
        h(
          "div",
          { class: "group-head" },
          h("span", { class: "cdot", title: groupColorTitle(g) }),
          h("span", { class: "group-name" }, g.name),
        ),
      );
      dropTarget(empty, (keys) => setMetaMany(keys, { group: g.id, pinned: false }));
      out.push(empty);
      continue;
    }
    const menu = (e: MouseEvent) => {
      e.preventDefault();
      e.stopPropagation();
      groupMenu(
        e.currentTarget as HTMLElement,
        g,
        e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : undefined,
      );
    };
    // a session of the group is working: visible at the heading, also with the group closed
    const act = activityOfRows(inGroup);
    const closed = groupCollapsed(block, g);
    const box = h(
      "div",
      {
        class: `group ${g.color ? `c-${g.color}` : ""} ${closed ? "collapsed" : ""} ${g.id === ARCHIVE ? "archive" : ""} ${act.working ? "working" : ""}`,
        oncontextmenu: menu,
      },
      h(
        "div",
        { class: "group-head", role: "button", tabindex: 0, onclick: () => toggleGroup(block, g) },
        h("span", { class: "chev" }, "▾"),
        h("span", { class: "cdot", title: groupColorTitle(g) }),
        h("span", { class: "group-name" }, g.name),
        ...marks(act),
        h("span", { class: "count" }, String(inGroup.length)),
        h("button", { class: "sess-act group-more", title: t("More …"), onclick: menu }, icon("more", 13)),
      ),
      ...(closed ? [] : inGroup.flatMap((r) => item(r))),
    );
    dropTarget(box, (keys) => setMetaMany(keys, { group: g.id, pinned: false }));
    out.push(box);
  }
  // sessions without a group: sorted and, if chosen, in sections by date or folder
  const loose = rest.filter((r) => !ids.has(meta(r.ref).group ?? ""));
  for (const sec of sectionRows(loose, sortMode(), by)) {
    if (!sec.key) {
      out.push(...sec.rows.flatMap((r) => item(r)));
      continue;
    }
    // sections can be collapsed (per host, per kind of sections); the choice is saved
    const id = `${sectionPrefix}${sec.rows[0].ref.hostId}|${by}|${sec.key}`;
    const closed = collapsedSections().has(id);
    out.push(
      h(
        "button",
        {
          type: "button",
          class: `sec-head date-head ${closed ? "collapsed" : ""}`,
          title: closed ? t("Expand") : t("Collapse"),
          "aria-expanded": closed ? "false" : "true",
          onclick: () => toggleSection(id),
        },
        h("span", { class: "chev" }, "▾"),
        h("span", { class: "sec-name" }, sectionLabel(sec.key)),
        h("span", { class: "count" }, String(sec.rows.length)),
      ),
    );
    if (!closed) out.push(...sec.rows.flatMap((r) => item(r)));
  }
  return out;
}

function collapsedSections(): Set<string> {
  return new Set(state.config.ui.collapsedSections ?? []);
}

/** Open or close a date or folder section of the session list */
function toggleSection(id: string) {
  const c = collapsedSections();
  if (c.has(id)) c.delete(id);
  else c.add(id);
  state.config.ui.collapsedSections = [...c];
  saveConfig();
  renderHosts();
}

/**
 * "Own order": the dragged sessions take the place of the row they were dropped on – they join its group and pin state
 * (like a drop onto the group did) and the rows of the block are numbered again (applyOrder in sessionGroups.ts).
 */
function arrangeRows(keys: string[], before: string) {
  const meta = metaOf(before);
  const patch: SessionMeta = { group: meta.group ?? "", pinned: !!meta.pinned };
  const all = blockKeysOf(before);
  const inside = keys.filter((k) => k !== before && all.includes(k));
  const outside = keys.filter((k) => k !== before && !all.includes(k));
  // sessions of another host cannot move over: they only join the group of the row
  if (outside.length) setMetaMany(outside, patch);
  if (!inside.length) return;
  const rest = all.filter((k) => !inside.includes(k));
  const at = rest.indexOf(before);
  rest.splice(at < 0 ? rest.length : at, 0, ...inside);
  applyOrder(rest, inside, patch);
}

/** One row in the session list: colour, pin, "remind", "⋯" (context menu) and "close" on hover */
function sessionItem(row: ListRow, ts: string, versions?: VersionNode) {
  const { ref } = row;
  const { hostId, path, cwd, tab } = ref;
  const key = refKey(ref);
  const m = metaOf(key);
  const title = path ? displayTitle(key, ref.title) : m.name || ref.title;
  const a = state.active;
  const isActive = !!a && ((tab && tab === a) || (a.hostId === hostId && a.sessionPath === path && !!path));
  const reminder = path ? reminderFor(key) : undefined;
  const open = () => (tab ? activate(tab) : openSession(hostId, path, cwd, title));
  const menuRef = { ...ref, title };
  noteVisible(key);
  // dragging a row up or down only sorts in "Own order"; elsewhere a drop belongs to a group or a drop zone
  const arrange = sortMode() === "own";
  const action = (label: string, ic: IconName, fn: (e: MouseEvent) => void, extra = "") =>
    h(
      "button",
      {
        class: `sess-act ${extra}`,
        title: label,
        "aria-label": label,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          fn(e);
        },
      },
      icon(ic, 13),
    );
  // a subagent session (meta.parentKey) shows its short session id in the meta line; every row has the full id
  // in its tooltip, so it can be told apart and found again (e.g. in the session folder on the host)
  const idShort = m.parentKey && row.id ? row.id.slice(0, 8) : "";
  const titleEl = h("span", { class: "sess-title" }, cleanTitle(title) || t("New session"));
  if (m.pinned) {
    const pin = h("span", { class: "pin" });
    pin.innerHTML = ICON_PIN;
    titleEl.prepend(pin);
  }
  // the spinner sits in the title (no dot in a gutter that steals room from long names)
  const mark = sessionMark(tab, row.running);
  if (mark) titleEl.prepend(mark);
  // the fold triangle of the older versions sits leftmost, before pin and spinner
  if (versions) titleEl.prepend(versionChevron(versions));
  const el = h(
    "div",
    {
      class: `sess ${isActive ? "active" : ""} ${row.unread ? "unread" : ""} ${row.running ? "working" : ""} ${m.color ? `colored c-${m.color}` : ""} ${
        selection.has(key) ? "selected" : ""
      }`,
      role: "button",
      tabindex: 0,
      title: [
        cleanTitle(title),
        cwd,
        row.id ? `ID: ${row.id}` : "",
        m.color ? t("Colour: {name}", { name: colorName(m.color) }) : "",
      ]
        .filter(Boolean)
        .join("\n"),
      draggable: "true",
      "data-key": key,
      ondragstart: (e: DragEvent) => dragStart(e, key),
      onclick: (e: MouseEvent) => {
        if (selectClick(e, key)) return;
        open();
      },
      onkeydown: (e: KeyboardEvent) => {
        if (e.key === "Enter") open();
        else if (e.key === "F2") renameDialogFor(menuRef);
      },
      oncontextmenu: (e: MouseEvent) => {
        e.preventDefault();
        sessionMenu(e.currentTarget as HTMLElement, menuRef, { x: e.clientX, y: e.clientY });
      },
    },
    titleEl,
    row.running && !tab
      ? h(
          "span",
          { class: "sess-meta working" },
          [idShort, t("Running in the background"), shortPath(cwd)].filter(Boolean).join(" · "),
        )
      : isWorking(tab)
        ? h(
            "span",
            { class: "sess-meta working" },
            [idShort, t("Pi is working …"), tab?.activity, shortPath(cwd)].filter(Boolean).join(" · "),
          )
        : h("span", { class: "sess-meta" }, [idShort, shortPath(cwd), relTime(ts)].filter(Boolean).join(" · ")),
    sessionPill(tab, row.running, row.unread),
    h(
      "span",
      { class: "sess-acts" },
      path
        ? action(
            reminder ? t("Change reminder") : t("Remind me later"),
            "clock",
            () => reminderDialog({ hostId, path, cwd, title: cleanTitle(title) }),
            reminder ? "on" : "",
          )
        : null,
      action(t("More …"), "more", (e) => sessionMenu(e.currentTarget as HTMLElement, menuRef)),
      tab?.alive ? action(t("Close session (⌘W)"), "close", () => closeSession(tab)) : null,
    ),
  );
  if (arrange) dropTarget(el, (keys) => arrangeRows(keys, key));
  return el;
}

// ---------- Earlier own messages: edit, run again, reuse, copy ----------

const norm = (s: string) =>
  stripPlanMode(stripAnswerStyle(splitScreenText(s).text))
    .replace(/\s+/g, " ")
    .trim();

/**
 * A session got a new key (forked or saved for the first time): move it in the maps and carry its settings over.
 * For a branch (`inherit`) only group and colour move along – the session it was forked from keeps its own settings.
 */
function rekey(tab: SessionTab, before: string, inherit = false) {
  if (tab.key === before) return;
  if (tab === state.active) rememberSession(tab);
  state.tabs.delete(before);
  state.tabs.set(tab.key, tab);
  const folders = state.config.sessionFolders[before];
  if (folders) state.config.sessionFolders[tab.key] = [...folders];
  if (!inherit) delete state.config.sessionFolders[before];
  const meta = state.config.sessionMeta?.[before];
  if (!meta) return saveConfig();
  const all = (state.config.sessionMeta ??= {});
  const own = all[tab.key] ?? {};
  if (inherit) {
    // a branch stays in the same group with the same colour
    const kept = { group: meta.group, color: meta.color };
    if (meta.group || meta.color) all[tab.key] = { ...kept, ...own };
  } else {
    // name, colour, group and tools were chosen for the session before it had a file: they belong to it
    all[tab.key] = { ...meta, ...own };
    delete all[before];
  }
  saveConfig();
  refreshTermTabs();
}

async function onUserAction(tab: SessionTab, index: number, action: UserAction, shown: string, edited?: string) {
  if (action === "copy") {
    await copyText(shown).then(
      () => toast(t("Copied")),
      (e) => toast(errMsg(e), "err"),
    );
    return;
  }
  if (action === "reuse") return fillInput(shown);
  if (!tab.alive) return toast(t("This session is not running."), "err");
  if (tab.streaming) return toast(t("Pi is still working – stop it first or wait."), "err");
  try {
    // Pi's list of fork points = user messages of this branch; match by position, otherwise by text
    const points = await tab.forkPoints();
    let p = points[index];
    if (!p || norm(p.text) !== norm(shown)) p = points.find((x) => norm(x.text) === norm(shown)) ?? p;
    if (!p) throw new Error(t("This message cannot be branched from."));
    // "go back": fork before the NEXT message, so this message and its answer stay and everything later is gone
    let at = p;
    let files: RewindPlan | null = null;
    if (action === "rewind") {
      const next = points[points.indexOf(p) + 1];
      if (!next) return toast(t("This is already the latest state."));
      at = next;
      // the files Pi changed since then go back with it (rewindFiles.ts), asked before anything changes
      const after = points.slice(points.indexOf(p) + 1).map((x) => x.entryId);
      files = await planRewind(tab, p.entryId, after);
      if (!files) return;
    }
    const before = tab.key;
    const fromPath = tab.sessionPath;
    const text = await tab.forkAt(at.entryId);
    if (text === null) return;
    rekey(tab, before, true);
    tab.undo = fromPath ? { fromPath, branchPath: tab.sessionPath } : null;
    loadSessions(tab.hostId).then(() => updateBranches(tab));
    renderHosts();
    renderToolbar();
    if (action === "rewind") {
      if (files && (await applyRewind(tab, files)) && tab === state.active) void reloadFiles();
      return;
    }
    // "edit": the text from the inline editor; "rerun": the original message
    await tab.send(action === "edit" && edited ? edited : stripPlanMode(stripAnswerStyle(text)) || shown);
  } catch (e) {
    toast(`${t("Branch")}: ${errMsg(e)}`, "err");
  }
}

/** Name for a session that has no file yet: Pi stores it (set_session_name), PiBar keeps it as own name once saved */
async function nameNewSession(tab: SessionTab, name: string) {
  tab.title = name;
  tab.pendingName = name;
  try {
    await api.pi(tab.handle, { type: "set_session_name", name });
  } catch {
    /* PiBar's own name still applies once the session is saved */
  }
  renderToolbar();
  renderHosts();
}

// ---------- Choice questions in answers ----------

/** Dialog for the choice questions of the last answer; the answer is sent as the next message */
export function openQuestions(tab: SessionTab) {
  questionDialog(tab.questions, async (text) => {
    tab.undo = null;
    await tab.send(text);
    renderToolbar();
  });
}

// ---------- Versions of a message (branches) ----------

/** "‹ 2/3 ›" under own messages that exist in other branches (src/main/branchNav.ts) */
async function updateBranches(tab: SessionTab) {
  try {
    await refreshBranches(tab, (choice, index) => switchBranch(tab, choice.path, index));
  } catch {
    /* without the overview the chat works as before */
  }
}

/** Show another version (branch file) in this tab, at the same message; model and thinking level stay */
async function switchBranch(tab: SessionTab, path: string, index: number) {
  const open = state.tabs.get(`${tab.hostId}|${path}`);
  if (open && open !== tab) {
    activate(open);
    open.scrollToUser(index);
    return;
  }
  if (tab.streaming) return toast(t("Pi is still working – switch versions when it is done."), "err");
  try {
    const before = tab.key;
    if (!(await tab.switchTo(path))) return;
    tab.undo = null;
    state.tabs.delete(before);
    state.tabs.set(tab.key, tab);
    renderHosts();
    renderToolbar();
    renderFiles();
    await updateBranches(tab);
    tab.scrollToUser(index);
  } catch (e) {
    toast(`${t("Branch")}: ${errMsg(e)}`, "err");
  }
}

/** Undo the last branch / "go back": return to the previous session file and delete the branch */
export async function undoBranch(tab: SessionTab) {
  const u = tab.undo;
  if (!u) return;
  try {
    if (tab.streaming) {
      await tab.abort().catch(() => {});
      await new Promise((r) => setTimeout(r, 400));
    }
    // the branch may have been saved meanwhile (first message sent): take its current file
    const branchPath = tab.sessionPath ?? u.branchPath;
    const before = tab.key;
    if (!(await tab.switchTo(u.fromPath))) return;
    tab.undo = null;
    // the files "go back" restored are part of the undo
    if (u.files && (await undoFiles(tab, u.files)) && tab === state.active) void reloadFiles();
    rekey(tab, before);
    if (branchPath && branchPath !== u.fromPath) {
      await api.deleteSessions(tab.hostId, [branchPath]).catch(() => {});
      delete state.config.sessionMeta?.[`${tab.hostId}|${branchPath}`];
      saveConfig();
    }
    await loadSessions(tab.hostId);
    void updateBranches(tab);
    renderToolbar();
    toast(t("Undone – back to the previous version."));
  } catch (e) {
    toast(`${t("Undo")}: ${errMsg(e)}`, "err");
  }
}

// ---------- Default model for new sessions ----------

/**
 * Settings → default model: apply to a new session right after its start. The session keeps it (saveChoice), so it
 * starts with the same model whenever it is opened again. `projectPreset` (a session started from a project) wins
 * over the default of the settings.
 */
async function applyDefaults(tab: SessionTab, projectPreset?: string) {
  const ui = state.config.ui;
  const preset = presetForNewSession(state.config.presets ?? [], projectPreset, ui.defaultPreset);
  try {
    if (preset) await tab.setPreset(preset.id);
    else if (ui.defaultModel || ui.defaultThinking) {
      const model = splitModelKey(ui.defaultModel || "");
      if (model) await tab.setModel(model.provider, model.id);
      if (ui.defaultThinking) await tab.setThinking(ui.defaultThinking);
    }
  } catch (e) {
    toast(`${t("Default model")}: ${errMsg(e)}`, "err");
  }
}

// ---------- Opening and closing ----------

export const tabCallbacks: TabCallbacks = {
  onUserAction: (tab, index, action, text, edited) => void onUserAction(tab, index, action, text, edited),
  onAnswerStart: (x) => x === state.active && answerStarted(),
  onUiRequest: (x, req) => {
    // Pi waits for its dialogs: show the session they belong to
    if (["select", "confirm", "input", "editor"].includes(req.method) && x !== state.active) activate(x);
    uiRequest(x, req, fillInput);
  },
  onHandle: (x) => {
    state.tabsByHandle.set(x.handle, x);
  },
  onStateChange: (x) => {
    if (x === state.active) renderToolbar();
    renderHosts();
  },
  onBackground: (x, running) => {
    if (x.sessionPath) setMeta(`${x.hostId}|${x.sessionPath}`, { backgroundAt: running ? Date.now() : 0 });
    renderToolbar();
    renderHosts();
  },
  onSettled: async (x) => {
    markSettled(x);
    // Pi may have written files or committed: refresh the file panel of the visible session
    if (x === state.active) void reloadFiles();
    const before = x.key;
    try {
      await x.refreshState();
    } catch {
      /* process may have ended */
    }
    // a new session got saved: move key and extra folders to the session file path
    rekey(x, before);
    if (x.pendingName && x.sessionPath) {
      setMeta(x.key, { name: x.pendingName });
      x.pendingName = "";
    }
    // A run that settled while nobody looked leaves its mark in the session meta as well, so the row and the ✓
    // counter of the list (host, project, group) are still there after a restart (§ "unread" in markSettled)
    if (x.unseen && x.sessionPath) setMeta(x.key, { unread: true });
    // a model Pi switched itself (its own /model command) stays the session's choice
    x.adoptChoice();
    await loadSessions(x.hostId);
    void updateBranches(x);
    const info = state.sessionsByHost.get(x.hostId)?.find((s) => s.path === x.sessionPath);
    if (info && (x.title === t("New session") || !x.title)) x.title = info.name || info.title;
    if (x === state.active) renderToolbar();
    renderHosts();
    // the answer ends with a choice question: open the answer dialog right away (the bar above the input reopens it)
    if (x === state.active && x.questions.length && document.hasFocus()) openQuestions(x);
  },
};

/** Start Pi for a session (path = null: new session in cwd) and show it */
export async function openSession(
  hostId: string,
  path: string | null,
  cwd: string,
  title: string,
  /** fixed preset of a project: a new session in it starts with this model and thinking level */
  projectPreset?: string,
): Promise<SessionTab> {
  const tab = new SessionTab(hostId, cwd, path, title, tabCallbacks);
  const meta = path ? state.config.sessionMeta?.[`${hostId}|${path}`] : undefined;
  if (path) tab.toolset = meta?.tools ?? null;
  // a subagent session keeps its agent prompt when it is opened again (src/main/subagents.ts)
  tab.agentPromptFile = meta?.agentPrompt || null;
  // plan mode survives a restart: read-only tools now, the session's own tools come back with Build
  if (meta?.planMode) {
    tab.planMode = true;
    tab.toolsetBeforePlan = tab.toolset;
    tab.toolset = [...PLAN_TOOLS];
  }
  // B/C: every message of this session (or of all sessions) can run in the background
  tab.background = meta?.background === "on" || (meta?.background !== "off" && !!state.config.ui.background);
  activate(tab);
  try {
    // a run in the background may still be going (started before PiBar was closed): follow it instead of starting
    const running = path && meta?.backgroundAt ? await api.bgRunning(hostId, path).catch(() => false) : false;
    if (running) {
      await tab.followBackground();
    } else {
      if (path && meta?.backgroundAt) setMeta(`${hostId}|${path}`, { backgroundAt: 0 });
      await tab.start(tabCallbacks.onHandle);
      if (!path) await applyDefaults(tab, projectPreset);
      else void updateBranches(tab);
    }
  } catch (e) {
    // If Pi exits right away, onExit shows the exact message (stderr)
    if (tab.alive) await new Promise((r) => setTimeout(r, 300));
    if (!tab.el.querySelector(".error")) {
      tab.alive = false;
      tab.el.append(
        h("div", { class: "msg" }, h("div", { class: "error" }, `${t("Pi could not be started:")}\n${errMsg(e)}`)),
      );
    }
  }
  state.tabs.set(tab.key, tab);
  renderToolbar();
  renderHosts();
  renderFiles();
  return tab;
}

/** Bring a session into the chat area */
export function activate(tab: SessionTab) {
  const prev = state.active;
  state.active = tab;
  rememberSession(tab);
  applyChatColors(tab.hostId);
  markSeen(tab);
  clearUnread(tab.key);
  broadcastActive();
  showTab(tab, prev);
  focusSessionTab(tab);
  closeEditor();
  renderToolbar();
  renderHosts();
  renderFiles();
}

/** Stop the session's Pi process and remove it from the open sessions. The session file stays. */
export function closeSession(tab: SessionTab) {
  const key = tab.key;
  subagentClosed(tab);
  tab.close();
  state.tabs.delete(key);
  state.tabsByHandle.delete(tab.handle);
  // a session that never got a file takes its settings (name, colour, group) with it
  if (!tab.sessionPath && state.config.sessionMeta?.[key]) {
    delete state.config.sessionMeta[key];
    selection.delete(key);
    saveConfig();
  }
  tab.el.remove();
  if (state.active === tab) {
    state.active = null;
    broadcastActive();
    showEmpty();
    closeEditor();
    renderFiles();
  }
  renderToolbar();
  renderHosts();
}

// ---------- New session ----------

/** Host for "New session": selected host, else that of the active session, else the first */
export function defaultHostId(): string | undefined {
  const sel = selectedHost();
  return sel !== "all" ? sel : (state.active?.hostId ?? state.config.hosts[0]?.id);
}

/**
 * "New session" dialog. `opts.dir` pre-fills the folder; with `opts.locked` host and folder are fixed (a session
 * started from a project always runs in the project's folder). `opts.preset` is the fixed preset of a project (a
 * session started here uses it instead of the default model), `opts.title` replaces the dialog title.
 */
export function newSessionDialog(
  hostId?: string,
  opts: { dir?: string; title?: string; locked?: boolean; preset?: string } = {},
) {
  const hosts = state.config.hosts;
  if (!hosts.length) return settingsDialog();
  const selHost = h("select", {}, ...hosts.map((x) => h("option", { value: x.id, selected: x.id === hostId }, x.name)));
  const inName = h("input", { type: "text", placeholder: t("optional, e.g. Release 1.5") }) as HTMLInputElement;
  const inDir = h("input", { type: "text", placeholder: t("~/project") }) as HTMLInputElement;
  // from a project: folder and host are fixed, so the session really starts in the project's folder
  const locked = !!opts.locked && !!opts.dir?.trim();
  if (locked) {
    inDir.value = opts.dir!.trim();
    inDir.disabled = true;
    selHost.disabled = true;
  }
  // fixed preset of the project the session starts in: shown, because it is not chosen here (see projects.ts)
  const fixedPreset = (state.config.presets ?? []).find((p) => p.id === opts.preset);
  const hostOf = () => hosts.find((x) => x.id === selHost.value);
  // "remember as default": the folder is pre-filled for the next new session on this host (also in the quick bar)
  const remember = h("input", { type: "checkbox", style: "width:auto" }) as HTMLInputElement;
  const rememberLabel = h("span", {});
  const syncRemember = () => {
    const host = hostOf();
    const isDefault = (inDir.value.trim() || "~") === (host?.defaultDir || "~");
    remember.checked = isDefault;
    remember.disabled = isDefault;
    rememberLabel.textContent = ` ${t("Remember as default folder for {host}", { host: host?.name ?? "" })}`;
  };
  const setDefault = () => {
    if (locked) return;
    inDir.value = hostOf()?.defaultDir || "~";
    syncRemember();
  };
  selHost.addEventListener("change", setDefault);
  inDir.addEventListener("input", syncRemember);
  inDir.addEventListener("change", syncRemember);
  setDefault();
  // the session can go into a group right away, without waiting for the first message
  const groupSel = h(
    "select",
    {},
    h("option", { value: "" }, t("No group")),
    ...groups().map((g) => h("option", { value: g.id }, g.name)),
  ) as HTMLSelectElement;
  const applyGroup = (tab: SessionTab) => {
    if (groupSel.value) setMeta(tab.key, { group: groupSel.value, pinned: false });
  };
  let started = false;
  // Quick start: up to 4 presets at the top, each with its own fixed folder — a click starts right away
  const startPreset = async (p: SessionPreset) => {
    if (started) return;
    started = true;
    close();
    const host = hostOf();
    if (!host) return;
    const name = p.name.trim();
    const tab = await openSession(host.id, null, p.dir.trim() || "~", name || t("New session"), opts.preset);
    if (name && tab.alive) await nameNewSession(tab, name);
  };
  const presets = [...(state.config.ui.sessionPresets ?? [])];
  while (presets.length < 4) presets.push({ name: "", dir: "" });
  const quickStart = h(
    "div",
    { class: "quick-start" },
    ...presets.slice(0, 4).map((p, i) => {
      const set = !!p.dir.trim();
      const chip = h(
        "button",
        {
          class: set ? "qs-chip" : "qs-chip empty",
          title: set ? t("Start in {dir}", { dir: p.dir.trim() }) : t("Not set — define it in Settings"),
        },
        set ? p.name.trim() || t("Preset {n}", { n: i + 1 }) : `${t("Preset {n}", { n: i + 1 })} +`,
      );
      chip.addEventListener("click", () => (set ? startPreset(p) : settingsDialog()));
      return chip;
    }),
  );
  const go = async () => {
    if (started) return; // Enter in a field and ⌘Enter in the dialog must not start two sessions
    started = true;
    close();
    const host = hostOf();
    const dir = inDir.value.trim() || "~";
    if (host && remember.checked && !remember.disabled && host.defaultDir !== dir) {
      host.defaultDir = dir;
      saveConfig();
    }
    const name = inName.value.trim();
    const tab = await openSession(
      selHost.value,
      null,
      inDir.value.trim() || "~",
      name || t("New session"),
      opts.preset,
    );
    applyGroup(tab);
    if (name && tab.alive) await nameNewSession(tab, name);
  };
  for (const i of [inName, inDir, selHost] as HTMLElement[])
    i.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) {
        e.preventDefault();
        go();
      }
    });
  setTimeout(() => inName.focus(), 0);
  const close = openModal(
    opts.title ?? t("New session"),
    h(
      "div",
      {},
      ...(locked ? [] : [quickStart]),
      h("div", { class: "row" }, h("label", {}, t("Name")), inName),
      h("div", { class: "row" }, h("label", {}, t("Host")), selHost),
      h("div", { class: "row" }, h("label", {}, t("Group")), groupSel),
      fixedPreset ? h("div", { class: "row" }, h("label", {}, t("Preset")), h("span", {}, fixedPreset.name)) : null,
      h(
        "div",
        { class: "row" },
        h("label", {}, t("Working folder")),
        locked ? inDir : folderField(inDir, () => selHost.value, syncRemember),
      ),
      locked
        ? null
        : h("div", { class: "row" }, h("label", {}, ""), h("label", { class: "check" }, remember, rememberLabel)),
      h(
        "p",
        { class: "hint" },
        locked
          ? t("The session starts in the folder of the project, with the preset fixed there.")
          : t("Pi starts in this folder. You can add more folders on the right afterwards."),
      ),
      locked ? null : h("p", { class: "hint" }, t("⌘Enter starts · ⌥↓ in the folder field: choose folder")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: go }, t("Start")),
    ],
  );
  // ⌘Enter anywhere in the dialog starts the session
  inName.closest(".modal")?.addEventListener("keydown", (e) => {
    const ke = e as KeyboardEvent;
    if (ke.key === "Enter" && (ke.metaKey || ke.ctrlKey)) {
      ke.preventDefault();
      go();
    }
  });
}
