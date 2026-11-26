// Start a new session (task E5): a sheet with the folder (default: the project's folder, else the given one, else the
// host's default folder; a folder picker over list_dirs like src/main/folderPicker.ts, typing a path always works),
// the preset it starts with (project preset, else the user's last choice) and an optional name. Then the chat opens;
// Pi creates the session file with the first message. Used by the session list ("+", projects) and the chat.
import { api, type DirListing, type Project } from "@shared/api";
import { errMsg, h, openModal } from "@shared/dom";
import { shortModel, thinkingLabel } from "@shared/format";
import { t } from "@shared/i18n";
import { presetForNewSession } from "@shared/presets";
import { openChat, state, type ChatTarget } from "../state";
import { button } from "../ui";
import "./chat.css";
import { setStartOptions } from "./chatSession";
import { chatSettings, loadMeta, saveChatSettings, sharedConfig } from "./chatStore";

export interface NewSessionOptions {
  hostId: string;
  hostName: string;
  /** Folder to start in; without it the user picks one (default: the host's default folder) */
  cwd?: string;
  /** Project the session belongs to (its folder is used) */
  projectId?: string;
}

/** Absolute path as "~/…" if it lies in the home folder (folderPicker.ts tildePath) */
export function tildePath(path: string, home: string): string {
  if (!home || home === "/") return path;
  if (path === home) return "~";
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

/** Parent of an absolute path (folderPicker.ts parentDir) */
export function parentDir(path: string): string {
  const p = path.replace(/\/+$/, "");
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

/** Browse the folders of a host; resolves with the chosen folder or null */
export function pickFolder(hostId: string, start: string): Promise<string | null> {
  return new Promise((resolve) => {
    let cur: DirListing | null = null;
    let result: string | null = null;
    // the start of a long path is cut (rtl box), the path itself stays left-to-right
    const pathText = h("bdi", {}, start);
    const pathEl = h("div", { class: "fp-path" }, pathText);
    const list = h("div", { class: "fp-list" });
    const status = h("p", { class: "muted small" });
    const load = async (path: string, fallback = true) => {
      status.textContent = t("Loading …");
      try {
        cur = await api.listDirs(hostId, path || "~");
        const listing = cur;
        pathText.textContent = tildePath(listing.path, listing.home);
        status.textContent = listing.dirs.length ? "" : t("No subfolders");
        list.replaceChildren(
          ...listing.dirs.map((d) => h("button", { type: "button", class: "fp-item", onclick: () => void load(`${listing.path}/${d}`) }, h("span", { "aria-hidden": "true" }, "📁"), h("span", {}, d))),
        );
        list.scrollTop = 0;
      } catch (e) {
        if (fallback && path !== "~") return load("~", false);
        status.textContent = `${errMsg(e)} – ${t("Type the path instead.")}`;
      }
    };
    const close = openModal(
      t("Choose folder"),
      h(
        "div",
        { class: "fp" },
        h(
          "div",
          { class: "fp-bar" },
          button("↑", () => cur && void load(parentDir(cur.path)), "icon"),
          button("~", () => void load("~"), "icon"),
          pathEl,
        ),
        list,
        status,
      ),
      [
        button(t("Cancel"), () => close()),
        button(
          t("Choose"),
          () => {
            if (cur) result = tildePath(cur.path, cur.home);
            close();
          },
          "primary",
        ),
      ],
      () => resolve(result),
      "sheet-tall",
    );
    void load(start);
  });
}

export function startNewSession(o: NewSessionOptions) {
  void (async () => {
    const [shared, meta] = await Promise.all([sharedConfig(), loadMeta().catch(() => ({ sessionMeta: {}, projects: [] as Project[] }))]);
    const project = o.projectId ? meta.projects.find((p) => p.id === o.projectId) : undefined;
    const host = state.hosts.find((x) => x.id === o.hostId);
    const folder = h("input", { type: "text", spellcheck: false, autocapitalize: "off", "aria-label": t("Folder") });
    folder.value = project?.dir || o.cwd || host?.defaultDir || "~";
    const name = h("input", { type: "text", placeholder: t("optional"), "aria-label": t("Name") });
    let preset = presetForNewSession(shared.presets, project?.preset, chatSettings().defaultPreset)?.id ?? "";
    const presetBox = h("div", { class: "preset-grid" });
    const renderPresets = () => {
      const all: { id: string; name: string; sub: string }[] = [
        { id: "", name: t("Pi's default"), sub: t("Model of the host") },
        ...shared.presets.map((p) => ({
          id: p.id,
          name: p.name,
          sub: [p.model ? shortModel(p.model.split("/").slice(1).join("/")) : "", p.thinking ? thinkingLabel(p.thinking) : ""].filter(Boolean).join(" · "),
        })),
      ];
      presetBox.replaceChildren(
        ...all.map((p) =>
          h(
            "button",
            {
              type: "button",
              class: `preset-btn ${p.id === preset ? "on" : ""}`,
              "aria-pressed": p.id === preset ? "true" : "false",
              onclick: () => {
                preset = p.id;
                renderPresets();
              },
            },
            h("span", { class: "preset-name" }, p.name),
            h("span", { class: "preset-sub" }, p.sub),
          ),
        ),
      );
    };
    renderPresets();
    const start = () => {
      const cwd = folder.value.trim() || "~";
      close();
      const target: ChatTarget = { hostId: o.hostId, hostName: o.hostName, path: null, cwd, title: name.value.trim() };
      setStartOptions(target, { preset: preset || undefined, meta: name.value.trim() ? { name: name.value.trim() } : undefined });
      // the last choice is the default of the next new session (a project's preset does not count as a choice)
      if (!project?.preset && preset !== (chatSettings().defaultPreset ?? "")) void saveChatSettings({ defaultPreset: preset });
      openChat(target);
    };
    folder.addEventListener("keydown", (e) => e.key === "Enter" && start());
    const close = openModal(
      project ? t("New session in {name}", { name: project.name }) : t("New session on {host}", { host: o.hostName }),
      h(
        "div",
        { class: "form new-session" },
        h(
          "label",
          { class: "field" },
          h("span", { class: "field-label" }, t("Folder")),
          h(
            "div",
            { class: "fp-field" },
            folder,
            button(t("Choose …"), () => {
              void pickFolder(o.hostId, folder.value.trim() || "~").then((v) => {
                if (v) folder.value = v;
              });
            }),
          ),
        ),
        shared.presets.length ? h("div", { class: "field" }, h("span", { class: "field-label" }, t("Preset")), presetBox) : null,
        h("label", { class: "field" }, h("span", { class: "field-label" }, t("Name")), name),
      ),
      [button(t("Cancel"), () => close()), button(t("Start"), start, "primary")],
    );
  })();
}
