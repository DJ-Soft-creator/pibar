// Left column: hosts and sessions; open, activate, close and create sessions.
import { api } from "../shared/api";
import { $, h, errMsg, openModal } from "../shared/dom";
import { cleanTitle, relTime, shortPath } from "../shared/format";
import { t } from "../shared/i18n";
import { renderToolbar, showEmpty, showTab } from "./chatView";
import { closeEditor, renderFiles } from "./files";
import { broadcastActive } from "./quickBridge";
import { reminderFor, reminderDialog, renderReminders } from "./reminders";
import { SessionTab, TabCallbacks } from "./sessionTab";
import { settingsDialog } from "./settings";
import { saveConfig, state } from "./state";

const elHostList = $("host-list");
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
  const tab = (id: string, label: string, count: number, dot?: string) =>
    h(
      "button",
      { class: `host-tab ${sel === id ? "active" : ""}`, onclick: () => selectHost(id), title: label },
      dot !== undefined ? h("span", { class: `dot ${dot}` }) : null,
      h("span", { class: "host-tab-name" }, label),
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
          : [
              ...openNew.map((x) => sessionItem(host.id, x.sessionPath ?? "", x.title, x.cwd, "", x)),
              ...list.map((s) =>
                sessionItem(
                  host.id,
                  s.path,
                  s.name || s.title,
                  s.cwd,
                  s.timestamp,
                  state.tabs.get(`${host.id}|${s.path}`),
                ),
              ),
            ]),
        !isCollapsed && list.length === 0 && openNew.length === 0 && st?.state === "ok"
          ? h("div", { class: "hint-line" }, t("No sessions yet"))
          : null,
      );
    }),
  );
}

/** One row in the session list, with "remind" and "close" actions on hover */
function sessionItem(hostId: string, path: string, title: string, cwd: string, ts: string, tab?: SessionTab) {
  const a = state.active;
  const isActive = !!a && ((tab && tab === a) || (a.hostId === hostId && a.sessionPath === path && !!path));
  const reminder = path ? reminderFor(`${hostId}|${path}`) : undefined;
  const open = () => (tab ? activate(tab) : openSession(hostId, path, cwd, title));
  const action = (label: string, icon: string, fn: () => void, extra = "") =>
    h(
      "button",
      {
        class: `sess-act ${extra}`,
        title: label,
        "aria-label": label,
        onclick: (e: MouseEvent) => {
          e.stopPropagation();
          fn();
        },
      },
      icon,
    );
  return h(
    "div",
    {
      class: `sess ${isActive ? "active" : ""}`,
      role: "button",
      tabindex: 0,
      title: `${cleanTitle(title)}\n${cwd}`,
      onclick: open,
      onkeydown: (e: KeyboardEvent) => e.key === "Enter" && open(),
    },
    tab?.alive ? h("span", { class: `live ${tab.streaming ? "busy" : ""}` }) : null,
    h("span", { class: "sess-title" }, cleanTitle(title) || t("New session")),
    h("span", { class: "sess-meta" }, [shortPath(cwd), relTime(ts)].filter(Boolean).join(" · ")),
    h(
      "span",
      { class: "sess-acts" },
      path
        ? action(
            reminder ? t("Change reminder") : t("Remind me later"),
            "⏰",
            () => reminderDialog({ hostId, path, cwd, title: cleanTitle(title) }),
            reminder ? "on" : "",
          )
        : null,
      tab?.alive ? action(t("Close session (⌘W)"), "×", () => closeSession(tab)) : null,
    ),
  );
}

// ---------- Opening and closing ----------

const tabCallbacks: TabCallbacks = {
  onHandle: (x) => {
    state.tabsByHandle.set(x.handle, x);
  },
  onStateChange: (x) => {
    if (x === state.active) renderToolbar();
    renderHosts();
  },
  onSettled: async (x) => {
    const before = x.key;
    try {
      await x.refreshState();
    } catch {
      /* process may have ended */
    }
    if (x.key !== before) {
      // a new session got saved: move key and extra folders to the session file path
      state.tabs.delete(before);
      state.tabs.set(x.key, x);
      const folders = state.config.sessionFolders[before];
      if (folders) {
        state.config.sessionFolders[x.key] = folders;
        delete state.config.sessionFolders[before];
        saveConfig();
      }
    }
    await loadSessions(x.hostId);
    const info = state.sessionsByHost.get(x.hostId)?.find((s) => s.path === x.sessionPath);
    if (info && (x.title === t("New session") || !x.title)) x.title = info.name || info.title;
    if (x === state.active) renderToolbar();
    renderHosts();
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
  activate(tab);
  try {
    await tab.start(tabCallbacks.onHandle);
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
  const inDir = h("input", { type: "text", placeholder: t("~/project") }) as HTMLInputElement;
  const setDefault = () => (inDir.value = hosts.find((x) => x.id === selHost.value)?.defaultDir || "~");
  selHost.addEventListener("change", setDefault);
  setDefault();
  const go = () => {
    close();
    openSession(selHost.value, null, inDir.value.trim() || "~", t("New session"));
  };
  inDir.addEventListener("keydown", (e) => e.key === "Enter" && go());
  const close = openModal(
    t("New session"),
    h(
      "div",
      {},
      h("div", { class: "row" }, h("label", {}, t("Host")), selHost),
      h("div", { class: "row" }, h("label", {}, t("Working folder")), inDir),
      h("p", { class: "hint" }, t("Pi starts in this folder. You can add more folders on the right afterwards.")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: go }, t("Start")),
    ],
  );
}
