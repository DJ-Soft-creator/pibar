// Chat colours of the open chat's host (task I5): the host's colour profile (host.colorProfile, "" = the profile
// marked as default) for the current light/dark theme becomes CSS variables on <html>, which the chat reads with
// fallbacks: --chat-user-bg, --chat-user-fg, --chat-answer, --chat-thinking, --chat-tool (text colours, meaning as
// ChatColors in src/shared/colors.ts) plus the backgrounds --chat-answer-bg, --chat-thinking-bg, --chat-tool-bg.
// Re-applied when the chat, the theme, the hosts or the shared settings change.
import { cleanColor, type ChatColors } from "@shared/colors";
import { onSharedConfig, sharedConfig, type WebColorProfile } from "./sharedConfig";
import { state } from "./state";

/** CSS variable → where its colour comes from in a ChatColors set */
export const CHAT_VARS: [string, (c: ChatColors) => string | undefined][] = [
  ["--chat-user-bg", (c) => c.own?.background],
  ["--chat-user-fg", (c) => c.own?.text],
  ["--chat-answer", (c) => c.answer?.text],
  ["--chat-answer-bg", (c) => c.answer?.background],
  ["--chat-thinking", (c) => c.thinking?.text],
  ["--chat-thinking-bg", (c) => c.thinking?.background],
  ["--chat-tool", (c) => c.tools?.text],
  ["--chat-tool-bg", (c) => c.tools?.background],
];

/** The profile of a host: its own, otherwise the default one; undefined = the theme's colours */
export function profileForHost(profiles: WebColorProfile[], hostProfile: string | undefined): WebColorProfile | undefined {
  const id = (hostProfile ?? "").trim();
  if (id) {
    const own = profiles.find((p) => p.id === id);
    if (own) return own;
  }
  return profiles.find((p) => p.isDefault);
}

/** Variables a profile sets for one theme (empty colours are left out, the chat then keeps its own) */
export function chatVars(profile: WebColorProfile | undefined, dark: boolean): Record<string, string> {
  const set = profile ? (dark ? profile.dark : profile.light) : undefined;
  const out: Record<string, string> = {};
  if (!set) return out;
  for (const [name, pick] of CHAT_VARS) {
    const c = cleanColor(pick(set));
    if (c) out[name] = c;
  }
  return out;
}

function isDark(): boolean {
  const theme = document.documentElement.dataset.theme;
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

/** Apply the colours of the open chat's host now */
export function applyChatColors() {
  const host = state.chat ? state.hosts.find((x) => x.id === state.chat?.hostId) : undefined;
  const profiles = sharedConfig()?.colorProfiles ?? [];
  const vars = state.chat ? chatVars(profileForHost(profiles, host?.colorProfile), isDark()) : {};
  const style = document.documentElement.style;
  for (const [name] of CHAT_VARS) {
    if (vars[name]) style.setProperty(name, vars[name]);
    else style.removeProperty(name);
  }
}

let wired = false;

/** Keep the colours in step (once per page) */
export function wireChatColors() {
  if (wired) return;
  wired = true;
  window.addEventListener("hashchange", applyChatColors);
  onSharedConfig(applyChatColors);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyChatColors);
  // the theme setting changes data-theme on <html> (src/shared/theme.ts)
  new MutationObserver(applyChatColors).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  applyChatColors();
}
