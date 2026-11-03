// Auto scroll of the chat, three modes (View menu in the header, Settings → Chat):
// - "auto":   follow every change of the chat (text, tool cards, results, images); scrolling up pauses it,
//             scrolling back to the end follows again
// - "always": forced – every change jumps to the end, even after scrolling up
// - "off":    never scroll by itself (⌘J still jumps to the end)
import { $ } from "../shared/dom";
import { t, type Msg } from "../shared/i18n";
import type { MenuEntry } from "./menu";
import { saveConfig, state } from "./state";

export type ScrollMode = "auto" | "always" | "off";

/** Following right now (in "auto": until the user scrolls up) */
let follow = true;
/** Time of the last scroll input by the user (wheel, keys, scrollbar), to tell it apart from own scrolling */
let userAt = 0;
let raf = 0;
let scroller: HTMLElement;

/** Mode from the settings; older configs stored "on" (= auto) */
export function scrollMode(): ScrollMode {
  const v = state.config.ui.autoScroll;
  return v === "always" || v === "off" ? v : "auto";
}

/** Distance of the view from the end of the chat in pixels */
function gap(): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

const following = () => scrollMode() === "always" || (scrollMode() === "auto" && follow);

function toEnd() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (following()) scroller.scrollTop = scroller.scrollHeight;
  });
}

/**
 * Change the input's height without moving the chat. A transiently taller or shorter input changes the height of the
 * chat area, and the browser then clamps the scroll: one small step per keystroke, even when the height ends the same.
 */
export function keepScroll(fn: () => void) {
  if (!scroller) return fn();
  const top = scroller.scrollTop;
  const follow = following();
  fn();
  scroller.scrollTop = follow ? scroller.scrollHeight : top;
}

/** Jump to the end now (and follow again in "auto") */
export function jumpToEnd() {
  follow = true;
  scroller.scrollTop = scroller.scrollHeight;
}

export function setScrollMode(mode: ScrollMode) {
  state.config.ui.autoScroll = mode;
  saveConfig();
  follow = mode !== "off";
  if (following()) toEnd();
}

/** A new answer starts: in "auto" follow it again */
export function answerStarted() {
  follow = scrollMode() !== "off";
  if (following()) toEnd();
}

/** Session shown (or switched): show its end */
export function showEnd() {
  jumpToEnd();
}

/** Menu entries for the modes (View menu in the header) */
export function scrollModeItems(): MenuEntry[] {
  const mode = scrollMode();
  const item = (m: ScrollMode, label: Msg, desc: Msg) => ({
    label: t(label),
    desc: t(desc),
    selected: mode === m,
    onSelect: () => setScrollMode(m),
  });
  return [
    { heading: t("Auto scroll") },
    item("auto", "Automatic", "Follows the answer, pauses when you scroll up"),
    item("always", "Always", "Forced: every change jumps to the end"),
    item("off", "Off", "Never scrolls by itself"),
  ];
}

export function wireAutoScroll() {
  scroller = $("chat-scroll");

  // every change in the chat: stay at the end while following
  new MutationObserver(() => following() && toEnd()).observe(scroller, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // images and other content that get their size later
  scroller.addEventListener("load", () => following() && toEnd(), true);

  const userInput = () => (userAt = performance.now());
  scroller.addEventListener("wheel", (e) => {
    userInput();
    if (e.deltaY < 0 && scrollMode() === "auto") follow = false; // scrolling up: pause at once
  });
  scroller.addEventListener("pointerdown", userInput); // scrollbar
  scroller.addEventListener("pointermove", (e) => e.buttons && userInput()); // dragging the scrollbar
  scroller.addEventListener("touchmove", userInput);
  document.addEventListener("keydown", (e) => {
    if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) userInput();
  });
  scroller.addEventListener("scroll", () => {
    if (scrollMode() === "auto" && performance.now() - userAt < 400) {
      // the user scrolled: up → pause, back at the end → follow again
      if (gap() > 40) follow = false;
      else if (gap() < 4) follow = true;
    }
  });
}
