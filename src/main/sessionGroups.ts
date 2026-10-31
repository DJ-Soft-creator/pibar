// Session organisation in the left column: own names, pins, colours and coloured groups, plus the context menus
// of sessions and groups. Stored in AppConfig.sessionMeta (key "<hostId>|<sessionPath>") and AppConfig.groups.
import { api, SessionGroup, SessionMeta } from "../shared/api";
import { h, errMsg, openModal, toast } from "../shared/dom";
import { Msg, t } from "../shared/i18n";
import { renderToolbar } from "./chatView";
import { COLORS, MenuEntry, openMenu } from "./menu";
import { reminderDialog, reminderFor } from "./reminders";
import type { SessionTab } from "./sessionTab";
import { closeSession, renderHosts } from "./sessions";
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

function newGroupDialog(then?: (g: SessionGroup) => void) {
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

/** Right click or "⋯" on a session */
export function sessionMenu(anchor: HTMLElement, s: SessionRef, at?: { x: number; y: number }) {
  const key = `${s.hostId}|${s.path}`;
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
      ...groups().map((g) => ({
        label: g.name,
        color: g.color,
        selected: m.group === g.id,
        onSelect: () => setMeta(key, { group: g.id }),
      })),
      { label: t("No group"), selected: !m.group, onSelect: () => setMeta(key, { group: "" }) },
      { label: t("New group …"), onSelect: () => newGroupDialog((g) => setMeta(key, { group: g.id })) },
      { separator: true },
      {
        label: reminderFor(key) ? t("Change reminder") : t("Remind me later"),
        onSelect: () => reminderDialog({ hostId: s.hostId, path: s.path, cwd: s.cwd, title: s.title }),
      },
    );
  }
  if (s.tab?.alive) entries.push({ label: t("Close session (⌘W)"), onSelect: () => closeSession(s.tab!) });
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
