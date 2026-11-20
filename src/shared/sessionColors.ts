// Session colours: the eight colour names (CSS: --c-<name> in styles.css) and the user's own short descriptions
// (Settings → Session colours, src/main/sessionColorSettings.ts). A description replaces the colour name in tooltips,
// the colour menu legend and the list filter; empty keeps the built-in name. Pure logic, no DOM.
import { t, type Msg } from "./i18n";

/** Colour names for sessions and groups; CSS: --c-<name> in styles.css */
export const COLORS = ["red", "orange", "yellow", "green", "teal", "blue", "purple", "pink"] as const;

/** Built-in names as keys of the translation layer */
export const COLOR_NAMES: Record<string, Msg> = {
  "": "No colour",
  red: "Red",
  orange: "Orange",
  yellow: "Yellow",
  green: "Green",
  teal: "Teal",
  blue: "Blue",
  purple: "Purple",
  pink: "Pink",
};

/** Longest description kept (the editor recommends 1–3 words) */
export const LABEL_MAX = 40;

/** One description as stored: trimmed, single spaces, at most LABEL_MAX characters; "" = use the colour name */
export function cleanColorLabel(value: string | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_MAX);
}

/** Only known colours with a description; empty entries drop out so the config stays small */
export function cleanColorLabels(labels: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of COLORS) {
    const v = cleanColorLabel(labels?.[c]);
    if (v) out[c] = v;
  }
  return out;
}

/** Name shown for a colour: the user's description, otherwise the built-in name */
export function colorLabel(color: string, labels?: Record<string, string>): string {
  return cleanColorLabel(labels?.[color]) || t(COLOR_NAMES[color] ?? "No colour");
}

/** Tooltip of a swatch: "Urgent (Red)" with a description, otherwise just the name */
export function colorTitle(color: string, labels?: Record<string, string>): string {
  const own = cleanColorLabel(labels?.[color]);
  const name = t(COLOR_NAMES[color] ?? "No colour");
  return own ? `${own} (${name})` : name;
}

/** Legend rows for the colour menu: only colours with a description, in the order of the swatches */
export function colorLegend(labels?: Record<string, string>): { color: string; label: string }[] {
  return COLORS.filter((c) => cleanColorLabel(labels?.[c])).map((c) => ({ color: c, label: colorLabel(c, labels) }));
}
