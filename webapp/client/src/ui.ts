// Small UI helpers of the webapp on top of src/shared/dom.ts: page header, empty states, form rows, confirmation.
import { h, openModal } from "@shared/dom";
import { t } from "@shared/i18n";

/** Page header: optional element on the left (back), title, actions on the right */
export function header(title: string, right: HTMLElement[] = [], left?: HTMLElement): HTMLElement {
  return h("header", { class: "page-head" }, left, h("h1", {}, title), h("div", { class: "head-actions" }, ...right));
}

export function empty(text: string, ...extra: (HTMLElement | string)[]): HTMLElement {
  return h("div", { class: "empty" }, h("p", {}, text), ...extra);
}

/** A labelled form field */
export function field(label: string, input: HTMLElement, hint?: string): HTMLElement {
  return h("label", { class: "field" }, h("span", { class: "field-label" }, label), input, hint ? h("small", {}, hint) : null);
}

export function button(label: string, onclick: () => void, cls = ""): HTMLButtonElement {
  return h("button", { type: "button", class: `btn ${cls}`.trim(), onclick }, label);
}

/** Ask before something that cannot be undone; resolves true on yes */
export function confirmDialog(title: string, text: string, yes: string): Promise<boolean> {
  return new Promise((resolve) => {
    let answered = false;
    const close = openModal(
      title,
      h("p", {}, text),
      [
        button(t("Cancel"), () => close()),
        button(
          yes,
          () => {
            answered = true;
            close();
            resolve(true);
          },
          "danger",
        ),
      ],
      () => {
        if (!answered) resolve(false);
      },
    );
  });
}
