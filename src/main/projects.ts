// "Projects" rubric in the left column, below the hosts: named folders whose sessions are grouped under the project.
// A new session started from a project always runs in the project's folder, with the preset fixed for the project.
// Stored in AppConfig.projects.
import { type Project } from "../shared/api";
import { VIEWS, isChatMode } from "../shared/chatViews";
import { isContextMode } from "../shared/contextMode";
import { h, openModal, toast } from "../shared/dom";
import { baseName, shortPath } from "../shared/format";
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";
import { projectAt } from "../shared/projects";
import { activityOfRows, marks } from "./activity";
import { blockDrop, blockGrip } from "./blockDrag";
import { folderField } from "./folderPicker";
import { openMenu } from "./menu";
import {
  defaultHostId,
  hostStatusDot,
  hostStatusTitle,
  type ListRow,
  newSessionDialog,
  renderHosts,
  sessionSections,
} from "./sessions";
import { saveConfig, state } from "./state";

/** User-defined projects (AppConfig.projects) */
export function projects(): Project[] {
  return (state.config.projects ??= []);
}

/** Project a session belongs to (matching by host and folder, see projectAt); undefined = no project */
export function projectOf(hostId: string, cwd: string): Project | undefined {
  return projectAt(projects(), hostId, cwd);
}

/** Move a project before or after another one (drag by the grip); the order is saved */
function moveProject(fromId: string, toId: string, after: boolean) {
  const list = projects();
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

/** Open or close a project in the left column */
export function toggleProject(p: Project) {
  p.collapsed = !p.collapsed;
  saveConfig();
  renderHosts();
}

/** New session in a project: the dialog opens with the project's host, folder and preset, all fixed */
export function newSessionInProject(p: Project) {
  newSessionDialog(p.hostId, {
    dir: p.dir,
    title: t("New session in {project}", { project: p.name }),
    locked: true,
    preset: p.preset,
  });
}

/** Name of the preset fixed for a project; empty if none is set or the preset was deleted in the settings */
function presetName(p: Project): string {
  return (state.config.presets ?? []).find((x) => x.id === p.preset)?.name ?? "";
}

/** Label of the chat view fixed for a project; empty if none is set (then the settings decide) */
function viewName(p: Project): string {
  const found = VIEWS.find(([m]) => m === p.view);
  return found ? t(found[1]) : "";
}

/** Label of the context mode fixed for a project; empty if none is set (then the settings decide) */
function modeName(p: Project): string {
  return p.contextMode === "private"
    ? t("Private – full context")
    : p.contextMode === "public"
      ? t("Public – reduced context")
      : "";
}

/** Short label of the mode fixed for a project, for the heading of the project */
function modeShort(p: Project): string {
  return p.contextMode === "private" ? t("Private") : p.contextMode === "public" ? t("Public") : "";
}

// ---------- Dialogs ----------

/**
 * Create a project or change its name, host, folder, fixed preset and default view. A project needs a folder: sessions
 * that run there appear under the project, and a new session started from the project runs there. `focus` picks the
 * field to edit first.
 */
export function projectDialog(
  existing?: Project,
  hostId?: string,
  focus: "name" | "dir" | "preset" | "view" | "mode" = "name",
) {
  const hosts = state.config.hosts;
  if (!hosts.length) return toast(t("Add a host first in the settings."), "err");
  const start = existing?.hostId ?? hostId ?? defaultHostId() ?? hosts[0].id;
  const inName = h("input", {
    type: "text",
    value: existing?.name ?? "",
    placeholder: t("e.g. PiBar"),
  }) as HTMLInputElement;
  const selHost = h(
    "select",
    {},
    ...hosts.map((x) => h("option", { value: x.id, selected: x.id === start }, x.name)),
  ) as HTMLSelectElement;
  const inDir = h("input", { type: "text", value: existing?.dir ?? "", placeholder: "~/project" }) as HTMLInputElement;
  // fixed inference preset: every session started from the project begins with this model and thinking level
  const presets = state.config.presets ?? [];
  const selPreset = h(
    "select",
    { disabled: !presets.length },
    h("option", { value: "", selected: !existing?.preset }, t("Default of the settings")),
    ...presets.map((x) => h("option", { value: x.id, selected: x.id === existing?.preset }, x.name)),
  ) as HTMLSelectElement;
  // default chat view of the sessions here: they start with it until one is switched in the header
  const selView = h(
    "select",
    {},
    h("option", { value: "", selected: !isChatMode(existing?.view) }, t("Default of the settings")),
    ...VIEWS.map(([v, label]) => h("option", { value: v, selected: existing?.view === v }, t(label))),
  ) as HTMLSelectElement;
  // default context mode of the sessions here (Pi extension mode-guard): private = full, public = reduced context
  const selMode = h(
    "select",
    {},
    h("option", { value: "", selected: !isContextMode(existing?.contextMode) }, t("Default of the settings")),
    h("option", { value: "private", selected: existing?.contextMode === "private" }, t("Private – full context")),
    h("option", { value: "public", selected: existing?.contextMode === "public" }, t("Public – reduced context")),
  ) as HTMLSelectElement;
  // a new project follows the default folder of its host until the user types or picks another one
  let follow = !existing;
  const fill = () => {
    if (follow) inDir.value = hosts.find((x) => x.id === selHost.value)?.defaultDir || "~";
  };
  fill();
  selHost.addEventListener("change", fill);
  inDir.addEventListener("input", () => (follow = false));
  const done = () => {
    const dir = inDir.value.trim();
    if (!dir) return toast(t("Choose a folder for the project."), "err");
    const name = inName.value.trim() || baseName(dir) || t("Project");
    if (existing) {
      existing.name = name;
      existing.hostId = selHost.value;
      existing.dir = dir;
      existing.preset = selPreset.value;
      existing.view = selView.value;
      existing.contextMode = isContextMode(selMode.value) ? selMode.value : undefined;
    } else {
      projects().push({
        id: `p${Date.now()}`,
        name,
        hostId: selHost.value,
        dir,
        collapsed: false,
        preset: selPreset.value,
        view: selView.value,
        contextMode: isContextMode(selMode.value) ? selMode.value : undefined,
      });
    }
    saveConfig();
    close();
    renderHosts();
  };
  for (const i of [inName, inDir])
    i.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) done();
    });
  const close = openModal(
    existing ? t("Edit project") : t("New project"),
    h(
      "div",
      {},
      h("div", { class: "row" }, h("label", {}, t("Name")), inName),
      h("div", { class: "row" }, h("label", {}, t("Host")), selHost),
      h(
        "div",
        { class: "row" },
        h("label", {}, t("Folder")),
        folderField(
          inDir,
          () => selHost.value,
          () => (follow = false),
        ),
      ),
      h("div", { class: "row" }, h("label", {}, t("Inference preset")), selPreset),
      h("div", { class: "row" }, h("label", {}, t("View")), selView),
      h("div", { class: "row" }, h("label", {}, t("Context mode")), selMode),
      h(
        "p",
        { class: "hint" },
        t(
          "Sessions whose working folder lies in this folder appear under the project. A new session started here runs in this folder, with the preset chosen here.",
        ),
      ),
      h(
        "p",
        { class: "hint" },
        t("The view applies to every session in the project – a session keeps the view you switch in the header."),
      ),
      h(
        "p",
        { class: "hint" },
        t(
          "The context mode applies to new sessions in the project (needs the mode-guard extension) – a session keeps the mode you switch in the header.",
        ),
      ),
      presets.length ? null : h("p", { class: "hint" }, t("No preset yet – create one in the settings under Models.")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: done }, t("Save")),
    ],
  );
  const first =
    focus === "dir"
      ? inDir
      : focus === "preset"
        ? selPreset
        : focus === "view"
          ? selView
          : focus === "mode"
            ? selMode
            : inName;
  setTimeout(() => first.focus(), 0);
}

/** Right click or "⋯" on a project: new session in it, rename, change folder, delete */
export function projectMenu(anchor: HTMLElement, p: Project, at?: { x: number; y: number }) {
  openMenu(
    anchor,
    [
      { label: t("New session in {project}", { project: p.name }), onSelect: () => newSessionInProject(p) },
      { separator: true },
      { label: t("Rename …"), onSelect: () => projectDialog(p, undefined, "name") },
      { label: t("Change folder …"), onSelect: () => projectDialog(p, undefined, "dir") },
      {
        label: `${t("Inference preset")}: ${presetName(p) || t("Default of the settings")}`,
        onSelect: () => projectDialog(p, undefined, "preset"),
      },
      {
        label: `${t("View")}: ${viewName(p) || t("Default of the settings")}`,
        desc: t("Chat view its sessions start with"),
        onSelect: () => projectDialog(p, undefined, "view"),
      },
      {
        label: `${t("Context mode")}: ${modeName(p) || t("Default of the settings")}`,
        desc: t("Context mode its sessions start with"),
        onSelect: () => projectDialog(p, undefined, "mode"),
      },
      { separator: true },
      {
        label: t("Delete project"),
        desc: t("The sessions stay, only without a project."),
        danger: true,
        onSelect: () => {
          state.config.projects = projects().filter((x) => x.id !== p.id);
          saveConfig();
          renderHosts();
        },
      },
    ],
    "right",
    at,
  );
}

// ---------- Rendering ----------

/** One project in the left column: header with name, folder, count and actions, then its sessions */
function projectBlock(p: Project, rows: ListRow[]): HTMLElement {
  const host = state.config.hosts.find((x) => x.id === p.hostId);
  const st = state.hostStatus.get(p.hostId);
  const menu = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    projectMenu(
      e.currentTarget as HTMLElement,
      p,
      e.type === "contextmenu" ? { x: e.clientX, y: e.clientY } : undefined,
    );
  };
  // "All" shows projects of every host: the host name tells where the folder lives
  const where = [shortPath(p.dir) || "~", state.config.ui.selectedHost === "all" ? host?.name : ""]
    .filter(Boolean)
    .join(" · ");
  // a session of the project is working (or finished unseen): visible at the heading, also with the project closed
  const act = activityOfRows(rows);
  // the context menu belongs to the header: right click on a session inside keeps the session's own menu
  const box = h(
    "div",
    { class: `block proj ${p.collapsed ? "collapsed" : ""} ${act.working ? "working" : ""}` },
    h(
      "div",
      { class: "block-head host-head", oncontextmenu: menu },
      blockGrip("project", p.id, p.name),
      h(
        "button",
        { class: "chev", title: p.collapsed ? t("Expand") : t("Collapse"), onclick: () => toggleProject(p) },
        "▾",
      ),
      hostStatusDot(st),
      h(
        "span",
        { class: "host-name", title: hostStatusTitle(st), onclick: () => toggleProject(p) },
        p.name,
        // the preset every session started here begins with, and the view its sessions start with
        presetName(p) ? h("span", { class: "host-preset", title: t("Inference preset") }, presetName(p)) : null,
        viewName(p) ? h("span", { class: "host-preset view", title: t("View") }, viewName(p)) : null,
        modeShort(p)
          ? h("span", { class: "host-preset mode", title: t("Context mode its sessions start with") }, modeShort(p))
          : null,
        h("span", { class: "host-where" }, where),
      ),
      ...marks(act),
      h("span", { class: "count" }, String(rows.length)),
      h(
        "button",
        {
          class: "icon-btn",
          title: t("New session in {project}", { project: p.name }),
          onclick: () => newSessionInProject(p),
        },
        "＋",
      ),
      h("button", { class: "icon-btn", title: t("More …"), onclick: menu }, icon("more", 13)),
    ),
    p.collapsed
      ? null
      : h(
          "div",
          { class: "block-body" },
          rows.length
            ? h("div", {}, ...sessionSections(rows, `p:${p.id}|`, `p:${p.id}`))
            : h("div", { class: "hint-line" }, t("No sessions yet")),
        ),
  );
  blockDrop(box, "project", p.id, (fromId, after) => moveProject(fromId, p.id, after));
  return box;
}

/**
 * The "Projects" rubric under the hosts: heading, one block per project of the shown hosts and "New project".
 * `rowsOf` gives the sessions of a project; sessions.ts knows the session lists.
 */
export function renderProjects(shown: Project[], rowsOf: (p: Project) => ListRow[]): HTMLElement[] {
  // with a single host chosen, the dialog starts on that host; in the "All" view on the usual default
  const sel = state.config.ui.selectedHost;
  const add = h(
    "button",
    {
      class: "new-proj",
      title: t("New project …"),
      onclick: () => projectDialog(undefined, sel === "all" ? undefined : sel),
    },
    `＋ ${t("New project …")}`,
  );
  return [
    h(
      "div",
      { class: "proj-rubric" },
      h("div", { class: "sec-head proj-head" }, t("Projects")),
      ...shown.map((p) => projectBlock(p, rowsOf(p))),
      add,
    ),
  ];
}
