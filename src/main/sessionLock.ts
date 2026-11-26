// Desktop side of the session lock (task D1): when the webapp (or another PiBar) already runs Pi for a session, the
// desktop asks "read only" or "take over" instead of starting a second Pi process on the same file. The lock itself
// lives on the host (src-tauri/src/lock.rs); recognising the error and the read-only history: src/shared/sessionLock.ts.
import { h, openModal } from "../shared/dom";
import { relTime } from "../shared/format";
import { t } from "../shared/i18n";
import { sessionLockText, type SessionLock } from "../shared/sessionLock";

/** Ask what to do with a session another Pi holds; closing the dialog means read only */
export function askSessionLock(lock: SessionLock): Promise<"read" | "takeover"> {
  return new Promise((resolve) => {
    let choice: "read" | "takeover" = "read";
    const since = lock.since ? ` ${t("Open since {when}.", { when: relTime(lock.since) })}` : "";
    const close = openModal(
      t("Session is already open"),
      h(
        "div",
        {},
        h("p", {}, `${sessionLockText(lock)}${since}`),
        h(
          "p",
          { class: "hint" },
          t("Read only shows the history without starting Pi. Take over stops Pi there and continues here."),
        ),
      ),
      [
        h("button", { class: "ghost", onclick: () => close() }, t("Read only")),
        h(
          "button",
          {
            class: "primary",
            onclick: () => {
              choice = "takeover";
              close();
            },
          },
          t("Take over"),
        ),
      ],
      () => resolve(choice),
    );
  });
}

/** Banner at the end of a read-only session with the "Take over" button */
export function readOnlyBanner(lock: SessionLock, takeOver: () => void): HTMLElement {
  return h(
    "div",
    { class: "msg note readonly-lock" },
    h(
      "div",
      { class: "error" },
      `${sessionLockText(lock)} ${t("Read only – Pi is not started here.")}`,
      h("div", {}, h("button", { class: "ghost", onclick: takeOver }, t("Take over"))),
    ),
  );
}
