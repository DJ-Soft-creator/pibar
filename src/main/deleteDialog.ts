// Deleting a file or folder of the right panel (src/main/files.ts): two confirmations, the second one with a
// checkbox that enables the final button. The Rust core only deletes inside the session folders (files::delete).
import { h, openModal } from "../shared/dom";
import { t } from "../shared/i18n";

/** Ask twice, then run `ok`; `dir`: a folder with its content instead of a single file */
export function deleteDialog(path: string, dir: boolean, ok: () => void) {
  const first = openModal(
    dir ? t("Delete folder?") : t("Delete file?"),
    h(
      "div",
      {},
      h("p", {}, dir ? t("The folder and everything in it will be deleted.") : t("The file will be deleted.")),
      h("p", {}, h("code", {}, path)),
      h("p", { class: "hint" }, t("This cannot be undone.")),
    ),
    [
      h("button", { class: "ghost", onclick: () => first() }, t("Cancel")),
      h(
        "button",
        {
          class: "danger",
          onclick: () => {
            first();
            second();
          },
        },
        t("Delete …"),
      ),
    ],
  );

  // second confirmation: the checkbox enables the final button, so a stray Enter cannot delete anything
  const second = () => {
    const check = h("input", { type: "checkbox", style: "width:auto" }) as HTMLInputElement;
    const btn = h("button", { class: "danger-solid", disabled: true }, t("Delete permanently")) as HTMLButtonElement;
    check.addEventListener("change", () => (btn.disabled = !check.checked));
    btn.addEventListener("click", () => {
      close();
      ok();
    });
    const close = openModal(
      t("Really delete?"),
      h(
        "div",
        {},
        h("p", {}, h("code", {}, path)),
        h("label", { class: "check" }, check, ` ${t("I know this cannot be undone.")}`),
      ),
      [h("button", { class: "ghost", onclick: () => close() }, t("Cancel")), btn],
    );
  };
}
