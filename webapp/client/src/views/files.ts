// Files of the open session's folder (tasks G1–G6): tree, view, edit, upload/download, delete, Git history and
// commit. Placeholder of the rebuild.
import { h } from "@shared/dom";
import { t } from "@shared/i18n";
import { header } from "../ui";

export function renderFiles(root: HTMLElement) {
  root.replaceChildren(header(t("Files")), h("div", { class: "empty" }, h("p", {}, "…")));
}
