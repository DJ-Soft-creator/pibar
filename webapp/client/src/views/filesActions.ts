// Create and upload in the files tab (task G4): new file (no extension → Markdown, like the desktop) and new folder
// in a folder of the tree, and uploads from the phone (camera, photos, Files app) through upload_file (base64;
// existing files are asked about once, then overwritten). Downloads and deletes live in filesShared.ts.
import { api } from "@shared/api";
import { errMsg, h, openModal, toast } from "@shared/dom";
import { baseName, shortPath } from "@shared/format";
import { t } from "@shared/i18n";
import { button, confirmDialog, field } from "../ui";
import { joinPath } from "./filesShared";

/** Ask for a name, then run `create` with the full path; the dialog stays open on errors */
function nameDialog(title: string, base: string, placeholder: string, create: (path: string) => Promise<void>) {
  const input = h("input", { type: "text", placeholder, autocapitalize: "off", autocomplete: "off", spellcheck: "false" });
  const error = h("p", { class: "error small", hidden: true });
  const go = async () => {
    const name = input.value.trim().replace(/^\/+|\/+$/g, "");
    if (!name) return;
    if (name.split("/").some((s) => s === ".." || s === ".")) {
      error.textContent = t("Name not allowed");
      error.hidden = false;
      return;
    }
    try {
      await create(joinPath(base, name));
      close();
    } catch (e) {
      error.textContent = errMsg(e);
      error.hidden = false;
    }
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void go();
  });
  const close = openModal(
    title,
    h("div", {}, field(t("Name"), input), h("p", { class: "hint" }, shortPath(base)), error),
    [button(t("Cancel"), () => close()), button(t("Create"), () => void go(), "primary")],
  );
}

/** New file in `base`; afterwards `done` gets its path (the tree opens it) */
export function newFileDialog(hostId: string, base: string, done: (path: string) => void) {
  nameDialog(t("New file"), base, t("note.md"), async (path) => {
    const full = /\.[a-z0-9]+$/i.test(baseName(path)) ? path : `${path}.md`;
    try {
      await api.createFile(hostId, full);
    } catch (e) {
      throw new Error(`${t("Could not create file (does it exist already?)")} ${errMsg(e)}`);
    }
    done(full);
  });
}

export function newFolderDialog(hostId: string, base: string, done: (path: string) => void) {
  nameDialog(t("New folder"), base, t("new-folder"), async (path) => {
    await api.createDir(hostId, path);
    done(path);
  });
}

/** File content as base64 (without the data: prefix) */
function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const s = String(r.result);
      resolve(s.slice(s.indexOf(",") + 1));
    };
    r.onerror = () => reject(r.error ?? new Error("read failed"));
    r.readAsDataURL(file);
  });
}

/** Status of a running upload, shown by the tree */
export interface UploadProgress {
  done: number;
  total: number;
}

/**
 * Open the phone's file chooser (must run inside the tap) and upload the chosen files into `folder`.
 * `progress` follows the upload (null = finished), `done` gets the uploaded paths.
 */
export function pickAndUpload(
  hostId: string,
  folder: string,
  progress: (p: UploadProgress | null) => void,
  done: (paths: string[]) => void,
) {
  const input = h("input", { type: "file", multiple: true, hidden: true });
  input.addEventListener("change", () => {
    const files = [...(input.files ?? [])];
    input.remove();
    if (files.length) void upload(hostId, folder, files, progress, done);
  });
  document.body.append(input);
  input.click();
}

async function upload(
  hostId: string,
  folder: string,
  files: File[],
  progress: (p: UploadProgress | null) => void,
  done: (paths: string[]) => void,
) {
  const uploaded: string[] = [];
  const existing: { file: File; path: string; data: string }[] = [];
  let failed = 0;
  progress({ done: 0, total: files.length });
  for (const [i, file] of files.entries()) {
    const path = joinPath(folder, file.name);
    try {
      const data = await readBase64(file);
      if (await api.uploadFile(hostId, path, data, false)) uploaded.push(path);
      else existing.push({ file, path, data });
    } catch (e) {
      failed++;
      toast(`${file.name}: ${errMsg(e)}`, "err", 8000);
    }
    progress({ done: i + 1, total: files.length });
  }
  progress(null);
  if (existing.length) {
    const names = existing.map((x) => x.file.name).join(", ");
    if (await confirmDialog(t("These files already exist. Overwrite?"), names, t("Overwrite"))) {
      for (const x of existing) {
        try {
          await api.uploadFile(hostId, x.path, x.data, true);
          uploaded.push(x.path);
        } catch (e) {
          failed++;
          toast(`${x.file.name}: ${errMsg(e)}`, "err", 8000);
        }
      }
    }
  }
  if (uploaded.length) toast(t("Files uploaded: {n}", { n: uploaded.length }));
  if (uploaded.length || failed) done(uploaded);
}
