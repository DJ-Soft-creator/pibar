// Settings section "Session colours": a short description per colour (1–3 words, e.g. "Urgent"), shown as a tooltip
// and as a legend in the colour menu; empty keeps the built-in colour name. Logic: src/shared/sessionColors.ts.
import { h } from "../shared/dom";
import { t } from "../shared/i18n";
import { cleanColorLabels, COLOR_NAMES, COLORS, LABEL_MAX } from "../shared/sessionColors";
import { state } from "./state";

export interface SessionColorEditor {
  el: HTMLElement;
  /** The descriptions as edited (cleaned); an empty object = built-in names everywhere */
  get: () => Record<string, string>;
}

/** Editor for the colour descriptions; the settings dialog stores `get()` in ui.sessionColorLabels */
export function sessionColorEditor(): SessionColorEditor {
  const draft: Record<string, string> = { ...(state.config.ui.sessionColorLabels ?? {}) };
  const inputs: HTMLInputElement[] = [];
  const rows = COLORS.map((c) => {
    const input = h("input", {
      type: "text",
      value: draft[c] ?? "",
      placeholder: t(COLOR_NAMES[c]),
      maxlength: String(LABEL_MAX),
    }) as HTMLInputElement;
    input.addEventListener("input", () => (draft[c] = input.value));
    inputs.push(input);
    return h("div", { class: "row" }, h("label", {}, h("span", { class: `cdot c-${c}` }), t(COLOR_NAMES[c])), input);
  });
  const reset = h(
    "button",
    {
      class: "ghost",
      onclick: () => {
        for (const c of COLORS) delete draft[c];
        for (const i of inputs) i.value = "";
      },
    },
    t("Reset all"),
  );
  const el = h(
    "div",
    {},
    h(
      "p",
      { class: "hint" },
      t(
        'A short description per colour (1–3 words, e.g. "Urgent"). It appears as a tooltip and in the colour menu; empty keeps the colour name.',
      ),
    ),
    ...rows,
    h("div", { class: "row" }, h("label", {}, ""), reset),
  );
  return { el, get: () => cleanColorLabels(draft) };
}
