// Building blocks of the session list's sheets: an action sheet (bottom sheet with large rows instead of the desktop's
// context menus), colour swatches with the own colour descriptions, a text prompt and a choice list.
import { errMsg, h, openModal, toast } from "@shared/dom";
import { t } from "@shared/i18n";
import { COLORS, colorLabel, colorLegend, colorTitle } from "@shared/sessionColors";
import { button } from "../ui";
import { data } from "./sessionsData";

export interface SheetItem {
  label: string;
  desc?: string;
  danger?: boolean;
  /** Mark as the current choice */
  selected?: boolean;
  /** Colour dot in front of the label */
  color?: string;
  onSelect: () => void | Promise<void>;
}

/** Run an action; a failure becomes a red toast instead of an unhandled rejection */
export function run(fn: () => void | Promise<void>) {
  Promise.resolve()
    .then(fn)
    .catch((e: unknown) => toast(errMsg(e), "err"));
}

export function sheetRows(items: SheetItem[], close: () => void): HTMLElement {
  return h(
    "div",
    { class: "sl-sheet-list" },
    ...items.map((it) =>
      h(
        "button",
        {
          type: "button",
          class: `sl-sheet-item ${it.danger ? "danger" : ""} ${it.selected ? "selected" : ""}`,
          onclick: () => {
            close();
            run(it.onSelect);
          },
        },
        it.color !== undefined ? h("span", { class: `sl-dot ${it.color ? `c-${it.color}` : "none"}` }) : null,
        h("span", { class: "sl-sheet-label" }, it.label, it.desc ? h("small", {}, it.desc) : null),
        it.selected ? h("span", { class: "sl-sheet-check", "aria-hidden": "true" }, "✓") : null,
      ),
    ),
  );
}

/** Bottom sheet with a list of actions; `top` goes above the list (e.g. colour swatches) */
export function actionSheet(title: string, items: SheetItem[], top?: (close: () => void) => HTMLElement | null) {
  const body = h("div", { class: "sl-sheet" });
  const close = openModal(title, body, [button(t("Close"), () => close())], undefined, "sl-modal");
  const extra = top?.(close);
  if (extra) body.append(extra);
  body.append(sheetRows(items, close));
}

/** Eight swatches plus "none"; the own descriptions (shared settings) as tooltip and as a legend below */
export function swatches(current: string, onPick: (color: string) => void): HTMLElement {
  const legend = colorLegend(data.labels);
  return h(
    "div",
    { class: "sl-swatches-wrap" },
    h(
      "div",
      { class: "sl-swatches", role: "radiogroup", "aria-label": t("Colour") },
      ...["", ...COLORS].map((c) =>
        h(
          "button",
          {
            type: "button",
            role: "radio",
            "aria-checked": c === current ? "true" : "false",
            class: `sl-swatch ${c ? `c-${c}` : "none"} ${c === current ? "on" : ""}`,
            title: colorTitle(c, data.labels),
            "aria-label": colorLabel(c, data.labels),
            onclick: () => onPick(c),
          },
          c === current ? "✓" : "",
        ),
      ),
    ),
    legend.length
      ? h(
          "div",
          { class: "sl-legend" },
          ...legend.map((l) => h("span", {}, h("span", { class: `sl-dot c-${l.color}` }), l.label)),
        )
      : null,
  );
}

/** Colour sheet: swatches only */
export function colorSheet(title: string, current: string, onPick: (color: string) => void | Promise<void>) {
  const body = h("div", { class: "sl-sheet" });
  const close = openModal(title, body, [button(t("Close"), () => close())], undefined, "sl-modal");
  body.append(
    swatches(current, (c) => {
      close();
      run(() => onPick(c));
    }),
  );
}

/** Ask for a text; resolves null when cancelled */
export function textPrompt(title: string, label: string, value: string, hint = ""): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const input = h("input", { type: "text", value, enterkeyhint: "done" });
    const ok = () => {
      done = true;
      close();
      resolve(input.value.trim());
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.isComposing) ok();
    });
    const close = openModal(
      title,
      h(
        "div",
        { class: "form" },
        h("label", { class: "field" }, h("span", { class: "field-label" }, label), input),
        hint ? h("p", { class: "hint" }, hint) : null,
      ),
      [button(t("Cancel"), () => close()), button(t("Save"), ok, "primary")],
      () => {
        if (!done) resolve(null);
      },
    );
    setTimeout(() => input.select(), 0);
  });
}
