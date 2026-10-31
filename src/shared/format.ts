// Pure formatting helpers without DOM or Tauri – usable everywhere and easy to test.
import { getLang, t } from "./i18n";

/** Pi thinking levels in display order */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export function thinkingLabel(level: string): string {
  switch (level) {
    case "off":
      return t("off");
    case "minimal":
      return t("minimal");
    case "low":
      return t("low");
    case "medium":
      return t("medium");
    case "high":
      return t("high");
    case "xhigh":
      return t("very high");
    case "max":
      return t("max");
    default:
      return level;
  }
}

/** Marker around screen text (OCR) appended to a message; shown as a card in the chat */
const SCREEN_TAG = "screen-text";
/** Older sessions used a German tag name; still recognised */
const SCREEN_RE = /<(screen-text|bildschirmtext)[^>]*>([\s\S]*?)<\/\1>/;

/** Session title without appended screen text */
export function cleanTitle(title: string): string {
  return (title || "").replace(/<(screen-text|bildschirmtext)[\s\S]*/i, "").trim() || title;
}

/** Append OCR text to a message as a tagged block */
export function withScreenText(text: string, ocr: string | null): string {
  if (!ocr) return text;
  return `${text}\n\n<${SCREEN_TAG} source="screenshot, recognised by OCR">\n${ocr}\n</${SCREEN_TAG}>`;
}

/** Counterpart of withScreenText: separate message and OCR text */
export function splitScreenText(text: string): { text: string; ocr: string | null } {
  const m = text.match(SCREEN_RE);
  if (!m) return { text, ocr: null };
  return { text: text.replace(m[0], "").trim(), ocr: m[2].trim() };
}

/** Short display name of a model id, e.g. "anthropic.claude-sonnet-4-5-20250929-v1:0" → "claude-sonnet-4-5" */
export function shortModel(id: string): string {
  return id
    .replace(/^(us|eu|apac|global)\./, "")
    .replace(/^[a-z0-9-]+\.(?=[a-z])/, "")
    .replace(/-\d{8}(-v\d+(:\d+)?)?$/, "")
    .replace(/-v\d+(:\d+)?$/, "")
    .replace(/:\d+$/, "");
}

/** Show the home directory as ~ */
export function shortPath(p: string): string {
  return p.replace(/^\/(Users|home)\/[^/]+/, "~").replace(/^\/root(?=\/|$)/, "~");
}

/** Last path segment */
export function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}

/** Relative time ("5 min ago"); `now` only for tests */
export function relTime(iso: string | number, now = Date.now()): string {
  const ts = typeof iso === "number" ? iso : Date.parse(iso);
  if (!ts) return "";
  const s = (now - ts) / 1000;
  if (s < 60) return t("just now");
  if (s < 3600) return t("{n} min ago", { n: Math.floor(s / 60) });
  if (s < 86400) return t("{n} h ago", { n: Math.floor(s / 3600) });
  if (s < 86400 * 7) return t("{n} d ago", { n: Math.floor(s / 86400) });
  return new Date(ts).toLocaleDateString(getLang());
}

/** Date and time in the UI language, e.g. for reminders */
export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(getLang(), {
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function fmtTokens(n: number): string {
  return n >= 1000 ? t("{n}k tok.", { n: (n / 1000).toFixed(1) }) : t("{n} tok.", { n });
}
