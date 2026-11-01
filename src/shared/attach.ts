// Reading attached files (main window input and quick bar): images go to Pi as images, text files as tagged blocks
// in the message (format.ts withFiles). Other files are refused, Pi could not read them anyway.
import { t } from "./i18n";

export const MAX_TEXT = 200_000;
export const MAX_IMAGE = 10_000_000;

export type FileAttachment =
  | { kind: "image"; name: string; mimeType: string; data: string }
  | { kind: "text"; name: string; mimeType: string; text: string };

export function toBase64(buf: ArrayBuffer): string {
  let s = "";
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

/** Text if the first bytes contain no NUL and it decodes as UTF-8 */
export function asText(buf: ArrayBuffer): string | null {
  const head = new Uint8Array(buf.slice(0, 4096));
  if (head.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buf);
  } catch {
    return null;
  }
}

/** Read a picked, dropped or pasted file; throws a translated message if it cannot be attached */
export async function readAttachment(f: File): Promise<FileAttachment> {
  const buf = await f.arrayBuffer();
  if (f.type.startsWith("image/")) {
    if (f.size > MAX_IMAGE) throw new Error(t("Image too large (max. 10 MB)"));
    return { kind: "image", name: f.name || "image.png", mimeType: f.type, data: toBase64(buf) };
  }
  if (f.size > MAX_TEXT) throw new Error(t("File too large (max. 200 KB for text)"));
  const text = asText(buf);
  if (text === null) throw new Error(t("Only text files and images can be attached"));
  return { kind: "text", name: f.name, mimeType: f.type || "text/plain", text };
}
