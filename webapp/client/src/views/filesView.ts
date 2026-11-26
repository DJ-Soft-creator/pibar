// One file of the files tab (tasks G2, G3): Markdown rendered, HTML in a sandboxed frame without scripts, pictures
// (read_image), code and text highlighted, PDFs through the download route in a new tab. Text files can be edited
// with a preview toggle; saving reads the file again first and asks when it changed since it was opened (Pi may
// have written it). Behaviour of the editor follows src/main/files.ts.
import hljs from "highlight.js/lib/common";
import { api } from "@shared/api";
import { errMsg, h, openModal, renderMarkdown, toast } from "@shared/dom";
import { baseName, shortPath } from "@shared/format";
import { t } from "@shared/i18n";
import { button, confirmDialog } from "../ui";
import { fileHistoryScreen } from "./filesGit";
import {
  actionSheet,
  deleteDialog,
  dirName,
  downloadFile,
  downloadUrl,
  isHtml,
  isImage,
  isMarkdown,
  isPdf,
  lineDiff,
  screenHead,
  type FilesCtx,
  type Screen,
} from "./filesShared";

/** Above this size code is shown without highlighting (keeps the phone responsive) */
const HIGHLIGHT_MAX = 150_000;

type Mode = "view" | "edit" | "diff";

/** Called after a delete so the tree forgets the file */
export type OnDeleted = (path: string) => void;

export function fileScreen(ctx: FilesCtx, path: string, onDeleted: OnDeleted): Screen {
  const name = baseName(path);
  const image = isImage(path);
  const pdf = isPdf(path);
  const st = {
    loading: !pdf,
    error: "",
    /** Content as last read or saved */
    original: "",
    mode: "view" as Mode,
    imageUrl: "",
    saving: false,
  };
  const text = h("textarea", { class: "fx-editor", spellcheck: "false", autocapitalize: "off", autocomplete: "off" });
  text.addEventListener("input", () => updateDirty());
  let saveBtn: HTMLButtonElement | null = null;
  let rootEl: HTMLElement | null = null;

  const dirty = () => !image && !pdf && !st.loading && !st.error && text.value !== st.original;
  const updateDirty = () => {
    if (saveBtn) saveBtn.hidden = !dirty();
  };

  async function load() {
    st.loading = true;
    st.error = "";
    rerender();
    try {
      if (image) {
        const img = await api.readImage(ctx.hostId, path);
        st.imageUrl = `data:${img.mimeType};base64,${img.data}`;
      } else {
        st.original = await api.readFile(ctx.hostId, path);
        text.value = st.original;
      }
    } catch (e) {
      st.error = errMsg(e);
    }
    st.loading = false;
    rerender();
  }

  function rerender() {
    if (rootEl?.isConnected) render(rootEl);
  }

  /** Save with conflict detection: the file on the host must still be what was opened */
  async function save() {
    if (!dirty() || st.saving) return;
    st.saving = true;
    const content = text.value;
    try {
      let current: string | null;
      try {
        current = await api.readFile(ctx.hostId, path);
      } catch {
        current = null; // gone or unreadable: ask too
      }
      if (current !== st.original) {
        const choice = await conflictDialog(current === null);
        if (choice === "cancel") return;
        if (choice === "reload") {
          if (current !== null) {
            st.original = current;
            text.value = current;
          }
          rerender();
          return;
        }
      }
      await api.writeFile(ctx.hostId, path, content);
      st.original = content;
      toast(t("Saved: {file}", { file: name }));
      void ctx.reload();
      rerender();
    } catch (e) {
      toast(`${t("Saving failed")}: ${errMsg(e)}`, "err");
    } finally {
      st.saving = false;
    }
  }

  function viewBody(): HTMLElement {
    if (st.loading) return h("div", { class: "loading" }, t("Loading …"));
    if (pdf) {
      return h(
        "div",
        { class: "fx-card-center" },
        h("p", {}, t("PDF documents open in the browser's own viewer.")),
        // a real link: opening a tab after an await would be blocked as a popup
        h("a", { class: "btn primary", href: downloadUrl(ctx.hostId, path, true), target: "_blank", rel: "noopener" }, t("Open PDF")),
      );
    }
    if (st.error) {
      return h(
        "div",
        { class: "fx-card-center" },
        h("p", { class: "error" }, st.error),
        button(t("Download"), () => void downloadFile(ctx.hostId, path)),
      );
    }
    if (image) return h("div", { class: "fx-image" }, h("img", { src: st.imageUrl, alt: name }));
    if (st.mode === "edit") return text;
    if (st.mode === "diff") return diffBody();
    if (!text.value) return h("div", { class: "fx-empty" }, t("Empty file"));
    if (isMarkdown(path)) {
      const el = h("div", { class: "md fx-md" });
      renderMarkdown(el, text.value);
      return el;
    }
    if (isHtml(path)) return htmlFrame(text.value);
    return codeView(path, text.value);
  }

  /** Diff of the editor text against Git HEAD (or the saved file outside Git) */
  let head: { inGit: boolean; text: string | null } | undefined;
  function diffBody(): HTMLElement {
    if (head === undefined) {
      void api
        .readFileHead(ctx.hostId, path)
        .catch(() => ({ inGit: false, text: null }))
        .then((v) => {
          head = v;
          rerender();
        });
      return h("div", { class: "loading" }, t("Loading …"));
    }
    if (!head.inGit) return lineDiff(st.original, text.value, t("Not in a Git repository"));
    return lineDiff(head.text ?? "", text.value, head.text === null ? t("New file, not in Git yet") : t("Git (last commit)"));
  }

  function modeTabs(): HTMLElement | null {
    if (image || pdf || st.loading || st.error) return null;
    const plain = !isMarkdown(path) && !isHtml(path);
    const tab = (mode: Mode, label: string) =>
      h(
        "button",
        {
          type: "button",
          class: `fx-seg-btn ${st.mode === mode ? "active" : ""}`,
          "aria-pressed": st.mode === mode ? "true" : "false",
          onclick: () => {
            st.mode = mode;
            if (mode === "diff") head = undefined;
            rerender();
          },
        },
        label,
      );
    return h(
      "div",
      { class: "fx-seg", role: "group" },
      tab("view", plain ? t("View") : t("Preview")),
      tab("edit", t("Edit")),
      tab("diff", t("Diff")),
    );
  }

  function more() {
    actionSheet(name, [
      { label: t("Download"), onSelect: () => void downloadFile(ctx.hostId, path) },
      { label: t("History (Git)"), onSelect: () => ctx.push(fileHistoryScreen(ctx, path)) },
      ...(image || pdf ? [] : [{ label: t("Reload"), onSelect: () => void reloadFile() }]),
      {
        label: t("Delete file …"),
        danger: true,
        onSelect: () =>
          deleteDialog(path, false, () => {
            void api
              .deletePath(ctx.hostId, path, ctx.roots())
              .then(() => {
                st.original = text.value; // gone: no "discard changes?" on the way back
                toast(t("Deleted: {name}", { name }));
                onDeleted(path);
                ctx.back();
                void ctx.reload();
              })
              .catch((e: unknown) => toast(`${t("Delete")}: ${errMsg(e)}`, "err"));
          }),
      },
    ]);
  }

  /** Load the file again; unsaved changes are asked about first */
  async function reloadFile() {
    if (dirty() && !(await confirmDialog(t("Discard unsaved changes?"), name, t("Discard")))) return;
    head = undefined;
    await load();
  }

  function render(root: HTMLElement) {
    rootEl = root;
    saveBtn = button(t("Save"), () => void save(), "primary fx-save");
    saveBtn.hidden = !dirty();
    const moreBtn = h(
      "button",
      { type: "button", class: "icon-btn", title: t("More"), "aria-label": t("More"), onclick: more },
      "⋯",
    );
    root.replaceChildren(
      h(
        "div",
        { class: `fx-screen fx-file ${st.mode === "edit" ? "editing" : ""}` },
        screenHead(ctx, name, shortPath(dirName(path)), [saveBtn, moreBtn]),
        modeTabs(),
        viewBody(),
      ),
    );
  }

  const screen: Screen = {
    render,
    canLeave: async () =>
      !dirty() || (await confirmDialog(t("Discard unsaved changes?"), name, t("Discard"))),
  };
  if (!pdf) void load();
  return screen;
}

/** Three ways out of a save conflict */
function conflictDialog(gone: boolean): Promise<"overwrite" | "reload" | "cancel"> {
  return new Promise((resolve) => {
    let answer: "overwrite" | "reload" | "cancel" = "cancel";
    const done = (a: typeof answer) => {
      answer = a;
      close();
    };
    const close = openModal(
      t("File changed on the host"),
      h(
        "div",
        {},
        h(
          "p",
          {},
          gone
            ? t("The file can no longer be read on the host (deleted or moved?).")
            : t("The file was changed since you opened it, maybe by Pi."),
        ),
        h("p", { class: "hint" }, t("Overwrite replaces those changes with yours.")),
      ),
      [
        button(t("Cancel"), () => done("cancel")),
        gone ? null : button(t("Load new version"), () => done("reload")),
        button(t("Overwrite"), () => done("overwrite"), "danger"),
      ].filter((b): b is HTMLButtonElement => b !== null),
      () => resolve(answer),
    );
  });
}

/**
 * HTML in a sandboxed frame: no scripts, forms or popups, no access to the webapp (like the desktop's preview).
 * The page's CSP applies, so styles in the file and data: images show, files from the web do not.
 */
function htmlFrame(html: string): HTMLElement {
  const frame = document.createElement("iframe");
  frame.className = "fx-html";
  frame.setAttribute("sandbox", "");
  frame.setAttribute("referrerpolicy", "no-referrer");
  frame.title = t("HTML preview");
  frame.srcdoc = withoutScripts(html);
  return frame;
}

/**
 * The frame would block scripts anyway; taking them out first keeps the browser from logging a blocked script for
 * every <script> and on… handler of the page.
 */
function withoutScripts(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  doc.querySelectorAll("script").forEach((s) => s.remove());
  doc.querySelectorAll("*").forEach((el) => {
    for (const a of [...el.attributes]) if (/^on/i.test(a.name)) el.removeAttribute(a.name);
  });
  return `<!doctype html>${doc.documentElement.outerHTML}`;
}

/** Code and other text, highlighted by the file's extension when highlight.js knows it */
function codeView(path: string, text: string): HTMLElement {
  const code = h("code", { class: "hljs" });
  const ext = (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? "").toLowerCase();
  const lang = ext && hljs.getLanguage(ext) ? ext : "";
  if (lang && text.length <= HIGHLIGHT_MAX) {
    try {
      code.innerHTML = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    } catch {
      code.textContent = text;
    }
  } else {
    code.textContent = text;
  }
  if (!text) return h("div", { class: "fx-empty" }, t("Empty file"));
  return h("pre", { class: "fx-code" }, code);
}
