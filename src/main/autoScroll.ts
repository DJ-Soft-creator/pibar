// Auto scroll of the chat, three modes (round button at the bottom right, Settings → Chat):
// - "auto":   follow every change of the chat (text, tool cards, results, images); scrolling up pauses it,
//             scrolling back to the end follows again
// - "always": forced – every change jumps to the end, even after scrolling up
// - "off":    never scroll by itself (the button still jumps to the end)
import { $, h } from "../shared/dom";
import { icon } from "../shared/icons";
import { t, type Msg } from "../shared/i18n";
import { openMenu } from "./menu";
import { saveConfig, state } from "./state";

export type ScrollMode = "auto" | "always" | "off";

/** Following right now (in "auto": until the user scrolls up) */
let follow = true;
/** Time of the last scroll input by the user (wheel, keys, scrollbar), to tell it apart from own scrolling */
let userAt = 0;
let raf = 0;
let scroller: HTMLElement;
let button: HTMLButtonElement;

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

const TITLES: Record<ScrollMode, Msg> = {
  auto: "Auto scroll: automatic – follows the answer, pauses when you scroll up",
  always: "Auto scroll: always – jumps to the end on every change",
  off: "Auto scroll: off",
};

function render() {
  const mode = scrollMode();
  button.className = `autoscroll mode-${mode} ${following() ? "on" : ""}`;
  button.hidden = !state.active;
  button.title = `${t(TITLES[mode])}${mode === "auto" && !follow ? ` (${t("paused")})` : ""}\n${t("Click: choose mode")}`;
}

function toEnd() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (following()) scroller.scrollTop = scroller.scrollHeight;
    render();
  });
}

/** Jump to the end now (and follow again in "auto") */
export function jumpToEnd() {
  follow = true;
  scroller.scrollTop = scroller.scrollHeight;
  render();
}

export function setScrollMode(mode: ScrollMode) {
  state.config.ui.autoScroll = mode;
  saveConfig();
  follow = mode !== "off";
  if (following()) toEnd();
  render();
}

/** A new answer starts: in "auto" follow it again */
export function answerStarted() {
  follow = scrollMode() !== "off";
  if (following()) toEnd();
  render();
}

/** Session shown (or switched): show its end */
export function showEnd() {
  jumpToEnd();
}

function modeMenu() {
  const mode = scrollMode();
  const item = (m: ScrollMode, label: Msg, desc: Msg) => ({
    label: t(label),
    desc: t(desc),
    selected: mode === m,
    onSelect: () => setScrollMode(m),
  });
  openMenu(
    button,
    [
      { heading: t("Auto scroll") },
      item("auto", "Automatic", "Follows the answer, pauses when you scroll up"),
      item("always", "Always", "Forced: every change jumps to the end"),
      item("off", "Off", "Never scrolls by itself"),
      { separator: true },
      { label: t("Jump to the end"), onSelect: jumpToEnd },
    ],
    "right",
  );
}

export function wireAutoScroll() {
  scroller = $("chat-scroll");
  button = h("button", {
    type: "button",
    id: "btn-autoscroll",
    class: "autoscroll",
    hidden: true,
  }) as HTMLButtonElement;
  button.append(icon("down", 15));
  button.addEventListener("click", modeMenu);
  scroller.parentElement!.append(button);

  // every change in the chat: stay at the end while following
  new MutationObserver(() => (following() ? toEnd() : render())).observe(scroller, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // images and other content that get their size later
  scroller.addEventListener("load", () => following() && toEnd(), true);

  const userInput = () => (userAt = performance.now());
  scroller.addEventListener("wheel", (e) => {
    userInput();
    if (e.deltaY < 0 && scrollMode() === "auto" && follow) {
      follow = false; // scrolling up: pause at once
      render();
    }
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
    render();
  });
}

/** State changed (session shown, streaming started or ended): update the button */
export function renderAutoScroll() {
  if (button) render();
}
