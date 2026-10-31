// Colour scheme for both windows: "auto" follows the system, "light"/"dark" force it.
// CSS reads the data-theme attribute on <html> (see styles.css, quick.css).
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Theme } from "./api";

export const THEMES: Theme[] = ["auto", "light", "dark"];

export function applyTheme(theme: Theme | undefined) {
  const t = theme && THEMES.includes(theme) ? theme : "auto";
  if (t === "auto") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  // native window parts (title bar, scroll bars, dropdowns) follow as well
  getCurrentWindow()
    .setTheme(t === "auto" ? null : t)
    .catch(() => {});
}

/** Next theme for the toggle button: auto → light → dark → auto */
export function nextTheme(theme: Theme | undefined): Theme {
  const i = THEMES.indexOf(theme ?? "auto");
  return THEMES[(i + 1) % THEMES.length];
}
