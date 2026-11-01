// Auto scroll of the chat: while it is on, every change of the chat (text, tool cards, results, images) keeps the
// view at the end. Scrolling up turns it off, scrolling back to the end turns it on again; the round button at the
// bottom right switches it by hand. Settings → Chat: start each answer with auto scroll off (fast models).
import { $, h } from "../shared/dom";
import { icon } from "../shared/icons";
import { t } from "../shared/i18n";
import { state } from "./state";

let follow = true;
/** Time of the last scroll input by the user (wheel, keys, scrollbar), to tell it apart from own scrolling */
let userAt = 0;
let raf = 0;
let scroller: HTMLElement;
let button: HTMLButtonElement;

/** Distance of the view from the end of the chat in pixels */
function gap(): number {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight;
}

function render() {
  const away = gap() > 24;
  button.classList.toggle("on", follow);
  button.hidden = !(state.active?.streaming || away);
  button.title = follow
    ? t("Auto scroll on – click to stop (or scroll up)")
    : t("Auto scroll off – click to follow the answer again");
}

function toEnd() {
  if (raf) return;
  raf = requestAnimationFrame(() => {
    raf = 0;
    if (follow) scroller.scrollTop = scroller.scrollHeight;
    render();
  });
}

export function setFollow(on: boolean) {
  follow = on;
  if (on) toEnd();
  render();
}

/** A new answer starts: follow it, unless the setting says to start without */
export function answerStarted() {
  setFollow(state.config.ui.autoScroll !== "off");
}

/** Session shown (or switched): jump to the end and follow */
export function showEnd() {
  follow = true;
  scroller.scrollTop = scroller.scrollHeight;
  render();
}

export function wireAutoScroll() {
  scroller = $("chat-scroll");
  button = h("button", {
    type: "button",
    id: "btn-autoscroll",
    class: "autoscroll on",
    hidden: true,
  }) as HTMLButtonElement;
  button.append(icon("down", 15));
  button.addEventListener("click", () => setFollow(!follow));
  scroller.parentElement!.append(button);

  // every change in the chat: stay at the end while following
  new MutationObserver(() => (follow ? toEnd() : render())).observe(scroller, {
    childList: true,
    subtree: true,
    characterData: true,
  });
  // images and other content that get their size later
  scroller.addEventListener("load", () => follow && toEnd(), true);

  const userInput = () => (userAt = performance.now());
  scroller.addEventListener("wheel", (e) => {
    userInput();
    if (e.deltaY < 0 && follow) setFollow(false); // scrolling up: stop following at once
  });
  scroller.addEventListener("pointerdown", userInput); // scrollbar
  scroller.addEventListener("pointermove", (e) => e.buttons && userInput()); // dragging the scrollbar
  scroller.addEventListener("touchmove", userInput);
  document.addEventListener("keydown", (e) => {
    if (["PageUp", "PageDown", "Home", "End", "ArrowUp", "ArrowDown", " "].includes(e.key)) userInput();
  });
  scroller.addEventListener("scroll", () => {
    if (performance.now() - userAt < 400) {
      // the user scrolled: up → stop following, back at the end → follow again
      if (gap() > 40) follow = false;
      else if (gap() < 4) follow = true;
    }
    render();
  });
}

/** State changed (streaming started or ended): show or hide the button */
export function renderAutoScroll() {
  if (button) render();
}
