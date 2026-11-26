// Keyboard shortcuts for tablets with a keyboard (task J4) – the part of src/main/shortcuts.ts that fits the webapp:
// tabs, search, new session and the overview. Sending and stopping are handled by the chat at its input.
import "./shortcuts.css";
import { h, openModal } from "@shared/dom";
import { t, type Msg } from "@shared/i18n";
import { currentHost, currentRoute, go, state, type Route } from "./state";
import { button } from "./ui";
import { startNewSession } from "./views/newSession";

const TABS: Route[] = ["sessions", "chat", "files", "more"];

/** Shortcuts for the overview, in display order */
const LIST: [string, Msg][] = [
  ["⌘ 1 … 4", "Sessions, Chat, Files, More"],
  ["⌘ [ · ⌘ ]", "Previous / next tab"],
  ["⌘ K · ⌘ F", "Search sessions"],
  ["⌘ N · ⌥ ⌘ N", "New session"],
  ["⌘ /", "This overview"],
];

export function shortcutsDialog() {
  const close = openModal(
    t("Keyboard shortcuts"),
    h(
      "table",
      { class: "keys" },
      ...LIST.map(([k, d]) => h("tr", {}, h("td", {}, h("kbd", {}, k)), h("td", {}, t(d)))),
    ),
    [button(t("Close"), () => close(), "primary")],
  );
}

/**
 * Go to the session list and put the cursor into its search field. The list renders again when its sessions have
 * loaded, so for a moment the focus is put back into the new field as long as nothing else took it.
 */
function focusSearch() {
  go("sessions");
  const until = Date.now() + 2000;
  const find = () => {
    const input = document.querySelector<HTMLInputElement>('.page input[type="search"]');
    const active = document.activeElement;
    if (input && active !== input && (!active || active === document.body)) {
      input.focus();
      input.select();
    }
    if (Date.now() < until && (!active || active === document.body || active === input || !input)) window.setTimeout(find, 50);
  };
  window.setTimeout(find, 0);
}

function newSession() {
  const host = (state.chat && state.hosts.find((x) => x.id === state.chat?.hostId)) || currentHost();
  if (host) startNewSession({ hostId: host.id, hostName: host.name });
}

function stepTab(delta: number) {
  const route = currentRoute();
  const cur = TABS.indexOf(route.startsWith("admin/") ? "more" : route);
  go(TABS[(cur + delta + TABS.length) % TABS.length] ?? "sessions");
}

/** What a key press does; null = not ours (exported for the tests of the key table) */
export function shortcutFor(e: Pick<KeyboardEvent, "key" | "code" | "metaKey" | "ctrlKey" | "altKey" | "shiftKey">): (() => void) | null {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey) return null;
  const digit = /^Digit([1-4])$/.exec(e.code);
  if (digit && !e.altKey) return () => go(TABS[Number(digit[1]) - 1] ?? "sessions");
  if (e.code === "KeyN") return newSession;
  if (e.altKey) return null;
  const key = e.key.toLowerCase();
  if (key === "k" || key === "f") return focusSearch;
  // the character decides, not the key position (German layout: "[" and "]" are ⌥5/⌥6 or ⌥8/⌥9)
  if (e.key === "[") return () => stepTab(-1);
  if (e.key === "]") return () => stepTab(1);
  if (key === "/" || e.code === "Slash") return shortcutsDialog;
  return null;
}

let wired = false;

export function wireShortcuts() {
  if (wired) return;
  wired = true;
  document.addEventListener("keydown", (e) => {
    if (!state.me || e.defaultPrevented) return;
    // dialogs handle their own keys
    if (document.querySelector("#modal-root .modal-backdrop")) return;
    const run = shortcutFor(e);
    if (!run) return;
    e.preventDefault();
    run();
  });
}
