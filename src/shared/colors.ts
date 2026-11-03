// Chat colours: a profile colours the four parts of the chat (thinking, tool calls, answers, own messages) for the
// dark and the light theme. Values are plain hex colours; empty keeps the theme's own colour.
// Pure logic (no DOM), used by src/main/colors.ts and the settings editor.

/** The four parts of the chat that can be coloured */
export const ROLES = ["thinking", "tools", "answer", "own"] as const;
export type Role = (typeof ROLES)[number];

/** Colours of one part of the chat; "" = keep what the theme does */
export interface RoleColor {
  background?: string;
  text?: string;
}

export type ChatColors = Partial<Record<Role, RoleColor>>;

/** What the editor and the config hold: one chat colour set per theme */
export interface ColorProfile {
  id: string;
  name: string;
  dark?: ChatColors;
  light?: ChatColors;
}

/** CSS variables of the roles (styles.css) */
export const ROLE_VARS: Record<Role, { background: string; text: string }> = {
  thinking: { background: "--thinking-bg", text: "--thinking-fg" },
  tools: { background: "--tool-bg", text: "--tool-fg" },
  answer: { background: "--answer-bg", text: "--answer-fg" },
  own: { background: "--user-bg", text: "--user-fg" },
};

/**
 * A colour as CSS takes it: `#rgb`, `#rrggbb` or `#rrggbbaa`, with or without `#`. Anything else is dropped
 * (empty = theme colour), so a typo cannot break the whole chat styling.
 */
export function cleanColor(value: string | undefined): string {
  const v = (value ?? "").trim().replace(/^#/, "").toLowerCase();
  if (!/^[0-9a-f]{3}$/.test(v) && !/^[0-9a-f]{6}$/.test(v) && !/^[0-9a-f]{8}$/.test(v)) return "";
  return `#${v}`;
}

/** Short form of a colour for the small swatch next to its input (`#abc` → `#aabbcc`) */
export function fullHex(value: string | undefined): string {
  const c = cleanColor(value);
  if (/^#[0-9a-f]{3}$/.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`;
  return /^#[0-9a-f]{8}$/.test(c) ? c.slice(0, 7) : c;
}

/** Is any colour of this set in use? */
export function hasColors(set: ChatColors | undefined): boolean {
  return !!set && ROLES.some((r) => !!(set[r]?.background || set[r]?.text));
}

/**
 * CSS variables a profile sets for one theme. Roles without colours and an empty profile set nothing, so the
 * theme keeps its own values; a background for answers also brings the padding that makes it look like a bubble.
 */
export function colorVars(profile: ColorProfile | undefined, dark: boolean): Record<string, string> {
  const set = profile ? (dark ? profile.dark : profile.light) : undefined;
  const vars: Record<string, string> = {};
  if (!set) return vars;
  for (const role of ROLES) {
    const c = set[role];
    const bg = cleanColor(c?.background);
    const fg = cleanColor(c?.text);
    if (bg) vars[ROLE_VARS[role].background] = bg;
    if (fg) vars[ROLE_VARS[role].text] = fg;
    if (role === "answer" && bg) {
      vars["--answer-pad"] = "6px 12px";
      vars["--answer-radius"] = "10px";
    }
  }
  return vars;
}

/** All variables a profile can set, so old ones can be cleared before another profile is applied */
export const ALL_VARS = [
  ...new Set([
    ...ROLES.flatMap((r) => [ROLE_VARS[r].background, ROLE_VARS[r].text]),
    "--answer-pad",
    "--answer-radius",
  ]),
];

/** Drop empty rows and unknown ids; keeps the settings file small */
export function cleanProfiles(list: ColorProfile[] | undefined): ColorProfile[] {
  return (list ?? [])
    .filter((p) => p.id)
    .map((p) => ({
      id: p.id,
      name: p.name.trim() || p.id,
      dark: cleanSet(p.dark),
      light: cleanSet(p.light),
    }));
}

function cleanSet(set: ChatColors | undefined): ChatColors {
  const out: ChatColors = {};
  if (!set) return out;
  for (const role of ROLES) {
    const bg = cleanColor(set[role]?.background);
    const fg = cleanColor(set[role]?.text);
    if (bg || fg) out[role] = { background: bg, text: fg };
  }
  return out;
}

/** Profile to use for a host: its own, otherwise the default one; undefined = theme colours */
export function profileFor(
  profiles: ColorProfile[] | undefined,
  hostProfile: string | undefined,
  fallback: string | undefined,
): ColorProfile | undefined {
  const list = profiles ?? [];
  const id = (hostProfile ?? "").trim() || (fallback ?? "").trim();
  return id ? list.find((p) => p.id === id) : undefined;
}
