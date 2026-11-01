// Folder picker: browses the folders of a host (local or SSH) and returns the chosen one.
import { api, type DirListing } from "../shared/api";
import { errMsg, h, openModal } from "../shared/dom";
import { t } from "../shared/i18n";
import { icon } from "../shared/icons";

/** Absolute path as "~/…" if it lies in the home folder */
export function tildePath(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Parent of an absolute path */
export function parentDir(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Opens the picker at `start` (falls back to ~); resolves with the folder or null if cancelled */
export function pickFolder(hostId: string, start: string): Promise<string | null> {
  return new Promise((resolve) => {
    let cur: DirListing | null = null;
    let hidden = false;
    let done = false;
    const finish = (v: string | null) => {
      if (done) return;
      done = true;
      close();
      resolve(v);
    };

    const inPath = h("input", { type: "text", spellcheck: false }) as HTMLInputElement;
    const list = h("div", { class: "fp-list" });
    const status = h("div", { class: "fp-status" });
    const chkHidden = h("input", { type: "checkbox" }) as HTMLInputElement;

    const load = async (path: string, fallback = true) => {
      status.textContent = t("Loading …");
      try {
        cur = await api.listDirs(hostId, path || "~", hidden);
        inPath.value = tildePath(cur.path, cur.home);
        status.textContent = cur.dirs.length ? "" : t("No subfolders");
        list.replaceChildren(
          ...cur.dirs.map((d) =>
            h(
              "button",
              { class: "fp-item", title: d, onclick: () => load(`${cur!.path}/${d}`) },
              icon("folder", 14),
              h("span", {}, d),
            ),
          ),
        );
        list.scrollTop = 0;
      } catch (e) {
        if (fallback && path !== "~") return load("~", false);
        status.textContent = errMsg(e);
      }
    };

    const newFolder = () => {
      if (!cur) return;
      const base = cur.path;
      const input = h("input", { type: "text", placeholder: t("new-folder") }) as HTMLInputElement;
      const create = async () => {
        const name = input.value.trim().replace(/^\/+|\/+$/g, "");
        if (!name) return;
        try {
          await api.createDir(hostId, `${base}/${name}`);
          closeNew();
          await load(`${base}/${name}`);
        } catch (e) {
          status.textContent = `${t("Create folder")}: ${errMsg(e)}`;
        }
      };
      input.addEventListener("keydown", (e) => e.key === "Enter" && create());
      const closeNew = openModal(
        t("New folder"),
        h("div", {}, h("div", { class: "row" }, h("label", {}, t("Name")), input)),
        [
          h("button", { class: "ghost", onclick: () => closeNew() }, t("Cancel")),
          h("button", { class: "primary", onclick: create }, t("Create")),
        ],
      );
    };

    inPath.addEventListener("keydown", (e) => e.key === "Enter" && load(inPath.value.trim(), false));
    chkHidden.addEventListener("change", () => {
      hidden = chkHidden.checked;
      if (cur) load(cur.path);
    });
    const tool = (name: "up" | "home" | "plus", title: string, onclick: () => void) => {
      const b = h("button", { class: "ghost fp-tool", title, onclick }, icon(name, 14));
      b.setAttribute("aria-label", title);
      return b;
    };

    const close = openModal(
      t("Choose folder"),
      h(
        "div",
        { class: "fp" },
        h(
          "div",
          { class: "fp-bar" },
          tool("up", t("Up"), () => cur && load(parentDir(cur.path))),
          tool("home", t("Home folder"), () => load("~")),
          inPath,
          tool("plus", t("New folder"), newFolder),
        ),
        list,
        h("div", { class: "fp-foot" }, status, h("label", { class: "check" }, chkHidden, t("Hidden folders"))),
      ),
      [
        h("button", { class: "ghost", onclick: () => finish(null) }, t("Cancel")),
        h("button", { class: "primary", onclick: () => cur && finish(inPath.value.trim() || "~") }, t("Choose")),
      ],
    );
    // Escape / click beside the dialog also cancel
    const backdrop = list.closest(".modal-backdrop");
    new MutationObserver((_, obs) => {
      if (backdrop && !backdrop.isConnected) {
        obs.disconnect();
        if (!done) {
          done = true;
          resolve(null);
        }
      }
    }).observe(document.getElementById("modal-root")!, { childList: true });
    load(start);
  });
}

/** Text field with a "…" button that opens the picker; `host` gives the host to browse */
export function folderField(input: HTMLInputElement, host: () => string): HTMLElement {
  const b = h(
    "button",
    {
      class: "ghost fp-open",
      title: t("Choose folder"),
      onclick: async () => {
        const v = await pickFolder(host(), input.value.trim() || "~");
        if (v) {
          input.value = v;
          input.focus();
        }
      },
    },
    icon("folder", 14),
  );
  b.setAttribute("aria-label", t("Choose folder"));
  return h("div", { class: "fp-field" }, input, b);
}
