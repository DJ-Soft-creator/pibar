// Export of a session (task H5, like src/main/sessionExport.ts): Markdown to read and share, lossless JSON or CSV for
// machine evaluation (src/shared/sessionExport.ts). The whole file comes from the host (read_session_file); the
// result goes to the phone's share sheet when the browser can share files (one more tap: Safari wants a fresh
// gesture after the wait), otherwise it is downloaded.
import { api } from "@shared/api";
import { errMsg, h, openModal, toast } from "@shared/dom";
import { t } from "@shared/i18n";
import { parseSessionJsonl, sessionExportCsv, sessionExportJson } from "@shared/sessionExport";
import { button } from "../ui";
import { sessionMarkdown } from "./sessionsMarkdown";

type Format = "md" | "json" | "csv";

const MIME: Record<Format, string> = {
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
};

/** Proposed file name: the session file's base name with the export extension */
export function exportName(path: string, format: Format): string {
  const base = path.split("/").pop() || "session";
  return `${base.replace(/\.jsonl$/i, "")}.${format}`;
}

function download(file: File) {
  const url = URL.createObjectURL(file);
  const a = h("a", { href: url, download: file.name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

function canShare(file: File): boolean {
  try {
    return typeof navigator.share === "function" && !!navigator.canShare?.({ files: [file] });
  } catch {
    return false;
  }
}

async function build(hostId: string, path: string, title: string, format: Format): Promise<File> {
  const text = await api.readSessionFile(hostId, path);
  const entries = parseSessionJsonl(text);
  if (!entries.length) throw new Error(t("The session file is empty."));
  const body =
    format === "json"
      ? sessionExportJson(entries, path)
      : format === "csv"
        ? sessionExportCsv(entries)
        : sessionMarkdown(entries, title, {
            you: t("You"),
            pi: "Pi",
            tool: t("Tool"),
            thinking: t("Thinking"),
            session: t("Session"),
            folder: t("Folder"),
            created: t("Created"),
            exported: t("Exported"),
            compaction: t("Summary of the earlier conversation"),
            shortened: t("(shortened)"),
          });
  return new File([body], exportName(path, format), { type: `${MIME[format]};charset=utf-8` });
}

/** Format choice, then share or download */
export function exportDialog(s: { hostId: string; path: string; title: string }) {
  let format: Format = "md";
  const pick = (value: Format, label: string, desc: string) => {
    const radio = h("input", { type: "radio", name: "sl-export-format", checked: value === format });
    radio.addEventListener("change", () => {
      if (radio.checked) format = value;
    });
    return h("label", { class: "check sl-radio" }, radio, h("span", {}, h("strong", {}, label), h("small", {}, desc)));
  };
  const go = async () => {
    close();
    let file: File;
    try {
      file = await build(s.hostId, s.path, s.title, format);
    } catch (e) {
      toast(errMsg(e), "err");
      return;
    }
    if (!canShare(file)) {
      download(file);
      toast(t("Saved: {file}", { file: file.name }));
      return;
    }
    // the share sheet needs a fresh tap (Safari refuses it after the wait for the host): ask once more
    const ready = openModal(t("Export session"), h("p", {}, file.name), [
      button(t("Download"), () => {
        ready();
        download(file);
      }),
      button(
        t("Share file"),
        () => {
          ready();
          navigator.share({ files: [file], title: s.title }).catch((e: unknown) => {
            if (!(e instanceof DOMException && e.name === "AbortError")) download(file);
          });
        },
        "primary",
      ),
    ]);
  };
  const close = openModal(
    t("Export session"),
    h(
      "div",
      { class: "form" },
      h("p", { class: "hint" }, s.title),
      pick("md", "Markdown", t("to read and share: messages, answers and tool calls")),
      pick("json", "JSON", t("lossless: every entry, including tool calls, tokens and costs")),
      pick("csv", "CSV", t("one row per message: role, text, thinking, tool calls, tokens and costs")),
    ),
    [button(t("Cancel"), () => close()), button(t("Export"), () => void go(), "primary")],
  );
}
