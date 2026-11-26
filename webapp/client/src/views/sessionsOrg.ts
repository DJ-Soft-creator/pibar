// Organisation of the session list (tasks H2–H4, like src/main/sessionGroups.ts, projects.ts and cleanup.ts): group
// sheet (rename, colour, delete), project dialog (name, host, folder with a folder picker over list_dirs) and project
// sheet, "tidy up" into the archive with undo, and the view sheet (order, sections, filter, colour filter).
import { api, type DirListing, type Project, type SessionGroup } from "@shared/api";
import { errMsg, h, openModal, toast } from "@shared/dom";
import { baseName, shortPath } from "@shared/format";
import { t, type Msg } from "@shared/i18n";
import { COLORS, colorLabel } from "@shared/sessionColors";
import { state } from "../state";
import { button } from "../ui";
import { startNewSession } from "./newSession";
import {
  data,
  deleteGroup,
  deleteProject,
  metaOf,
  prefs,
  saveGroup,
  saveProject,
  setPrefs,
  type ListPrefs,
} from "./sessionsData";
import { ARCHIVE, hostName } from "./sessionsRows";
import { archiveKeys, newGroup } from "./sessionsSheet";
import { setSelecting } from "./sessionsSelect";
import { actionSheet, colorSheet, run, textPrompt, type SheetItem } from "./sessionsUi";

// ---------------------------------------------------------------- groups (H2)

export function groupSheet(g: SessionGroup) {
  const items: SheetItem[] = [
    {
      label: t("Rename …"),
      onSelect: async () => {
        const name = await textPrompt(t("Rename group"), t("Name"), g.name);
        if (name) await saveGroup({ ...g, name });
      },
    },
    {
      label: t("Colour"),
      desc: g.color ? colorLabel(g.color, data.labels) : t("No colour"),
      color: g.color,
      onSelect: () => colorSheet(t("Colour of the group"), g.color, (color) => saveGroup({ ...g, color })),
    },
    {
      label: g.collapsed ? t("Open by default") : t("Closed by default"),
      desc: t("For everybody; each of your blocks keeps its own choice once you open or close it"),
      onSelect: () => saveGroup({ ...g, collapsed: !g.collapsed }),
    },
    { label: t("New group …"), onSelect: () => newGroup().then(() => undefined) },
    {
      label: t("Delete group"),
      desc: t("The sessions stay, only without a group."),
      danger: true,
      onSelect: () => deleteGroup(g.id),
    },
  ];
  actionSheet(g.name, items);
}

// ---------------------------------------------------------------- projects (H3)

/**
 * Folder picker over list_dirs (the files area's command): shows the folders of a host, ".." goes up. When the host
 * cannot list folders (command missing, error), the caller keeps the text field.
 */
export async function pickFolder(hostId: string, start: string): Promise<string | null> {
  let listing: DirListing;
  try {
    listing = await api.listDirs(hostId, start || "~");
  } catch (e) {
    toast(`${t("Folders cannot be listed")}: ${errMsg(e)}`, "err");
    return null;
  }
  return new Promise((resolve) => {
    let picked: string | null = null;
    const body = h("div", { class: "sl-folders" });
    const close = openModal(
      t("Choose folder"),
      body,
      [
        button(t("Cancel"), () => close()),
        button(
          t("Choose this folder"),
          () => {
            picked = shortPath(listing.path);
            close();
          },
          "primary",
        ),
      ],
      () => resolve(picked),
      "sl-modal",
    );
    const show = () => {
      const up = listing.path.replace(/\/[^/]+\/?$/, "") || "/";
      body.replaceChildren(
        h("p", { class: "sl-folder-path mono" }, shortPath(listing.path) || "/"),
        h(
          "div",
          { class: "sl-sheet-list" },
          listing.path !== "/" ? h("button", { type: "button", class: "sl-sheet-item", onclick: () => go(up) }, "⬑ ..") : null,
          ...listing.dirs.map((d) =>
            h("button", { type: "button", class: "sl-sheet-item", onclick: () => go(`${listing.path.replace(/\/$/, "")}/${d}`) }, `📁 ${d}`),
          ),
          listing.dirs.length ? null : h("p", { class: "hint" }, t("No folders in here")),
        ),
      );
    };
    const go = async (path: string) => {
      try {
        listing = await api.listDirs(hostId, path);
        show();
      } catch (e) {
        toast(errMsg(e), "err");
      }
    };
    show();
  });
}

/** Create a project or change it: name, host and folder (sessions whose folder lies there appear under it) */
export function projectDialog(existing?: Project, hostId?: string, dir?: string) {
  const hosts = state.hosts;
  if (!hosts.length) return;
  const start = existing?.hostId ?? hostId ?? (prefs().host || hosts[0]?.id || "");
  const inName = h("input", { type: "text", value: existing?.name ?? (dir ? baseName(dir) : ""), placeholder: t("e.g. PiBar") });
  const selHost = h(
    "select",
    { disabled: hosts.length < 2 },
    ...hosts.map((x) => h("option", { value: x.id, selected: x.id === start }, x.name)),
  );
  const inDir = h("input", { type: "text", value: existing?.dir ?? (dir ? shortPath(dir) : ""), placeholder: "~/project" });
  // a new project follows the default folder of its host until the user types or picks another one
  let follow = !existing && !dir;
  const fill = () => {
    if (follow) inDir.value = hosts.find((x) => x.id === selHost.value)?.defaultDir || "~";
  };
  fill();
  selHost.addEventListener("change", fill);
  inDir.addEventListener("input", () => (follow = false));
  const browse = button(t("Choose …"), () =>
    run(async () => {
      const picked = await pickFolder(selHost.value, inDir.value.trim());
      if (picked) {
        inDir.value = picked;
        follow = false;
        if (!inName.value.trim()) inName.value = baseName(picked);
      }
    }),
  );
  const done = () => {
    const folder = inDir.value.trim();
    if (!folder) return toast(t("Choose a folder for the project."), "err");
    const name = inName.value.trim() || baseName(folder) || t("Project");
    close();
    run(() =>
      saveProject(
        existing
          ? { ...existing, name, hostId: selHost.value, dir: folder }
          : { id: `p${Date.now()}`, name, hostId: selHost.value, dir: folder, collapsed: false },
      ),
    );
  };
  const close = openModal(
    existing ? t("Edit project") : t("New project"),
    h(
      "div",
      { class: "form" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Name")), inName),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Host")), selHost),
      h(
        "div",
        { class: "field" },
        h("span", { class: "field-label" }, t("Folder")),
        h("div", { class: "sl-folder-row" }, inDir, browse),
      ),
      h(
        "p",
        { class: "hint" },
        t(
          "Sessions whose working folder lies in this folder appear under the project. A new session started here runs in this folder, with the preset chosen here.",
        ),
      ),
    ),
    [button(t("Cancel"), () => close()), button(t("Save"), done, "primary")],
  );
}

export function newSessionInProject(p: Project) {
  startNewSession({ hostId: p.hostId, hostName: hostName(p.hostId), cwd: p.dir, projectId: p.id });
}

export function projectSheet(p: Project) {
  actionSheet(p.name, [
    { label: t("New session in {project}", { project: p.name }), onSelect: () => newSessionInProject(p) },
    { label: t("Edit project"), desc: `${hostName(p.hostId)} · ${shortPath(p.dir)}`, onSelect: () => projectDialog(p) },
    {
      label: t("Delete project"),
      desc: t("The sessions stay, only without a project."),
      danger: true,
      onSelect: () => deleteProject(p.id),
    },
  ]);
}

// ---------------------------------------------------------------- tidy up (H4)

const DAY = 86_400_000;

/** Keys that "tidy up" would archive: shown hosts, not archived yet, pinned/grouped only when asked, never working */
export function cleanupCandidates(o: { olderThanDays: number; grouped: boolean; pinned: boolean }, now = Date.now()): string[] {
  const host = prefs().host;
  const out: string[] = [];
  for (const hst of state.hosts) {
    if (host && hst.id !== host) continue;
    for (const s of state.sessions.get(hst.id) ?? []) {
      const key = `${hst.id}|${s.path}`;
      const m = metaOf(key);
      if (m.group === ARCHIVE || data.working.has(key)) continue;
      if (m.pinned && !o.pinned) continue;
      if (m.group && !o.grouped) continue;
      const ts = (s.modified ?? 0) * 1000 || Date.parse(s.timestamp);
      if (o.olderThanDays && ts && now - ts < o.olderThanDays * DAY) continue;
      out.push(key);
    }
  }
  return out;
}

export function cleanupDialog() {
  const age = h(
    "select",
    {},
    h("option", { value: "0" }, t("all sessions")),
    h("option", { value: "1" }, t("older than 1 day")),
    h("option", { value: "7", selected: true }, t("older than 1 week")),
    h("option", { value: "30" }, t("older than 1 month")),
  );
  const grouped = h("input", { type: "checkbox", checked: true });
  const pinned = h("input", { type: "checkbox" });
  const count = h("p", { class: "sl-cleanup-count" });
  const opts = () => ({ olderThanDays: Number(age.value), grouped: grouped.checked, pinned: pinned.checked });
  const go = button(
    t("Move to archive"),
    () => {
      const keys = cleanupCandidates(opts());
      close();
      run(() => archiveKeys(keys));
    },
    "primary",
  );
  const update = () => {
    const n = cleanupCandidates(opts()).length;
    count.textContent = n ? t("{n} sessions go into the archive.", { n }) : t("Nothing to tidy up with these settings.");
    go.disabled = !n;
  };
  for (const el of [age, grouped, pinned]) el.addEventListener("change", update);
  update();
  const close = openModal(
    t("Tidy up sessions"),
    h(
      "div",
      { class: "form" },
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Sessions")), age),
      h("label", { class: "check" }, grouped, t("also sessions in other groups")),
      h("label", { class: "check" }, pinned, t("also pinned sessions")),
      count,
      h(
        "p",
        { class: "hint" },
        t("The archive is a collapsed group at the end of the list; nothing is deleted. Sessions where Pi is working stay."),
      ),
    ),
    [button(t("Cancel"), () => close()), go],
  );
}

// ---------------------------------------------------------------- view sheet

/** Order, sections, filter and colour filter of the list, plus the organisation actions */
export function viewSheet() {
  const p = prefs();
  const set = (patch: Partial<ListPrefs>) => () => setPrefs(patch);
  const sorts: [ListPrefs["sort"], Msg][] = [
    ["activity", "Last activity"],
    ["created", "Created"],
    ["name", "Name"],
    ["folder", "Folder"],
  ];
  const sections: [ListPrefs["sections"], Msg][] = [
    ["date", "Date"],
    ["folder", "Folder"],
    ["none", "No sections"],
  ];
  const heading = (text: string) => h("h4", { class: "sl-sheet-heading" }, text);
  const body = h("div", { class: "sl-sheet" });
  const close = openModal(t("View"), body, [button(t("Close"), () => close())], undefined, "sl-modal");
  /** `reopen`: the sheet comes back with the new state, so several view settings can be changed in one go */
  const rows = (items: SheetItem[], reopen = true) => {
    const list = h("div", { class: "sl-sheet-list" });
    for (const it of items) {
      list.append(
        h(
          "button",
          {
            type: "button",
            class: `sl-sheet-item ${it.selected ? "selected" : ""} ${it.danger ? "danger" : ""}`,
            onclick: () => {
              close();
              run(it.onSelect);
              if (reopen) viewSheet();
            },
          },
          it.color !== undefined ? h("span", { class: `sl-dot ${it.color ? `c-${it.color}` : "none"}` }) : null,
          h("span", { class: "sl-sheet-label" }, it.label),
          it.selected ? h("span", { class: "sl-sheet-check", "aria-hidden": "true" }, "✓") : null,
        ),
      );
    }
    return list;
  };
  const toggleColor = (c: string) => () => {
    const cur = new Set(p.colors);
    if (cur.has(c)) cur.delete(c);
    else cur.add(c);
    setPrefs({ colors: [...cur] });
  };
  const action = (label: string, fn: () => void): SheetItem => ({ label, onSelect: fn });
  body.append(
    heading(t("Sort by")),
    rows(sorts.map(([v, l]) => ({ label: t(l), selected: p.sort === v, onSelect: set({ sort: v }) }))),
    heading(t("Sections")),
    rows(sections.map(([v, l]) => ({ label: t(l), selected: p.sections === v, onSelect: set({ sections: v }) }))),
    heading(t("Show")),
    rows([
      { label: t("Everything"), selected: p.filter === "all", onSelect: set({ filter: "all" }) },
      { label: t("Only what I am working on"), selected: p.filter === "active", onSelect: set({ filter: "active" }) },
    ]),
    heading(t("Colour")),
    rows([
      { label: t("Every colour"), selected: !p.colors.length, onSelect: set({ colors: [] }) },
      ...COLORS.map((c) => ({ label: colorLabel(c, data.labels), color: c, selected: p.colors.includes(c), onSelect: toggleColor(c) })),
      { label: t("Without colour"), color: "", selected: p.colors.includes("none"), onSelect: toggleColor("none") },
    ]),
    heading(t("Organise")),
    rows([
      action(t("Select sessions …"), () => setSelecting(true)),
      action(t("New group …"), () => void newGroup().catch((e: unknown) => toast(errMsg(e), "err"))),
      action(t("New project …"), () => projectDialog()),
      action(t("Tidy up sessions"), () => cleanupDialog()),
    ], false),
  );
}
