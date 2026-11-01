// Left column: hosts and sessions (pinned, in coloured groups, the rest); open, activate, close and create sessions.
import { folderField } from "./folderPicker";
import { hostMarks, markSeen, markSettled, sessionMark, sessionPill } from "./activity";
import { ARCHIVE } from "./cleanup";
import { api } from "../shared/api";
import { $, h, copyText, errMsg, openModal, toast } from "../shared/dom";
import { icon, IconName } from "../shared/icons";
import { cleanTitle, relTime, shortPath, splitScreenText, stripAnswerStyle } from "../shared/format";
import { splitModelKey } from "../shared/presets";
import {
  rowTime,
  sectionRows,
  sortRows,
  type OrderRow,
  type SessionGroupBy,
  type SessionSort,
} from "../shared/sessionOrder";
import { openMenu } from "./menu";
import { getLang, t, type Msg } from "../shared/i18n";
import { fillInput, renderToolbar, showEmpty, showTab } from "./chatView";
import { closeEditor, reloadFiles, renderFiles } from "./files";
import { refreshBranches } from "./branchNav";
import { questionDialog, uiRequest } from "./answerDialog";
import { broadcastActive } from "./quickBridge";
import { reminderFor, reminderDialog, renderReminders } from "./reminders";
import {
  displayTitle,
  groupMenu,
  groups,
  metaOf,
  renameDialog as renameDialogFor,
  SessionRef,
  sessionMenu,
  setMeta,
  setMetaMany,
  toggleGroup,
} from "./sessionGroups";
import {
  dragStart,
  dropTarget,
  noteVisible,
  renderSelectionBar,
  resetOrder,
  selectClick,
  selection,
} from "./sessionSelect";
import { SessionTab, TabCallbacks, UserAction } from "./sessionTab";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";

const elHostList = $("host-list");
$("btn-session-view").addEventListener("click", (e) => viewMenu(e.currentTarget as HTMLElement));
const elHostTabs = $("host-tabs");

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
  const tab = (id: string, label: string, count: number, dot?: string) =>
    h(
      "button",
      { class: `host-tab ${sel === id ? "active" : ""}`, onclick: () => selectHost(id), title: label },
      dot !== undefined ? h("span", { class: `dot ${dot}` }) : null,
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
    ...state.config.hosts.map((x) => tab(x.id, x.name, sessionCount(x.id), state.hostStatus.get(x.id)?.state ?? "")),
  );
}

// ---------- List ----------

export function renderHosts() {
  resetOrder();
  renderHostTabs();
  renderReminders();
  const sel = selectedHost();
  const hosts = sel === "all" ? state.config.hosts : state.config.hosts.filter((x) => x.id === sel);
  const collapsed = new Set(state.config.ui.collapsedHosts ?? []);
  elHostList.replaceChildren(
    ...hosts.map((host) => {
      const st = state.hostStatus.get(host.id);
      const list = state.sessionsByHost.get(host.id) ?? [];
      const openNew = unsavedTabs(host.id);
      const isCollapsed = sel === "all" && collapsed.has(host.id);
      const where =
        host.kind === "ssh" ? `SSH · ${host.sshUser ? host.sshUser + "@" : ""}${host.sshTarget}` : t("This computer");
      return h(
        "div",
        { class: `host ${isCollapsed ? "collapsed" : ""}` },
        h(
          "div",
          { class: "host-head" },
          sel === "all"
            ? h(
                "button",
                {
                  class: "chev",
                  title: isCollapsed ? t("Expand") : t("Collapse"),
                  onclick: () => toggleCollapsed(host.id),
                },
                "▾",
              )
            : null,
          h("span", { class: `dot ${st?.state ?? ""}`, title: st?.error ?? "" }),
          h(
            "span",
            { class: "host-name", onclick: () => sel === "all" && toggleCollapsed(host.id) },
            host.name,
            h("span", { class: "host-where" }, where),
          ),
          ...hostMarks(host.id),
          h("span", { class: "count" }, String(list.length + openNew.length)),
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
        !isCollapsed && st?.state === "err" ? h("div", { class: "host-err" }, st.error ?? "") : null,
        ...(isCollapsed
          ? []
          : sessionSections([
              ...openNew.map((x) => ({
                ref: { hostId: host.id, path: x.sessionPath ?? "", title: x.title, cwd: x.cwd, tab: x },
                title: x.title,
                cwd: x.cwd,
                created: 0,
                modified: 0,
                fresh: true,
              })),
              ...list.map((s) => {
                const ref: SessionRef = {
                  hostId: host.id,
                  path: s.path,
                  title: s.name || s.title,
                  cwd: s.cwd,
                  tab: state.tabs.get(`${host.id}|${s.path}`),
                };
                return {
                  ref,
                  title: displayTitle(`${host.id}|${s.path}`, s.name || s.title),
                  cwd: s.cwd,
                  created: Date.parse(s.timestamp) || 0,
                  modified: (s.modified ?? 0) * 1000,
                };
              }),
            ])),
        !isCollapsed && list.length === 0 && openNew.length === 0 && st?.state === "ok"
          ? h("div", { class: "hint-line" }, t("No sessions yet"))
          : null,
      );
    }),
  );
  renderSelectionBar();
}

const ICON_PIN =
  '<svg width="11" height="11" viewBox="0 0 16 16" fill="currentColor"><path d="M9.8 1.5 14.5 6.2l-1.4.4-2.6 2.6.3 3.3-1.2 1.2-2.9-2.9-3.6 3.6-.7-.7 3.6-3.6L3.1 7.3l1.2-1.2 3.3.3 2.6-2.6z"/></svg>';

/** Pinned sessions first, then each group (coloured header, collapsible), then the rest */
type ListRow = OrderRow & { ref: SessionRef };

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
      ...sorts.map(([v, l]) => ({ label: t(l), selected: sortMode() === v, onSelect: () => set({ sessionSort: v }) })),
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

function sessionSections(rows: ListRow[]): HTMLElement[] {
  const meta = (r: SessionRef) => (r.path ? metaOf(`${r.hostId}|${r.path}`) : {});
  const pinned = sortRows(
    rows.filter((r) => meta(r.ref).pinned),
    sortMode(),
  );
  const rest = rows.filter((r) => !meta(r.ref).pinned);
  const out: HTMLElement[] = [];
  if (pinned.length) {
    const head = h("div", { class: "sec-head" }, h("span", { class: "sec-icon" }), t("Pinned"));
    head.querySelector(".sec-icon")!.innerHTML = ICON_PIN;
    dropTarget(head, (keys) => setMetaMany(keys, { pinned: true }));
    out.push(head, ...pinned.map((r) => sessionItem(r.ref, rowTs(r))));
  }
  const ids = new Set(groups().map((g) => g.id));
  // the archive always comes last
  const ordered = [...groups().filter((g) => g.id !== ARCHIVE), ...groups().filter((g) => g.id === ARCHIVE)];
  for (const g of ordered) {
    const inGroup = sortRows(
      rest.filter((r) => meta(r.ref).group === g.id),
      sortMode(),
    );
    // empty groups only show while dragging, so sessions can be dropped into them
    if (!inGroup.length) {
      const empty = h(
        "div",
        { class: `group empty-group ${g.color ? `c-${g.color}` : ""}` },
        h("div", { class: "group-head" }, h("span", { class: "cdot" }), h("span", { class: "group-name" }, g.name)),
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
    const box = h(
      "div",
      {
        class: `group ${g.color ? `c-${g.color}` : ""} ${g.collapsed ? "collapsed" : ""} ${g.id === ARCHIVE ? "archive" : ""}`,
        oncontextmenu: menu,
      },
      h(
        "div",
        { class: "group-head", role: "button", tabindex: 0, onclick: () => toggleGroup(g) },
        h("span", { class: "chev" }, "▾"),
        h("span", { class: "cdot" }),
        h("span", { class: "group-name" }, g.name),
        h("span", { class: "count" }, String(inGroup.length)),
        h("button", { class: "sess-act group-more", title: t("More …"), onclick: menu }, icon("more", 13)),
      ),
      ...(g.collapsed ? [] : inGroup.map((r) => sessionItem(r.ref, rowTs(r)))),
    );
    dropTarget(box, (keys) => setMetaMany(keys, { group: g.id, pinned: false }));
    out.push(box);
  }
  // sessions without a group: sorted and, if chosen, in sections by date or folder
  const loose = rest.filter((r) => !ids.has(meta(r.ref).group ?? ""));
  for (const sec of sectionRows(loose, sortMode(), groupMode())) {
    if (sec.key) out.push(h("div", { class: "sec-head date-head" }, sectionLabel(sec.key)));
    out.push(...sec.rows.map((r) => sessionItem(r.ref, rowTs(r))));
  }
  return out;
}

/** One row in the session list: colour, pin, "remind", "⋯" (context menu) and "close" on hover */
function sessionItem(ref: SessionRef, ts: string) {
  const { hostId, path, cwd, tab } = ref;
  const key = `${hostId}|${path}`;
  const m = path ? metaOf(key) : {};
  const title = path ? displayTitle(key, ref.title) : ref.title;
  const a = state.active;
  const isActive = !!a && ((tab && tab === a) || (a.hostId === hostId && a.sessionPath === path && !!path));
  const reminder = path ? reminderFor(key) : undefined;
  const open = () => (tab ? activate(tab) : openSession(hostId, path, cwd, title));
  const menuRef = { ...ref, title };
  if (path) noteVisible(key);
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
  const titleEl = h("span", { class: "sess-title" }, cleanTitle(title) || t("New session"));
  if (m.pinned) {
    const pin = h("span", { class: "pin" });
    pin.innerHTML = ICON_PIN;
    titleEl.prepend(pin);
  }
  return h(
    "div",
    {
      class: `sess ${isActive ? "active" : ""} ${tab?.unseen ? "unseen" : ""} ${tab?.alive && tab.streaming ? "working" : ""} ${m.color ? `colored c-${m.color}` : ""} ${
        path && selection.has(key) ? "selected" : ""
      }`,
      role: "button",
      tabindex: 0,
      title: `${cleanTitle(title)}\n${cwd}`,
      draggable: path ? "true" : undefined,
      "data-key": path ? key : undefined,
      ondragstart: (e: DragEvent) => path && dragStart(e, key),
      onclick: (e: MouseEvent) => {
        if (path && selectClick(e, key)) return;
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
    sessionMark(tab),
    titleEl,
    tab?.alive && tab.streaming
      ? h(
          "span",
          { class: "sess-meta working" },
          [t("Pi is working …"), tab.activity, shortPath(cwd)].filter(Boolean).join(" · "),
        )
      : h("span", { class: "sess-meta" }, [shortPath(cwd), relTime(ts)].filter(Boolean).join(" · ")),
    sessionPill(tab),
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
}

// ---------- Earlier own messages: edit, run again, reuse, copy ----------

const norm = (s: string) => stripAnswerStyle(splitScreenText(s).text).replace(/\s+/g, " ").trim();

/** A session got a new key (forked or saved for the first time): move it in the maps and carry its settings over */
function rekey(tab: SessionTab, before: string, inherit = false) {
  if (tab.key === before) return;
  state.tabs.delete(before);
  state.tabs.set(tab.key, tab);
  const folders = state.config.sessionFolders[before];
  if (folders) state.config.sessionFolders[tab.key] = [...folders];
  if (!inherit) delete state.config.sessionFolders[before];
  // a branch stays in the same group with the same colour
  const m = inherit && tab.sessionPath ? state.config.sessionMeta?.[before] : undefined;
  if (m && (m.group || m.color)) (state.config.sessionMeta ??= {})[tab.key] = { group: m.group, color: m.color };
  saveConfig();
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
    if (action === "rewind") {
      const next = points[points.indexOf(p) + 1];
      if (!next) return toast(t("This is already the latest state."));
      at = next;
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
    if (action === "rewind") return;
    // "edit": the text from the inline editor; "rerun": the original message
    await tab.send(action === "edit" && edited ? edited : stripAnswerStyle(text) || shown);
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

/** Settings → default model: apply to a new session right after its start */
async function applyDefaults(tab: SessionTab) {
  const ui = state.config.ui;
  const preset = (state.config.presets ?? []).find((p) => p.id === ui.defaultPreset);
  const model = splitModelKey(preset?.model || ui.defaultModel || "");
  const thinking = preset?.thinking || ui.defaultThinking || "";
  try {
    if (model) await tab.setModel(model.provider, model.id);
    if (thinking) await tab.setThinking(thinking);
    if (preset) tab.presetId = preset.id;
  } catch (e) {
    toast(`${t("Default model")}: ${errMsg(e)}`, "err");
  }
}

// ---------- Opening and closing ----------

const tabCallbacks: TabCallbacks = {
  onUserAction: (tab, index, action, text, edited) => void onUserAction(tab, index, action, text, edited),
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
): Promise<SessionTab> {
  const tab = new SessionTab(hostId, cwd, path, title, tabCallbacks);
  if (path) tab.toolset = state.config.sessionMeta?.[`${hostId}|${path}`]?.tools ?? null;
  activate(tab);
  try {
    await tab.start(tabCallbacks.onHandle);
    if (!path) await applyDefaults(tab);
    else void updateBranches(tab);
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
  state.active = tab;
  markSeen(tab);
  broadcastActive();
  showTab(tab);
  closeEditor();
  renderToolbar();
  renderHosts();
  renderFiles();
}

/** Stop the session's Pi process and remove it from the open sessions. The session file stays. */
export function closeSession(tab: SessionTab) {
  tab.close();
  state.tabs.delete(tab.key);
  state.tabsByHandle.delete(tab.handle);
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

export function newSessionDialog(hostId?: string) {
  const hosts = state.config.hosts;
  if (!hosts.length) return settingsDialog();
  const selHost = h("select", {}, ...hosts.map((x) => h("option", { value: x.id, selected: x.id === hostId }, x.name)));
  const inName = h("input", { type: "text", placeholder: t("optional, e.g. Release 1.5") }) as HTMLInputElement;
  const inDir = h("input", { type: "text", placeholder: t("~/project") }) as HTMLInputElement;
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
    inDir.value = hostOf()?.defaultDir || "~";
    syncRemember();
  };
  selHost.addEventListener("change", setDefault);
  inDir.addEventListener("input", syncRemember);
  inDir.addEventListener("change", syncRemember);
  setDefault();
  const go = async () => {
    close();
    const host = hostOf();
    const dir = inDir.value.trim() || "~";
    if (host && remember.checked && !remember.disabled && host.defaultDir !== dir) {
      host.defaultDir = dir;
      saveConfig();
    }
    const name = inName.value.trim();
    const tab = await openSession(selHost.value, null, inDir.value.trim() || "~", name || t("New session"));
    if (name && tab.alive) await nameNewSession(tab, name);
  };
  for (const i of [inName, inDir]) i.addEventListener("keydown", (e) => e.key === "Enter" && go());
  setTimeout(() => inName.focus(), 0);
  const close = openModal(
    t("New session"),
    h(
      "div",
      {},
      h("div", { class: "row" }, h("label", {}, t("Name")), inName),
      h("div", { class: "row" }, h("label", {}, t("Host")), selHost),
      h(
        "div",
        { class: "row" },
        h("label", {}, t("Working folder")),
        folderField(inDir, () => selHost.value, syncRemember),
      ),
      h("div", { class: "row" }, h("label", {}, ""), h("label", { class: "check" }, remember, rememberLabel)),
      h("p", { class: "hint" }, t("Pi starts in this folder. You can add more folders on the right afterwards.")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: go }, t("Start")),
    ],
  );
}
