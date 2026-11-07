// Keyboard shortcuts of the main window, and the overview (⌘/). Sending itself (Enter, ⌥Enter, ⇧Enter) is handled at
// the input in chatView.ts; the dialogs (new session, folder picker) handle their own keys.
import { h, openModal } from "../shared/dom";
import { t, type Msg } from "../shared/i18n";
import { setFontScale, stepFontScale, togglePanel } from "./layout";
import { isEditorOpen, reloadFiles, saveEditor } from "./files";
import { activate, closeSession, defaultHostId, newSessionDialog, openSession } from "./sessions";
import { setMeta } from "./sessionGroups";
import { state } from "./state";
import { jumpToEnd } from "./autoScroll";
import { focusSearch } from "./search";
import { toggleTerminal } from "./terminal";

export interface ShortcutActions {
  input: HTMLTextAreaElement;
  fillInput: (text: string) => void;
}

/** Shortcuts for the overview, in display order */
const LIST: [string, Msg][] = [
  ["Enter", "Send – while Pi works: queue (Pi gets it when done)"],
  ["⌥ Enter", "While Pi works: in between, before Pi's next step"],
  ["⌘ Enter", "Send (also from a multi-line text)"],
  ["⇧ Enter", "New line"],
  ["⇧ ⌘ Enter", "Send in the background (runs on without PiBar)"],
  ["Right click", "Right-click on the send button: menu for the background"],
  ["Esc · ⌘ .", "Stop Pi"],
  ["⌘ ↑", "Empty input: take back your last message"],
  ["⌘ L", "Into the input"],
  ["⌘ J", "Jump to the end of the chat"],
  ["⌘ ⌥ J", "Terminal at the bottom (⌘⌥J)"],
  ["⌘ F", "Search (⌘F)"],
  ["⌘ N", "New session (dialog)"],
  ["⌘ ⇧ N", "New session right away – same host and folder"],
  ["⌘ [ · ⌘ ]", "Previous / next open session"],
  ["⌘ 1 … 9", "Open session 1 … 9"],
  ["⌘ W", "Close session"],
  ["⇧ ⌘ U", "Mark the session on screen as unread"],
  ["⌘ B · ⌘ ⌥ B", "Left / right panel"],
  ["⌘ ⇧ R", "Reload files and Git status"],
  ["⌘ S", "Save file"],
  ["⌘ + · ⌘ −", "Text size bigger / smaller"],
  ["⌘ 0", "Text size back to 100 %"],
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
    [h("button", { class: "primary", onclick: () => close() }, t("Close"))],
  );
}

/** Open sessions in the order of the list on the left (as far as visible), otherwise in opening order */
function openTabs() {
  const order = [...document.querySelectorAll<HTMLElement>("#host-list [data-key]")].map((e) => e.dataset.key);
  return [...state.tabs.values()].sort((a, b) => {
    const ia = order.indexOf(a.key);
    const ib = order.indexOf(b.key);
    return (ia < 0 ? 1e6 : ia) - (ib < 0 ? 1e6 : ib);
  });
}

/** New session with host and working folder of the active one, without the dialog */
async function newHere() {
  const tab = state.active;
  if (!tab) return newSessionDialog(defaultHostId());
  await openSession(tab.hostId, null, tab.cwd, t("New session"));
}

export function wireShortcuts(a: ShortcutActions) {
  document.addEventListener("keydown", (e) => {
    const mod = e.metaKey || e.ctrlKey;
    const inDialog = !!document.querySelector("#modal-root .modal-backdrop");
    const tab = state.active;
    if (e.key === "Escape" && tab?.streaming && document.activeElement === a.input) {
      tab.abort().catch(() => {});
      return;
    }
    if (!mod || inDialog) return;
    const key = e.key.toLowerCase();
    // the terminal gets its own keys (⌘C, ⌘L …); only its shortcut works there
    const inTerminal = !!(e.target as HTMLElement | null)?.closest?.("#term-dock");
    if (inTerminal && !(e.altKey && e.code === "KeyJ")) return;
    const run = (fn: () => unknown) => {
      e.preventDefault();
      void fn();
    };
    if (e.code === "KeyB") run(() => togglePanel(e.altKey ? "right" : "left"));
    else if (e.shiftKey && e.code === "KeyR") run(reloadFiles);
    else if (key === "s" && isEditorOpen()) run(saveEditor);
    else if (e.shiftKey && e.code === "KeyN") run(newHere);
    else if (key === "n") run(() => newSessionDialog(defaultHostId()));
    else if (key === "w" && tab) run(() => closeSession(tab));
    else if (e.shiftKey && e.code === "KeyU" && tab) run(() => setMeta(tab.key, { unread: true }));
    else if (key === "f") run(focusSearch);
    else if (key === "l") run(() => a.input.focus());
    else if (key === "j") run(e.altKey ? toggleTerminal : jumpToEnd);
    else if (key === "." && tab?.streaming) run(() => tab.abort());
    else if (key === "/" || e.code === "Slash") run(shortcutsDialog);
    else if (e.key === "ArrowUp" && document.activeElement === a.input && !a.input.value.trim() && tab) {
      const last = tab.lastUserText();
      if (last) run(() => a.fillInput(last));
    } else if (key === "+" || key === "=" || e.code === "NumpadAdd") run(() => stepFontScale(1));
    else if (key === "-" || e.code === "NumpadSubtract") run(() => stepFontScale(-1));
    else if (key === "0") run(() => setFontScale(1));
    // the character decides which session comes next, not the key position: on a German layout "+" sits on
    // the key of "]", and "[" / "]" themselves are ⌥8 and ⌥9
    else if (e.key === "[" || e.key === "]") {
      const list = openTabs();
      if (list.length < 2) return;
      const i = tab ? list.indexOf(tab) : -1;
      const next = list[(i + (e.key === "]" ? 1 : -1) + list.length) % list.length];
      run(() => activate(next));
    } else if (/^Digit[1-9]$/.test(e.code)) {
      const target = openTabs()[Number(e.code.slice(5)) - 1];
      if (target) run(() => activate(target));
    }
  });
}
