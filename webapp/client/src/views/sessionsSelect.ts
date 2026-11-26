// Multi-selection in the session list (like src/main/sessionSelect.ts, adapted to touch): a select mode with a check
// on every row; the bar at the bottom acts on the chosen sessions (group, colour, pin, archive, delete).
import { h } from "@shared/dom";
import { t } from "@shared/i18n";
import { rerender } from "./sessionsData";

export const selection = {
  /** Select mode: a tap on a row checks it instead of opening it */
  on: false,
  keys: new Set<string>(),
};

export function setSelecting(on: boolean) {
  selection.on = on;
  if (!on) selection.keys.clear();
  rerender();
}

export function toggleSelected(key: string) {
  if (selection.keys.has(key)) selection.keys.delete(key);
  else selection.keys.add(key);
  rerender();
}

export interface BulkActions {
  group(keys: string[]): void;
  color(keys: string[]): void;
  pin(keys: string[]): void;
  archive(keys: string[]): void;
  remove(keys: string[]): void;
}

/** The bar above the tab bar while selecting: count, actions, done; `visible` = the keys of the rows on screen */
export function selectionBar(visible: string[], act: BulkActions): HTMLElement {
  const keys = [...selection.keys];
  const n = keys.length;
  const btn = (label: string, fn: (keys: string[]) => void, cls = "") =>
    h("button", { type: "button", class: `sl-bulk-btn ${cls}`, disabled: !n, onclick: () => fn(keys) }, label);
  const all = visible.length > 0 && visible.every((k) => selection.keys.has(k));
  return h(
    "div",
    { class: "sl-bulk", role: "toolbar", "aria-label": t("{n} selected", { n }) },
    h(
      "div",
      { class: "sl-bulk-top" },
      h("span", { class: "sl-bulk-count" }, t("{n} selected", { n })),
      h(
        "button",
        {
          type: "button",
          class: "sl-bulk-link",
          onclick: () => {
            if (all) selection.keys.clear();
            else for (const k of visible) selection.keys.add(k);
            rerender();
          },
        },
        all ? t("No session") : t("All"),
      ),
      h("button", { type: "button", class: "sl-bulk-link strong", onclick: () => setSelecting(false) }, t("Done")),
    ),
    h(
      "div",
      { class: "sl-bulk-acts" },
      btn(t("Group"), act.group),
      btn(t("Colour"), act.color),
      btn(t("Pin"), act.pin),
      btn(t("Archive"), act.archive),
      btn(t("Delete"), act.remove, "danger"),
    ),
  );
}
