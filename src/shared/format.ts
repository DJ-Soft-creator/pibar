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

/** Session title without appended screen text or answer style hint */
export function cleanTitle(title: string): string {
  return (
    (title || "")
      .replace(/<(screen-text|bildschirmtext|response-style|file)[\s\S]*/i, "")
      // titles are cut after ~120 characters: drop a half tag at the end
      .replace(/\s*<[a-z-]*$/i, "")
      .trim() || title
  );
}

/** Attached text files as tagged blocks at the end of a message (shown as cards in the chat) */
export function withFiles(text: string, files: { name: string; text: string }[]): string {
  if (!files.length) return text;
  const blocks = files.map((f) => `<file name="${f.name.replace(/"/g, "'")}">\n${f.text}\n</file>`);
  return [text, ...blocks].filter(Boolean).join("\n\n");
}

/** Counterpart of withFiles: message text and the attached files */
export function splitFiles(text: string): { text: string; files: { name: string; text: string }[] } {
  const files: { name: string; text: string }[] = [];
  const rest = text.replace(/<file name="([^"]*)">\n?([\s\S]*?)\n?<\/file>/g, (_m, name: string, body: string) => {
    files.push({ name, text: body });
    return "";
  });
  return { text: files.length ? rest.trim() : text, files };
}

/** Answer style hints (src/main/sessionTab.ts appends them to each message) */
const ANSWER_HINTS: Record<string, string> = {
  short: "Answer briefly and to the point, without long explanations.",
  technical:
    "Answer as briefly as possible, but keep the technical details (commands, paths, values, code). No filler text.",
};
const STYLE_RE = /\s*<response-style>[\s\S]*?<\/response-style>\s*/;

/** Append the answer style hint; "normal" and slash commands (/skill:…) stay unchanged */
export function withAnswerStyle(text: string, mode: string | undefined): string {
  const hint = mode ? ANSWER_HINTS[mode] : undefined;
  if (!hint || text.trimStart().startsWith("/")) return text;
  return `${text}\n\n<response-style>${hint}</response-style>`;
}

/** Counterpart of withAnswerStyle: the message without the hint */
export function stripAnswerStyle(text: string): string {
  return text.replace(STYLE_RE, "\n").trim();
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

/** Tokens per second, rounded; null without a measurable duration */
export function tokensPerSecond(tokens: number, ms: number): number | null {
  if (!tokens || ms < 50) return null;
  return Math.round((tokens / ms) * 1000 * 10) / 10;
}
