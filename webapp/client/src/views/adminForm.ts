// Small form pieces of the admin pages for the shared settings (adminPresets.ts, adminColors.ts, adminVoice.ts):
// inputs bound to an object field, selects, check boxes, the write-only API key field and the save bar.
import { errMsg, h, toast } from "@shared/dom";
import { t } from "@shared/i18n";
import { go } from "../state";
import { button } from "../ui";

export const backToMore = () => h("button", { class: "icon-btn", "aria-label": t("Back"), onclick: () => go("more") }, "‹");

/** Text input; `oninput` gets the value on every change */
export function textInput(value: string, oninput: (v: string) => void, attrs: Record<string, string> = {}): HTMLInputElement {
  const i = h("input", { type: "text", value, autocapitalize: "none", autocorrect: "off", spellcheck: "false", ...attrs });
  i.addEventListener("input", () => oninput(i.value));
  return i;
}

export function selectInput(value: string, options: [string, string][], onchange: (v: string) => void): HTMLSelectElement {
  const s = h("select", {}, ...options.map(([v, l]) => h("option", { value: v, selected: v === value }, l)));
  s.value = value;
  s.addEventListener("change", () => onchange(s.value));
  return s;
}

export function checkInput(checked: boolean, label: string, onchange: (v: boolean) => void): HTMLElement {
  const c = h("input", { type: "checkbox", checked });
  c.addEventListener("change", () => onchange(c.checked));
  return h("label", { class: "check" }, c, label);
}

/** API key as the server hands it out: never the key itself, only whether one is stored */
export interface SecretField {
  apiKey?: string;
  apiKeySet?: boolean;
}

/**
 * Write-only key field: empty keeps the stored key (the server's keepSecrets), typing replaces it, "remove" deletes it.
 * Writes apiKey/apiKeySet of `o` so the whole settings object can be sent back as it is.
 */
export function secretInput(o: SecretField): HTMLElement {
  const had = !!o.apiKeySet;
  o.apiKey = "";
  const input = h("input", {
    type: "password",
    autocomplete: "new-password",
    placeholder: had ? t("Stored – leave empty to keep it") : t("optional for local servers"),
  });
  let remove = false;
  const sync = () => {
    o.apiKey = remove ? "" : input.value.trim();
    o.apiKeySet = had && !remove && !o.apiKey;
    input.disabled = remove;
  };
  input.addEventListener("input", sync);
  return h(
    "div",
    { class: "cfg-secret" },
    input,
    had
      ? checkInput(false, t("Remove the stored key"), (v) => {
          remove = v;
          if (v) input.value = "";
          sync();
        })
      : null,
  );
}

/** Save button at the bottom of the page; `save` rejects with the server's error */
export function saveBar(save: () => Promise<unknown>): HTMLElement {
  const btn = button(
    t("Save"),
    () => {
      btn.disabled = true;
      save()
        .then(() => toast(t("Saved.")))
        .catch((e: unknown) => toast(errMsg(e), "err"))
        .finally(() => (btn.disabled = false));
    },
    "primary block",
  );
  return h("div", { class: "cfg-save" }, btn);
}

/** Small square button (↑ ↓ ×) with a label for screen readers */
export function iconButton(text: string, label: string, onclick: () => void, disabled = false): HTMLButtonElement {
  return h("button", { type: "button", class: "icon-btn cfg-icon", title: label, "aria-label": label, disabled, onclick }, text);
}
