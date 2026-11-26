// Admin editors for the model presets and the quick actions of the chat (task I4), following presetEditor in
// src/main/settings.ts and quickActionsEditor in src/main/quickActions.ts: one card per row, move up/down, remove.
// Models are offered from the hosts' model lists (list_models) when a host answers; free text always works.
// Quick actions of kind "shell" (desktop: a script in a terminal tab) cannot run in the webapp: they are kept but
// shown as not usable here.
import { api, type ModelPreset, type QuickAction } from "@shared/api";
import { THINKING_LEVELS, thinkingLabel } from "@shared/format";
import { h } from "@shared/dom";
import { t } from "@shared/i18n";
import { cleanPresets, movePreset } from "@shared/presets";
import { cleanQuickActions } from "@shared/quickActions";
import { state } from "../state";
import { button, field } from "../ui";
import type { AdminSettings, SaveSettings } from "./adminConfig";
import { iconButton, saveBar, selectInput, textInput } from "./adminForm";

/** Model keys ("provider/id") per host name, loaded once per page visit */
async function hostModels(): Promise<[string, string[]][]> {
  const lists = await Promise.all(
    state.hosts.map((host) =>
      api
        .listModels(host.id)
        .then((l) => [host.name, [...new Set(l.map((m) => `${m.provider}/${m.id}`))].sort()] as [string, string[]])
        .catch(() => [host.name, []] as [string, string[]]),
    ),
  );
  return lists.filter(([, keys]) => keys.length > 0);
}

/** Move entry `from` to `to` in place (same rule as movePreset) */
function move<T>(list: T[], from: number, to: number) {
  const out = movePreset(list as unknown as ModelPreset[], from, to) as unknown as T[];
  list.splice(0, list.length, ...out);
}

function rowActions(list: unknown[], idx: number, rerender: (focus?: number) => void): HTMLElement {
  return h(
    "div",
    { class: "cfg-row-actions" },
    iconButton("↑", t("Move up"), () => (move(list, idx, idx - 1), rerender(idx - 1)), idx === 0),
    iconButton("↓", t("Move down"), () => (move(list, idx, idx + 1), rerender(idx + 1)), idx === list.length - 1),
    iconButton("×", t("Remove"), () => (list.splice(idx, 1), rerender())),
  );
}

// ------------------------------------------------------------------ model presets

export function renderPresets(root: HTMLElement, settings: AdminSettings, save: SaveSettings) {
  const draft: ModelPreset[] = (settings.presets ?? []).map((p) => ({
    id: String(p.id ?? ""),
    name: String(p.name ?? ""),
    model: String(p.model ?? ""),
    thinking: String(p.thinking ?? ""),
  }));
  let models: [string, string[]][] = [];
  const list = h("div", { class: "cfg-list" });

  /** The pick list next to a model field: models of the hosts, grouped by host */
  const fill = (s: HTMLSelectElement) => {
    s.replaceChildren(
      h("option", { value: "" }, t("Pick a model of the hosts …")),
      ...models.map(([host, keys]) => h("optgroup", { label: host }, ...keys.map((k) => h("option", { value: k }, k)))),
    );
    s.value = "";
    s.hidden = models.length === 0;
  };
  const modelPicker = (p: ModelPreset, input: HTMLInputElement) => {
    const s = h("select", { class: "cfg-model-pick", "aria-label": t("Models of the hosts") });
    fill(s);
    s.addEventListener("change", () => {
      if (!s.value) return;
      p.model = input.value = s.value;
      s.value = "";
    });
    return s;
  };

  const render = (focus?: number) => {
    list.replaceChildren(
      ...draft.map((p, idx) => {
        const model = textInput(p.model, (v) => (p.model = v), { placeholder: t("Model: keep") });
        return h(
          "section",
          { class: "card cfg-row", "data-idx": String(idx) },
          field(t("Name"), textInput(p.name, (v) => (p.name = v), { placeholder: t("e.g. Fast"), autocapitalize: "sentences" })),
          field(t("Model"), h("div", { class: "stack" }, model, modelPicker(p, model)), t("<provider>/<model id>, empty = keep the session's model")),
          field(
            t("Thinking"),
            selectInput(p.thinking, [["", t("Thinking: keep")], ...THINKING_LEVELS.map((l): [string, string] => [l, thinkingLabel(l)])], (v) => (p.thinking = v)),
          ),
          rowActions(draft, idx, render),
        );
      }),
    );
    if (!draft.length) list.append(h("p", { class: "muted cfg-none" }, t("No presets yet.")));
    // the arrows move the card; the focus follows it, so several taps in a row keep working
    if (focus !== undefined) list.querySelector<HTMLElement>(`[data-idx="${focus}"] .cfg-icon:not(:disabled)`)?.focus();
  };
  render();
  void hostModels().then((m) => {
    models = m;
    // in place: the admin may be typing in one of the fields
    list.querySelectorAll<HTMLSelectElement>(".cfg-model-pick").forEach(fill);
  });

  root.replaceChildren(
    h("p", { class: "hint" }, t("Quick choice of model and thinking level in the chat. An empty field keeps the session's value.")),
    h("p", { class: "hint" }, t("The order applies to the chat's preset list. Presets without a name or without model and thinking level are dropped.")),
    list,
    h(
      "div",
      { class: "row-actions" },
      button(t("+ Add preset"), () => {
        draft.push({ id: `preset${Date.now()}`, name: "", model: "", thinking: "" });
        render();
        list.querySelector<HTMLInputElement>(".cfg-row:last-of-type input")?.focus();
      }),
    ),
    saveBar(async () => {
      const presets = cleanPresets(draft);
      await save({ presets });
      draft.splice(0, draft.length, ...presets);
      render();
    }),
  );
}

// ------------------------------------------------------------------ quick actions

export function renderQuickActions(root: HTMLElement, settings: AdminSettings, save: SaveSettings) {
  const draft: QuickAction[] = (settings.quickActions ?? []).map((a) => ({
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    kind: a.kind === "shell" ? "shell" : "command",
    text: String(a.text ?? ""),
  }));
  const list = h("div", { class: "cfg-list" });

  const render = (focus?: number) => {
    list.replaceChildren(
      ...draft.map((a, idx) => {
        if (a.kind === "shell") {
          return h(
            "section",
            { class: "card cfg-row cfg-disabled", "data-idx": String(idx) },
            h("h2", {}, a.name || t("(unnamed)")),
            h("p", { class: "mono" }, a.text),
            h("p", { class: "hint" }, t("Shell script – runs only in the desktop app (it opens a terminal there), not in the webapp.")),
            rowActions(draft, idx, render),
          );
        }
        const text = h("textarea", { rows: 2, placeholder: t("/compact or a message to Pi") });
        text.value = a.text;
        text.addEventListener("input", () => (a.text = text.value));
        return h(
          "section",
          { class: "card cfg-row", "data-idx": String(idx) },
          field(t("Name"), textInput(a.name, (v) => (a.name = v), { placeholder: t("Label of the button"), autocapitalize: "sentences" })),
          field(t("Command or message"), text),
          rowActions(draft, idx, render),
        );
      }),
    );
    if (!draft.length) list.append(h("p", { class: "muted cfg-none" }, t("No quick actions yet.")));
    if (focus !== undefined) list.querySelector<HTMLElement>(`[data-idx="${focus}"] .cfg-icon:not(:disabled)`)?.focus();
  };
  render();

  root.replaceChildren(
    h(
      "p",
      { class: "hint" },
      t("Buttons in the chat: the text goes to the open session as a message or a slash command (e.g. /compact). Rows without a name or text are dropped."),
    ),
    list,
    h(
      "div",
      { class: "row-actions" },
      button(t("+ Add button"), () => {
        draft.push({ id: `qa${Date.now()}`, name: "", kind: "command", text: "" });
        render();
        list.querySelector<HTMLInputElement>(".cfg-row:last-of-type input")?.focus();
      }),
    ),
    saveBar(async () => {
      const quickActions = cleanQuickActions(draft);
      await save({ quickActions });
      draft.splice(0, draft.length, ...quickActions);
      render();
    }),
  );
}
