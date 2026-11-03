// Puts the chat colours of a profile onto <html> as CSS variables, so styles.css can use the theme's own colours as
// fallbacks. Which profile: the one of the active session's host, otherwise the default from the settings.
// src/shared/colors.ts holds the logic (which variables, which values).
import { ALL_VARS, colorVars, profileFor } from "../shared/colors";
import { state } from "./state";

/** Dark or light right now? With the theme on "auto" the system decides. */
export function isDark(): boolean {
  const forced = document.documentElement.dataset.theme;
  if (forced === "dark") return true;
  if (forced === "light") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}

/** Apply the colour profile of a host (default: the active session's host); without one the theme colours stay */
export function applyChatColors(hostId?: string) {
  const cfg = state.config;
  const root = document.documentElement.style;
  for (const name of ALL_VARS) root.removeProperty(name);
  if (!cfg?.hosts) return;
  const host =
    (hostId ?? state.active?.hostId) ? cfg.hosts.find((h) => h.id === (hostId ?? state.active?.hostId)) : undefined;
  const profile = profileFor(cfg.colorProfiles, host?.colorProfile, cfg.ui?.colorProfile);
  for (const [name, value] of Object.entries(colorVars(profile, isDark()))) root.setProperty(name, value);
}

/** The system switched between dark and light while the theme is "auto": the colours follow */
export function wireChatColors() {
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", () => applyChatColors());
}
