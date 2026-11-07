// Text size of the window: the offered steps, the current factor and its label. Every font size in the stylesheets
// scales with the factor that is put on the root element as `--fs` (see src/main/layout.ts, src/quick/index.ts).

/** Offered text sizes as a factor (1 = 100 %); ⌘+ / ⌘− and the settings move through this list */
export const FONT_SCALES = [0.8, 0.9, 1, 1.1, 1.2, 1.3, 1.45, 1.6];

/** The factor for a stored value; anything unknown (older config, a typo) counts as 100 % */
export function normalizeScale(v: unknown): number {
  const n = Number(v);
  return FONT_SCALES.includes(n) ? n : 1;
}

/** Next step from the current factor: one size bigger or smaller, never beyond the offered sizes */
export function stepScale(current: unknown, dir: 1 | -1): number {
  const i = FONT_SCALES.indexOf(normalizeScale(current));
  return FONT_SCALES[Math.min(FONT_SCALES.length - 1, Math.max(0, i + dir))];
}

/** Label for the settings dialog, e.g. "110 %" */
export function scaleLabel(v: unknown): string {
  return `${Math.round(normalizeScale(v) * 100)} %`;
}
