// Export a session to this computer as JSON or CSV for machine evaluation: a dialog picks the format, the whole
// session file comes from the host (also over SSH) and a native save dialog writes it. Conversion: src/shared/sessionExport.ts.
import { api } from "../shared/api";
import { errMsg, h, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import { ExportFormat, parseSessionJsonl, sessionExportCsv, sessionExportJson } from "../shared/sessionExport";
import type { SessionRef } from "./sessionGroups";

/** Proposed file name: the session file's base name with the export extension */
export function exportName(path: string, format: ExportFormat): string {
  const base = path.split("/").pop() || "session";
  return `${base.replace(/\.jsonl$/i, "")}.${format}`;
}

/** Format choice and export of one saved session (context menu in src/main/sessionGroups.ts) */
export function exportDialog(s: SessionRef) {
  if (!s.path) return;
  let format: ExportFormat = "json";
  const pick = (value: ExportFormat, label: string, desc: string) => {
    const radio = h("input", {
      type: "radio",
      name: "export-format",
      checked: value === format,
    }) as HTMLInputElement;
    radio.addEventListener("change", () => {
      if (radio.checked) format = value;
    });
    return h("label", { class: "check" }, radio, ` ${label} – ${desc}`);
  };
  const run = async () => {
    close();
    try {
      const text = await api.readSessionFile(s.hostId, s.path);
      const entries = parseSessionJsonl(text);
      if (!entries.length) {
        toast(t("The session file is empty."), "err");
        return;
      }
      const data = format === "json" ? sessionExportJson(entries, s.path) : sessionExportCsv(entries);
      const name = exportName(s.path, format);
      if (await api.saveTextFile(name, data)) toast(t("Saved: {file}", { file: name }));
    } catch (e) {
      toast(errMsg(e), "err");
    }
  };
  const close = openModal(
    t("Export session"),
    h(
      "div",
      {},
      h("p", { class: "hint" }, t("Exports the whole session file for machine evaluation.")),
      pick("json", "JSON", t("lossless: every entry, including tool calls, tokens and costs")),
      pick("csv", "CSV", t("one row per message: role, text, thinking, tool calls, tokens and costs")),
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: () => void run() }, t("Export")),
    ],
  );
}
