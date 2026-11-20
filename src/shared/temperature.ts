// Sampling temperature of a session (Pi extension pibar-temperature, installed by PiBar via temp_install):
// the slider steps, its labels and short explanations, the /temperature command and the extension's status line.
// Pure logic, tested in temperature.test.ts.

import type { Msg } from "./i18n";

/** Slider range: 0 = very focused, 1 = very free; the extension itself accepts up to 2 via /temperature */
export const TEMP_MIN = 0;
export const TEMP_MAX = 1;
export const TEMP_STEP = 0.1;
/** Slider position while the session uses the model's default (a common middle value, not a fixed choice) */
export const TEMP_NEUTRAL = 0.7;

/** Round to the slider grid and clamp into [TEMP_MIN, TEMP_MAX]; nonsense falls back to the neutral position */
export function clampTemp(v: number): number {
  if (!Number.isFinite(v)) return TEMP_NEUTRAL;
  const stepped = Math.round(Math.round(v / TEMP_STEP) * TEMP_STEP * 10) / 10;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, stepped));
}

/** Is this a temperature the extension accepts (0–2)? For values from the settings file and the status line */
export function isTemp(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 2;
}

/** "0.7", "1.0", "0.75" – one decimal on the slider grid, two for values typed in Pi's terminal */
export function formatTemp(v: number): string {
  const r = Math.round(v * 100) / 100;
  return Number.isInteger(r * 10) ? r.toFixed(1) : String(r);
}

/** Short explanation of a value: what changes in Pi's answers (tooltip and the line under the slider) */
export function tempHint(v: number): Msg {
  if (v <= 0.2) return "Very focused: precise, factual and close to the rules";
  if (v <= 0.4) return "Rather precise: reliable answers with little variation";
  if (v <= 0.6) return "Balanced: a middle ground between precise and free";
  if (v <= 0.8) return "Rather free: more varied wording and ideas";
  return "Very free: creative and surprising, but less predictable";
}

/** RPC prompt that sets the temperature (null = back to the model's default) */
export function temperatureCommand(v: number | null): string {
  return v === null ? "/temperature off" : `/temperature ${formatTemp(v)}`;
}

/**
 * Read the status line of the extension ("🌡 0.7" or "🌡 default"): the value, null = the model's default,
 * undefined = not a status of this extension.
 */
export function parseTemperatureStatus(text: string | undefined | null): number | null | undefined {
  const m = (text ?? "").match(/🌡\s*(.+)$/);
  if (!m) return undefined;
  const rest = m[1].trim().toLowerCase();
  if (rest === "default" || rest === "off") return null;
  const v = Number(rest.replace(",", "."));
  return isTemp(v) ? v : undefined;
}
