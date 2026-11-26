// Folder choice of the files tab when no chat is open (or to look at another folder): host, folders of the host's
// sessions as quick picks, and a browser through the host's folders (list_dirs, like src/main/folderPicker.ts).
import { api, type DirListing } from "@shared/api";
import { errMsg, h } from "@shared/dom";
import { shortPath } from "@shared/format";
import { t } from "@shared/i18n";
import { state } from "../state";
import { button } from "../ui";
import { dirName } from "./filesShared";

export interface PickerOpts {
  hostId: string;
  /** Folder to start browsing in */
  start: string;
  onPick(hostId: string, folder: string): void;
  /** Shown as back button when there is something to go back to */
  onCancel?: () => void;
}

/** Renders the picker into `root`; keeps its own state between renders of the tab */
export function folderPicker(opts: PickerOpts): (root: HTMLElement) => void {
  let hostId = opts.hostId;
  let cur: DirListing | null = null;
  let error = "";
  let loading = false;
  let rootEl: HTMLElement | null = null;
  const rerender = () => {
    if (rootEl?.isConnected) render(rootEl);
  };

  async function load(path: string) {
    loading = true;
    error = "";
    rerender();
    try {
      cur = await api.listDirs(hostId, path);
    } catch (e) {
      error = errMsg(e);
    }
    loading = false;
    rerender();
  }

  /** Distinct working folders of the host's loaded sessions, newest first */
  function sessionFolders(): string[] {
    const list = state.sessions.get(hostId) ?? [];
    return [...new Set(list.map((s) => s.cwd).filter(Boolean))].slice(0, 8);
  }

  function render(root: HTMLElement) {
    rootEl = root;
    const hostSel =
      state.hosts.length > 1
        ? h(
            "select",
            {
              "aria-label": t("Host"),
              onchange: (e: Event) => {
                hostId = (e.target as HTMLSelectElement).value;
                cur = null;
                const host = state.hosts.find((x) => x.id === hostId);
                void load(host?.defaultDir || "~");
              },
            },
            ...state.hosts.map((x) => h("option", { value: x.id, selected: x.id === hostId }, x.name)),
          )
        : null;
    const quick = sessionFolders();
    const here = cur?.path ?? "";
    const rel = (p: string) => (cur?.home && (p === cur.home || p.startsWith(`${cur.home}/`)) ? `~${p.slice(cur.home.length)}` : shortPath(p));
    const up = here && here !== "/" ? dirName(here) || "/" : "";
    root.replaceChildren(
      h(
        "div",
        { class: "fx-screen fx-picker" },
        h(
          "header",
          { class: "fx-head" },
          opts.onCancel
            ? h("button", { type: "button", class: "icon-btn fx-back", "aria-label": t("Back"), onclick: opts.onCancel }, "‹")
            : null,
          h("div", { class: "fx-head-title" }, h("div", { class: "fx-head-name" }, t("Choose folder"))),
        ),
        hostSel,
        quick.length
          ? h(
              "div",
              {},
              h("div", { class: "section" }, t("Folders of your sessions")),
              h(
                "div",
                { class: "fx-list" },
                ...quick.map((f) =>
                  h("button", { type: "button", class: "fx-row", onclick: () => opts.onPick(hostId, f) }, h("span", { class: "fx-ic" }, "▸"), h("span", { class: "fx-name" }, shortPath(f))),
                ),
              ),
            )
          : null,
        h("div", { class: "section" }, t("Folder on the host")),
        h(
          "div",
          { class: "fx-pick-bar" },
          button("↑", () => up && void load(up), "fx-small"),
          button("~", () => void load("~"), "fx-small"),
          h("code", { class: "fx-pick-path" }, here ? `\u200e${rel(here)}\u200e` : "…"),
        ),
        error ? h("p", { class: "error" }, error) : null,
        loading
          ? h("div", { class: "loading" }, t("Loading …"))
          : h(
              "div",
              { class: "fx-list" },
              ...(cur?.dirs.length
                ? cur.dirs.map((d) =>
                    h(
                      "button",
                      { type: "button", class: "fx-row", onclick: () => void load(`${here === "/" ? "" : here}/${d}`) },
                      h("span", { class: "fx-ic" }, "▸"),
                      h("span", { class: "fx-name" }, d),
                    ),
                  )
                : [h("div", { class: "fx-empty" }, t("No subfolders"))]),
            ),
        button(t("Use this folder"), () => cur && opts.onPick(hostId, rel(cur.path)), "primary block fx-use"),
      ),
    );
  }

  void load(opts.start || "~");
  return render;
}
