// The sheet of one session (task H1, the desktop's sessionMenu of src/main/sessionGroups.ts): rename, colour, pin,
// group, move to project, reminder, export, copy session id, mark (un)read, delete – plus the same actions for a
// multi-selection (H4). Everything is stored with meta_set_session; the other fields of an entry are kept.
import { api, type SessionGroup } from "@shared/api";
import { copyText, h, openModal, toast } from "@shared/dom";
import { cleanTitle } from "@shared/format";
import { t } from "@shared/i18n";
import { COLORS } from "@shared/sessionColors";
import { button } from "../ui";
import {
  data,
  groups,
  loadHost,
  metaOf,
  projects,
  restoreMeta,
  saveGroup,
  sessionOf,
  setMeta,
  setMetaMany,
  splitKey,
  titleOf,
} from "./sessionsData";
import { exportDialog } from "./sessionsExport";
import { projectDialog } from "./sessionsOrg";
import { reminderDialog } from "./sessionsReminders";
import { ARCHIVE, hostName, projectIdOf, type ListRow } from "./sessionsRows";
import { selection } from "./sessionsSelect";
import { actionSheet, colorSheet, run, swatches, textPrompt, type SheetItem } from "./sessionsUi";

/** Title for confirmations and sheets: own name, Pi's name or first message */
export function keyTitle(key: string): string {
  const s = sessionOf(key);
  const { hostId, path } = splitKey(key);
  return cleanTitle(s ? titleOf(hostId, s) : metaOf(key).name || path.split("/").pop() || path);
}

/** A new group with the first colour no other group has */
export async function newGroup(): Promise<SessionGroup | null> {
  const name = await textPrompt(t("New group"), t("Name"), "");
  if (!name) return null;
  const used = new Set(groups().map((g) => g.color));
  const g: SessionGroup = { id: `g${Date.now()}`, name, color: COLORS.find((c) => !used.has(c)) ?? "blue", collapsed: false };
  await saveGroup(g);
  return g;
}

/** The archive group, created (collapsed, without colour) on first use (src/main/cleanup.ts) */
async function ensureArchive() {
  if (!groups().some((g) => g.id === ARCHIVE)) await saveGroup({ id: ARCHIVE, name: t("Archive"), color: "", collapsed: true });
}

/** Move sessions into the archive, with undo in the toast */
export async function archiveKeys(keys: string[]) {
  if (!keys.length) return;
  await ensureArchive();
  const before = new Map(keys.map((k) => [k, data.meta.sessionMeta[k] ? { ...data.meta.sessionMeta[k] } : null] as const));
  await setMetaMany(keys, { group: ARCHIVE, pinned: false });
  selection.keys.clear();
  toast(t("{n} sessions moved to the archive.", { n: keys.length }), "info", 10_000, {
    label: t("Undo"),
    run: () => run(() => restoreMeta(before as Map<string, Record<string, unknown> | null>)),
  });
}

export function groupPicker(keys: string[]) {
  const cur = keys.length === 1 ? (metaOf(keys[0] ?? "").group ?? "") : null;
  const items: SheetItem[] = [
    ...groups().map((g) => ({
      label: g.name,
      color: g.color,
      selected: cur === g.id,
      onSelect: () => setMetaMany(keys, { group: g.id, pinned: false }),
    })),
    { label: t("No group"), selected: cur === "", onSelect: () => setMetaMany(keys, { group: "" }) },
    {
      label: t("New group …"),
      onSelect: async () => {
        const g = await newGroup();
        if (g) await setMetaMany(keys, { group: g.id, pinned: false });
      },
    },
  ];
  actionSheet(t("Move to group"), items);
}

export function colorPicker(keys: string[]) {
  const colors = new Set(keys.map((k) => metaOf(k).color ?? ""));
  colorSheet(t("Colour"), colors.size === 1 ? ([...colors][0] ?? "") : "-", (color) => setMetaMany(keys, { color }));
}

function projectPicker(r: ListRow) {
  const cur = metaOf(r.key).project ?? "";
  const own = projectIdOf(r);
  const items: SheetItem[] = [
    ...projects()
      .filter((p) => p.hostId === r.hostId)
      .map((p) => ({ label: p.name, desc: p.dir, selected: own === p.id, onSelect: () => setMeta(r.key, { project: p.id }) })),
    {
      label: t("By folder"),
      desc: t("The project whose folder holds the session's working folder"),
      selected: !cur,
      onSelect: () => setMeta(r.key, { project: "" }),
    },
    {
      label: t("New project from this folder …"),
      onSelect: () => projectDialog(undefined, r.hostId, r.cwd),
    },
  ];
  actionSheet(t("Move to project"), items);
}

/** Delete sessions for good (files on the host), after asking; their metadata goes too */
export function deleteDialog(keys: string[]) {
  if (!keys.length) return;
  const n = keys.length;
  const max = 8;
  const close = openModal(
    n === 1 ? t("Delete session?") : t("Delete {n} sessions?", { n }),
    h(
      "div",
      {},
      h("p", {}, t("The session files are deleted on the host. This cannot be undone.")),
      h(
        "ul",
        { class: "sl-confirm-list" },
        ...keys.slice(0, max).map((k) => h("li", {}, keyTitle(k))),
        n > max ? h("li", { class: "muted" }, t("… and {n} more", { n: n - max })) : null,
      ),
    ),
    [
      button(t("Cancel"), () => close()),
      button(
        n === 1 ? t("Delete") : t("Delete {n} sessions", { n }),
        () => {
          close();
          run(() => deleteKeys(keys));
        },
        "danger",
      ),
    ],
  );
}

async function deleteKeys(keys: string[]) {
  const byHost = new Map<string, string[]>();
  for (const k of keys) {
    const { hostId, path } = splitKey(k);
    byHost.set(hostId, [...(byHost.get(hostId) ?? []), path]);
  }
  let deleted = 0;
  for (const [hostId, paths] of byHost) {
    try {
      deleted += await api.deleteSessions(hostId, paths);
      // forget names, groups and reminders of the deleted sessions
      const gone = paths.map((p) => `${hostId}|${p}`).filter((k) => data.meta.sessionMeta[k]);
      if (gone.length) await restoreMeta(new Map(gone.map((k) => [k, null])));
      for (const p of paths) selection.keys.delete(`${hostId}|${p}`);
    } catch (e) {
      toast(`${t("Delete")}: ${String(e)}`, "err");
    }
    void loadHost(hostId);
  }
  if (deleted) toast(deleted === 1 ? t("Session deleted") : t("{n} sessions deleted", { n: deleted }));
}

/** "⋯" or a long press on a row */
export function sessionSheet(r: ListRow) {
  const m = metaOf(r.key);
  const title = cleanTitle(r.title) || t("New session");
  const project = projects().find((p) => p.id === projectIdOf(r));
  const group = groups().find((g) => g.id === m.group);
  const unread = !!m.unread || data.unseen.has(r.key);
  const items: SheetItem[] = [
    {
      label: t("Rename …"),
      onSelect: async () => {
        const name = await textPrompt(t("Rename session"), t("Name"), titleOf(r.hostId, r.s), t("Empty = name from Pi or the first message."));
        if (name !== null) await setMeta(r.key, { name });
      },
    },
    { label: m.pinned ? t("Unpin") : t("Pin to top"), onSelect: () => setMeta(r.key, { pinned: !m.pinned }) },
    {
      label: t("Move to group"),
      desc: group?.name ?? t("No group"),
      color: group?.color ?? "",
      onSelect: () => groupPicker([r.key]),
    },
    { label: t("Move to project"), desc: project?.name ?? t("No project"), onSelect: () => projectPicker(r) },
    {
      label: m.remindAt ? t("Change reminder") : t("Remind me later"),
      onSelect: () => reminderDialog(r.key, title),
    },
    unread
      ? {
          label: t("Mark as read"),
          onSelect: () => {
            data.unseen.delete(r.key);
            return setMeta(r.key, { unread: false });
          },
        }
      : { label: t("Mark as unread"), onSelect: () => setMeta(r.key, { unread: true }) },
    { label: t("Export …"), desc: t("Markdown, JSON or CSV"), onSelect: () => exportDialog({ hostId: r.hostId, path: r.s.path, title }) },
  ];
  if (r.s.id)
    items.push({
      label: t("Copy session ID"),
      desc: r.s.id,
      onSelect: async () => {
        await copyText(r.s.id);
        toast(t("Copied"));
      },
    });
  items.push({ label: t("Delete …"), danger: true, onSelect: () => deleteDialog([r.key]) });
  actionSheet(title, items, (close) =>
    h(
      "div",
      { class: "sl-sheet-top" },
      h("p", { class: "sl-sheet-where" }, [hostName(r.hostId), r.cwd].filter(Boolean).join(" · ")),
      swatches(m.color ?? "", (color) => {
        close();
        run(() => setMeta(r.key, { color }));
      }),
    ),
  );
}

/** Pin or unpin several sessions: all pinned → unpin, else pin */
export function pinKeys(keys: string[]) {
  const all = keys.every((k) => metaOf(k).pinned);
  run(() => setMetaMany(keys, { pinned: !all }));
}
