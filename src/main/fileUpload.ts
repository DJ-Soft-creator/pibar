// Upload files from this computer into a folder of the session (any type, e.g. PDF), locally and over SSH.
// Dialog with a picker and drop zone; folder rows of the tree accept dropped files directly (files.ts).
import { api } from "../shared/api";
import { h, errMsg, openModal, toast } from "../shared/dom";
import { toBase64 } from "../shared/attach";
import { t } from "../shared/i18n";

/** Same limit as the Rust core (files.rs): the bytes travel base64-encoded through the UI */
export const MAX_UPLOAD = 50_000_000;

function fmtSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Files of an OS drop, without folders (the entry API tells them apart; empty files stay) */
export function droppedFiles(dt: DataTransfer): File[] {
  const items = Array.from(dt.items ?? []);
  const entries = items.map((i) => (i.kind === "file" ? i.webkitGetAsEntry?.() : null));
  if (entries.some((e) => e?.isDirectory)) toast(t("Folders cannot be uploaded, only files."), "err");
  return Array.from(dt.files).filter((_, i) => !entries[i]?.isDirectory);
}

type Item = { file: File; status: HTMLElement; row: HTMLElement };

/**
 * Pick or drop files and upload them into `folder` on the host. Existing files are kept unless the user
 * confirms overwriting them. `onDone` gets the uploaded paths (for reveal + reload of the tree).
 */
export function uploadDialog(hostId: string, folder: string, onDone: (paths: string[]) => void, initial?: File[]) {
  const items: Item[] = [];
  const list = h("div", { class: "upload-list" });
  const picker = h("input", { type: "file", multiple: true, hidden: true }) as HTMLInputElement;
  const upload = h("button", { class: "primary", disabled: true }, t("Upload")) as HTMLButtonElement;
  let busy = false;

  const add = (files: Iterable<File>) => {
    for (const file of files) {
      if (items.some((it) => it.file.name === file.name)) continue; // same name twice: one entry
      const status = h("span", { class: "upload-status" });
      const row = h(
        "div",
        { class: "upload-row" },
        h("span", { class: "upload-name", title: file.name }, file.name),
        h("span", { class: "upload-size" }, fmtSize(file.size)),
        status,
        h(
          "button",
          {
            class: "chip-x",
            title: t("Remove"),
            onclick: () => {
              if (busy) return;
              items.splice(items.indexOf(item), 1);
              row.remove();
              upload.disabled = !items.length;
            },
          },
          "×",
        ),
      );
      const item: Item = { file, status, row };
      items.push(item);
      list.append(row);
    }
    upload.disabled = busy || !items.length;
  };

  picker.addEventListener("change", () => {
    if (picker.files) add(picker.files);
    picker.value = "";
  });
  const zone = h(
    "div",
    {
      class: "upload-zone",
      onclick: () => !busy && picker.click(),
      ondragover: (e: DragEvent) => {
        if (!e.dataTransfer?.types.includes("Files")) return;
        e.preventDefault();
        zone.classList.add("drop-upload");
      },
      ondragleave: () => zone.classList.remove("drop-upload"),
      ondrop: (e: DragEvent) => {
        e.preventDefault();
        zone.classList.remove("drop-upload");
        if (!busy && e.dataTransfer) add(droppedFiles(e.dataTransfer));
      },
    },
    t("Drop files here or click to choose (any type, e.g. PDF)"),
  );

  const run = async (overwrite: boolean): Promise<{ done: string[]; conflicts: Item[]; failed: number }> => {
    const done: string[] = [];
    const conflicts: Item[] = [];
    let failed = 0;
    for (const it of overwrite ? items.filter((x) => x.status.dataset.state === "conflict") : items) {
      it.status.dataset.state = "busy";
      it.status.textContent = "…";
      it.status.title = "";
      const path = `${folder}/${it.file.name}`;
      try {
        if (it.file.size > MAX_UPLOAD) throw new Error(t("File too large (max. 50 MB)"));
        const written = await api.uploadFile(hostId, path, toBase64(await it.file.arrayBuffer()), overwrite);
        if (!written) {
          it.status.dataset.state = "conflict";
          it.status.textContent = "⚠";
          it.status.title = t("File already exists");
          conflicts.push(it);
          continue;
        }
        it.status.dataset.state = "ok";
        it.status.textContent = "✓";
        done.push(path);
      } catch (e) {
        const msg = errMsg(e);
        it.status.dataset.state = "err";
        it.status.textContent = "✕";
        it.status.title = msg;
        failed++;
      }
    }
    return { done, conflicts, failed };
  };

  const start = async () => {
    if (busy || !items.length) return;
    busy = true;
    upload.disabled = true;
    upload.textContent = t("Uploading …");
    const all: string[] = [];
    let res = await run(false);
    all.push(...res.done);
    if (res.conflicts.length) {
      const names = res.conflicts.map((it) => it.file.name).join("\n");
      if (window.confirm(`${t("These files already exist. Overwrite?")}\n\n${names}`)) {
        res = await run(true);
        all.push(...res.done);
      }
    }
    busy = false;
    upload.textContent = t("Upload");
    upload.disabled = !items.length;
    if (all.length) {
      toast(t("Files uploaded: {n}", { n: all.length }));
      onDone(all);
    }
    const left = items.filter((it) => it.status.dataset.state !== "ok");
    if (!left.length) close();
    else for (const it of items.filter((it) => it.status.dataset.state === "ok")) it.row.classList.add("done");
  };
  upload.addEventListener("click", start);

  const close = openModal(t("Upload files"), h("div", {}, h("p", { class: "hint" }, folder), zone, picker, list), [
    h("button", { class: "ghost", onclick: () => close() }, t("Close")),
    upload,
  ]);
  if (initial?.length) add(initial);
}

/**
 * Make a tree element a drop target for OS files: dropping opens the upload dialog for `folder`.
 * Internal tree drags (context paths) have no "Files" type and pass through.
 */
export function uploadDrop(
  el: HTMLElement,
  target: () => { hostId: string; folder: string } | null,
  onDone: (paths: string[]) => void,
) {
  el.addEventListener("dragover", (e) => {
    if (!e.dataTransfer?.types.includes("Files")) return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "copy";
    el.classList.add("drop-upload");
  });
  el.addEventListener("dragleave", (e) => {
    if (!el.contains(e.relatedTarget as Node)) el.classList.remove("drop-upload");
  });
  el.addEventListener("drop", (e) => {
    if (!e.dataTransfer?.files.length) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove("drop-upload");
    const tgt = target();
    if (tgt) uploadDialog(tgt.hostId, tgt.folder, onDone, droppedFiles(e.dataTransfer));
  });
}
