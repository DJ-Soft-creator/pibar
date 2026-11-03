// Session organisation in the left column: own names, pins, colours and coloured groups, plus the context menus
// of sessions, groups and a multi-selection (src/main/sessionSelect.ts). Stored in AppConfig.sessionMeta (key "<hostId>|<sessionPath>") and AppConfig.groups.
import { api, SessionGroup, SessionMeta } from "../shared/api";
import { copyText, h, errMsg, openModal, toast } from "../shared/dom";
import { cleanTitle } from "../shared/format";
import { Msg, t } from "../shared/i18n";
import { renderToolbar } from "./chatView";
import { COLORS, MenuEntry, openMenu } from "./menu";
import { reminderDialog, reminderFor } from "./reminders";
import type { SessionTab } from "./sessionTab";
import { selection } from "./sessionSelect";
import { closeSession, loadSessions, renderHosts } from "./sessions";
import { saveConfig, state } from "./state";

const COLOR_NAMES: Record<string, Msg> = {
  "": "No colour",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

export function colorName(c: string): string {
  return t(COLOR_NAMES[c] ?? "No colour");
}

export function metaOf(key: string): SessionMeta {
  return state.config.sessionMeta?.[key] ?? {};
}

/** Change a session's meta; empty values are dropped so the config stays small */
export function setMeta(key: string, patch: SessionMeta) {
  const all = (state.config.sessionMeta ??= {});
  const m: SessionMeta = { ...all[key], ...patch };
  for (const k of Object.keys(m) as (keyof SessionMeta)[]) if (!m[k]) delete m[k];
  if (Object.keys(m).length) all[key] = m;
  else delete all[key];
  saveConfig();
  renderHosts();
}

/** Same change for several sessions, saved and rendered once */
export function setMetaMany(keys: string[], patch: SessionMeta) {
  const all = (state.config.sessionMeta ??= {});
  for (const key of keys) {
    const m: SessionMeta = { ...all[key], ...patch };
    for (const k of Object.keys(m) as (keyof SessionMeta)[]) if (!m[k]) delete m[k];
    if (Object.keys(m).length) all[key] = m;
    else delete all[key];
  }
  saveConfig();
  renderHosts();
}

export function groups(): SessionGroup[] {
  return (state.config.groups ??= []);
}

/** Title shown in the list: own name, otherwise Pi's name or first message */
export function displayTitle(key: string, fallback: string): string {
  return metaOf(key).name?.trim() || fallback;
}

// ---------- Dialogs ----------

function textDialog(title: string, label: string, value: string, ok: (v: string) => void, hint = "") {
  const input = h("input", { type: "text", value }) as HTMLInputElement;
  const done = () => {
    close();
    ok(input.value.trim());
  };
  input.addEventListener("keydown", (e) => e.key === "Enter" && done());
  const close = openModal(
    title,
    h(
      "div",
      {},
      h("div", { class: "row" }, h("label", {}, label), input),
      hint ? h("p", { class: "hint" }, hint) : null,
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: done }, t("Save")),
    ],
  );
  setTimeout(() => (input.focus(), input.select()), 0);
}

export interface SessionRef {
  hostId: string;
  /** Session file; "" for a new session that is not saved yet */
  path: string;
  title: string;
  cwd: string;
  tab?: SessionTab;
}

/** Rename: own name in PiBar; an open session also tells Pi (set_session_name), so the name is in the file */
export function renameDialog(s: SessionRef) {
  const key = `${s.hostId}|${s.path}`;
  textDialog(
    t("Rename session"),
    t("Name"),
    s.path ? displayTitle(key, s.title) : s.title,
    async (name) => {
      if (s.path) setMeta(key, { name });
      if (s.tab?.alive && name) {
        try {
          await api.pi(s.tab.handle, { type: "set_session_name", name });
          s.tab.title = name;
        } catch (e) {
          if (!s.path) toast(`${t("Rename session")}: ${errMsg(e)}`, "err");
        }
      }
      renderHosts();
      renderToolbar();
    },
    t("Empty = name from Pi or the first message."),
  );
}

export function newGroupDialog(then?: (g: SessionGroup) => void) {
  textDialog(t("New group"), t("Name"), "", (name) => {
    if (!name) return;
    const used = new Set(groups().map((g) => g.color));
    const g: SessionGroup = {
      id: `g${Date.now()}`,
      name,
      color: COLORS.find((c) => !used.has(c)) ?? "blue",
      collapsed: false,
    };
    groups().push(g);
    saveConfig();
    then?.(g);
    renderHosts();
  });
}

// ---------- Context menus ----------

/** Group entries for one or more sessions; moving into a group also unpins */
function groupEntries(keys: string[]): MenuEntry[] {
  const cur = keys.length === 1 ? (metaOf(keys[0]).group ?? "") : null;
  return [
    ...groups().map((g) => ({
      label: g.name,
      color: g.color,
      selected: cur === g.id,
      onSelect: () => setMetaMany(keys, { group: g.id, pinned: false }),
    })),
    { label: t("No group"), selected: cur === "", onSelect: () => setMetaMany(keys, { group: "" }) },
    {
      label: t("New group …"),
      onSelect: () => newGroupDialog((g) => setMetaMany(keys, { group: g.id, pinned: false })),
    },
  ];
}

export function groupPickerMenu(anchor: HTMLElement, keys: string[]) {
  openMenu(anchor, [{ heading: t("Move to group") }, ...groupEntries(keys)]);
}

export function colorMenu(anchor: HTMLElement, keys: string[]) {
  const colors = new Set(keys.map((k) => metaOf(k).color ?? ""));
  openMenu(anchor, [
    { heading: t("Colour") },
    {
      colors: true,
      current: colors.size === 1 ? [...colors][0] : "-",
      title: colorName,
      onPick: (color) => setMetaMany(keys, { color }),
    },
  ]);
}

// ---------- Close and delete several sessions ----------

function splitKey(key: string): { hostId: string; path: string } {
  const i = key.indexOf("|");
  return { hostId: key.slice(0, i), path: key.slice(i + 1) };
}

/** Title for confirmations: own name, Pi's name or first message */
function titleOf(key: string): string {
  const { hostId, path } = splitKey(key);
  const s = state.sessionsByHost.get(hostId)?.find((x) => x.path === path);
  return cleanTitle(
    displayTitle(key, s?.name || s?.title || state.tabs.get(key)?.title || path.split("/").pop() || path),
  );
}

/** Confirmation with a short list of the affected sessions */
function confirmDialog(title: string, text: string, keys: string[], okLabel: string, ok: () => void) {
  const max = 8;
  const close = openModal(
    title,
    h(
      "div",
      {},
      h("p", {}, text),
      h(
        "ul",
        { class: "confirm-list" },
        ...keys.slice(0, max).map((k) => h("li", {}, titleOf(k))),
        keys.length > max ? h("li", { class: "muted" }, t("… and {n} more", { n: keys.length - max })) : null,
      ),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h(
        "button",
        {
          class: "danger-solid",
          onclick: () => {
            close();
            ok();
          },
        },
        okLabel,
      ),
    ],
  );
}

/** Close the open sessions among `keys`; asks first when it is more than one */
export function closeSessionsDialog(keys: string[]) {
  const open = keys.filter((k) => state.tabs.get(k)?.alive);
  const run = () => open.forEach((k) => closeSession(state.tabs.get(k)!));
  if (open.length <= 1) return run();
  confirmDialog(
    t("Close {n} sessions?", { n: open.length }),
    t("The Pi processes end; the sessions stay in the list and can be reopened."),
    open,
    t("Close {n} sessions", { n: open.length }),
    run,
  );
}

/** Delete sessions for good (session files on the host), after asking */
export function deleteSessionsDialog(keys: string[]) {
  keys = keys.filter((k) => splitKey(k).path);
  if (!keys.length) return;
  const n = keys.length;
  confirmDialog(
    n === 1 ? t("Delete session?") : t("Delete {n} sessions?", { n }),
    t("The session files are deleted on the host. This cannot be undone."),
    keys,
    n === 1 ? t("Delete") : t("Delete {n} sessions", { n }),
    () => deleteSessions(keys),
  );
}

async function deleteSessions(keys: string[]) {
  // stop running Pi processes first, they would write the file again
  for (const k of keys) {
    const tab = state.tabs.get(k);
    if (tab) closeSession(tab);
  }
  const byHost = new Map<string, string[]>();
  for (const k of keys) {
    const { hostId, path } = splitKey(k);
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), path]);
  }
  let deleted = 0;
  for (const [hostId, paths] of byHost) {
    try {
      deleted += await api.deleteSessions(hostId, paths);
      // forget names, groups, reminders and extra folders of the deleted sessions
      for (const p of paths) {
        const key = `${hostId}|${p}`;
        delete state.config.sessionMeta?.[key];
        delete state.config.sessionFolders[key];
        selection.delete(key);
      }
      state.config.reminders = state.config.reminders.filter((r) => !(r.hostId === hostId && paths.includes(r.path)));
    } catch (e) {
      toast(`${t("Delete")}: ${errMsg(e)}`, "err");
    }
    loadSessions(hostId);
  }
  saveConfig();
  if (deleted) toast(deleted === 1 ? t("Session deleted") : t("{n} sessions deleted", { n: deleted }));
}

/** Context menu for several selected sessions */
export function bulkMenu(keys: string[]): MenuEntry[] {
  const allPinned = keys.every((k) => metaOf(k).pinned);
  const open = keys.map((k) => state.tabs.get(k)).filter((x) => x?.alive);
  return [
    { heading: t("{n} selected", { n: keys.length }) },
    { label: allPinned ? t("Unpin") : t("Pin to top"), onSelect: () => setMetaMany(keys, { pinned: !allPinned }) },
    { separator: true },
    { heading: t("Colour") },
    { colors: true, current: "-", title: colorName, onPick: (color) => setMetaMany(keys, { color }) },
    { separator: true },
    { heading: t("Move to group") },
    ...groupEntries(keys),
    { separator: true },
    ...(open.length
      ? [
          {
            label: t("Close {n} open sessions", { n: open.length }),
            onSelect: () => closeSessionsDialog(keys),
          },
        ]
      : []),
    { label: t("Delete {n} sessions …", { n: keys.length }), danger: true, onSelect: () => deleteSessionsDialog(keys) },
    { separator: true },
    {
      label: t("Clear selection (Esc)"),
      onSelect: () => {
        selection.clear();
        renderHosts();
      },
    },
  ];
}

/** Right click or "⋯" on a session (on a selected one: actions for the whole selection) */
export function sessionMenu(anchor: HTMLElement, s: SessionRef, at?: { x: number; y: number }) {
  const key = `${s.hostId}|${s.path}`;
  if (s.path && selection.has(key) && selection.size > 1)
    return openMenu(anchor, bulkMenu([...selection]), "right", at);
  const m = metaOf(key);
  const saved = !!s.path;
  const entries: MenuEntry[] = [{ label: t("Rename …"), onSelect: () => renameDialog(s) }];
  if (saved) {
    entries.push(
      {
        label: m.pinned ? t("Unpin") : t("Pin to top"),
        onSelect: () => setMeta(key, { pinned: !m.pinned }),
      },
      { separator: true },
      { heading: t("Colour") },
      { colors: true, current: m.color ?? "", title: colorName, onPick: (color) => setMeta(key, { color }) },
      { separator: true },
      { heading: t("Move to group") },
      ...groupEntries([key]),
      { separator: true },
      {
        label: reminderFor(key) ? t("Change reminder") : t("Remind me later"),
        onSelect: () => reminderDialog({ hostId: s.hostId, path: s.path, cwd: s.cwd, title: s.title }),
      },
    );
  }
  if (s.tab?.sessionId)
    entries.push({
      label: t("Copy session ID"),
      desc: s.tab.sessionId,
      onSelect: () => void copyText(s.tab!.sessionId).then(() => toast(t("Copied"))),
    });
  if (s.tab?.bg)
    entries.push({
      label: t("Stop the run in the background"),
      danger: true,
      onSelect: () => void s.tab!.stopBackground(),
    });
  if (s.tab?.alive) entries.push({ label: t("Close session (⌘W)"), onSelect: () => closeSession(s.tab!) });
  if (saved)
    entries.push(
      { separator: true },
      { label: t("Delete …"), danger: true, onSelect: () => deleteSessionsDialog([key]) },
    );
  openMenu(anchor, entries, "right", at);
}

/** Right click or "⋯" on a group header */
export function groupMenu(anchor: HTMLElement, g: SessionGroup, at?: { x: number; y: number }) {
  openMenu(
    anchor,
    [
      {
        label: t("Rename …"),
        onSelect: () =>
          textDialog(t("Rename group"), t("Name"), g.name, (name) => {
            if (!name) return;
            g.name = name;
            saveConfig();
            renderHosts();
          }),
      },
      { heading: t("Colour") },
      {
        colors: true,
        current: g.color,
        title: colorName,
        onPick: (color) => {
          g.color = color;
          saveConfig();
          renderHosts();
        },
      },
      { separator: true },
      { label: t("New group …"), onSelect: () => newGroupDialog() },
      {
        label: t("Delete group"),
        desc: t("The sessions stay, only without a group."),
        onSelect: () => {
          state.config.groups = groups().filter((x) => x.id !== g.id);
          for (const m of Object.values(state.config.sessionMeta ?? {})) if (m.group === g.id) delete m.group;
          saveConfig();
          renderHosts();
        },
      },
    ],
    "right",
    at,
  );
}

export function toggleGroup(g: SessionGroup) {
  g.collapsed = !g.collapsed;
  saveConfig();
  renderHosts();
}
