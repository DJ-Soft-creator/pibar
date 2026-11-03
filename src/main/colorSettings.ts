// Settings section "Chat colours": profiles that colour thinking, tool calls, answers and own messages – one set for
// the dark and one for the light theme, entered as hex values (empty = the theme's own colour). A profile is assigned
// to a host in the host list (src/main/settings.ts); src/shared/colors.ts holds the logic, src/main/colors.ts applies it.
import {
  cleanColor,
  cleanProfiles,
  fullHex,
  ROLES,
  type ChatColors,
  type ColorProfile,
  type Role,
} from "../shared/colors";
import { h } from "../shared/dom";
import { t, type Msg } from "../shared/i18n";
import { state } from "./state";

const ROLE_LABELS: Record<Role, Msg> = {
  thinking: "Thinking",
  tools: "Tool calls",
  answer: "Answers",
  own: "Your messages",
};

export interface ColorEditor {
  el: HTMLElement;
  /** The profiles as edited (cleaned) */
  get: () => ColorProfile[];
  /** Profile for hosts without their own */
  getDefault: () => string;
}

/** Editor for the colour profiles; `onChange`: the list of profiles changed (the host selectors use it) */
export function colorEditor(onChange: () => void): ColorEditor {
  const draft: ColorProfile[] = JSON.parse(JSON.stringify(state.config.colorProfiles ?? []));
  let cur = 0;
  let dark = true;
  let fallback = state.config.ui.colorProfile ?? "";

  const picker = h("select", {}) as HTMLSelectElement;
  const name = h("input", { type: "text", placeholder: t("Name of the profile") }) as HTMLInputElement;
  const table = h("div", { class: "color-table" });
  const themeSwitch = h("div", { class: "seg" });
  const fields = h(
    "div",
    { class: "color-edit" },
    name,
    h("div", { class: "color-theme" }, h("span", { class: "muted" }, t("Colours for")), themeSwitch),
    table,
  );
  const empty = h("p", { class: "hint" }, t("No colour profile yet – add one to colour the chat."));
  const useDefault = h("select", {}) as HTMLSelectElement;

  const current = (): ColorProfile | undefined => draft[cur];

  /** The colour set the table edits right now */
  const set = (): ChatColors => {
    const p = current();
    if (!p) return {};
    return (p[dark ? "dark" : "light"] ??= {});
  };

  function renderPicker() {
    picker.replaceChildren(
      ...draft.map((p, i) => h("option", { value: String(i), selected: i === cur }, p.name || t("(unnamed)"))),
    );
    picker.value = String(cur);
    picker.disabled = !draft.length;
  }

  function renderTheme() {
    themeSwitch.replaceChildren(
      h(
        "button",
        {
          type: "button",
          class: `seg-btn ${dark ? "active" : ""}`,
          onclick: () => {
            dark = true;
            renderTheme();
            renderTable();
          },
        },
        t("Dark"),
      ),
      h(
        "button",
        {
          type: "button",
          class: `seg-btn ${dark ? "" : "active"}`,
          onclick: () => {
            dark = false;
            renderTheme();
            renderTable();
          },
        },
        t("Light"),
      ),
    );
  }

  /** One colour field: hex text plus the system colour picker, both writing the same value */
  function colorField(role: Role, key: "background" | "text") {
    const value = () => cleanColor(set()[role]?.[key]);
    const text = h("input", {
      type: "text",
      class: "hex",
      placeholder: "#rrggbb",
      value: value(),
      spellcheck: "false",
    }) as HTMLInputElement;
    const swatch = h("input", {
      type: "color",
      class: "swatch",
      value: fullHex(value()) || "#000000",
    }) as HTMLInputElement;
    swatch.disabled = !fullHex(value());
    text.addEventListener("input", () => {
      const c = cleanColor(text.value);
      const target = (set()[role] ??= {});
      target[key] = c;
      // an unfinished entry (e.g. "#12") stays in the field, the profile just keeps the last valid colour
      const hex = fullHex(c);
      swatch.disabled = !hex;
      if (hex) swatch.value = hex;
      text.classList.toggle("bad", !!text.value.trim() && !c);
    });
    swatch.addEventListener("input", () => {
      text.value = swatch.value;
      (set()[role] ??= {})[key] = swatch.value;
      text.classList.remove("bad");
    });
    return h("div", { class: "color-field" }, text, swatch);
  }

  function renderTable() {
    table.hidden = !current();
    if (!current()) return;
    const head = h(
      "div",
      { class: "color-row head" },
      h("span", {}, ""),
      h("span", {}, t("Background")),
      h("span", {}, t("Text")),
    );
    table.replaceChildren(
      head,
      ...ROLES.map((role) =>
        h(
          "div",
          { class: "color-row" },
          h("span", { class: "color-role" }, t(ROLE_LABELS[role])),
          colorField(role, "background"),
          colorField(role, "text"),
        ),
      ),
    );
  }

  function render(keep = cur) {
    cur = Math.min(Math.max(0, keep), Math.max(0, draft.length - 1));
    fields.hidden = !draft.length;
    empty.hidden = !!draft.length;
    name.value = current()?.name ?? "";
    renderPicker();
    renderTheme();
    renderTable();
    renderFallback();
  }

  /** "Default" selector: which profile hosts without their own use */
  function renderFallback() {
    useDefault.replaceChildren(
      h("option", { value: "", selected: !fallback }, t("Theme colours")),
      ...draft.map((p) => h("option", { value: p.id, selected: fallback === p.id }, p.name || t("(unnamed)"))),
    );
    useDefault.value = fallback;
  }

  picker.addEventListener("change", () => render(Number(picker.value)));
  name.addEventListener("input", () => {
    const p = current();
    if (!p) return;
    p.name = name.value;
    const opt = picker.options[picker.selectedIndex];
    if (opt) opt.textContent = name.value || t("(unnamed)");
    renderFallback();
  });
  useDefault.addEventListener("change", () => (fallback = useDefault.value));

  const add = () => {
    draft.push({ id: `color${Date.now()}`, name: t("New profile"), dark: {}, light: {} });
    render(draft.length - 1);
    renderFallback();
    onChange();
  };

  const remove = () => {
    const gone = current();
    if (!gone) return;
    draft.splice(cur, 1);
    if (fallback === gone.id) fallback = "";
    render(cur - 1);
    renderFallback();
    onChange();
  };

  const el = h(
    "div",
    {},
    h(
      "p",
      { class: "hint" },
      t(
        "Colours for the four kinds of chat content, separately for the dark and the light theme. Empty fields keep the theme's colour; values are hex colours such as #2b3a55 or #abc.",
      ),
    ),
    h(
      "div",
      { class: "color-head" },
      picker,
      h("button", { class: "ghost", type: "button", onclick: add }, t("+ Add profile")),
      h("button", { class: "ghost", type: "button", disabled: !draft.length, onclick: remove }, t("Remove")),
    ),
    empty,
    fields,
    h("h5", { class: "set-sub" }, t("Profile for hosts without their own")),
    useDefault,
  );

  render();
  return {
    el,
    get: () => cleanProfiles(draft),
    getDefault: () => fallback,
  };
}
