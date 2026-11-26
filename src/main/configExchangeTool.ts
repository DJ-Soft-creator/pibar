// Actions behind the webapp sync entries (src/main/configExchangeMenu.ts, settings.ts): the dialog for webapp URL
// and API token, "Sync now" with feedback, the auto-sync toggle, and the text of the last sync result.
import { errMsg, h, openModal, toast } from "../shared/dom";
import { relTime } from "../shared/format";
import { t } from "../shared/i18n";
import {
  autoSyncEnabled,
  setAutoSyncEnabled,
  setWebappToken,
  setWebappUrl,
  syncNow,
  webappToken,
  webappUrl,
  type SyncResult,
} from "./configExchange";

/** One line about a sync result for the settings and toasts */
export function syncResultText(r: SyncResult | null): string {
  if (!r) return t("Not synced yet.");
  const when = relTime(r.at);
  if (!r.ok) return t("Last sync {when} failed: {error}", { when, error: r.error ?? "" });
  let s = t("Last sync {when}: {updated} received, {removed} removed.", {
    when,
    updated: r.updated ?? 0,
    removed: r.removed ?? 0,
  });
  if (r.unmatched?.length) s += ` ${t("Not in the webapp: {hosts}", { hosts: r.unmatched.join(", ") })}`;
  return s;
}

/** Input fields for URL and token (shared by the dialog and the settings) */
export function webappFields(): { url: HTMLInputElement; token: HTMLInputElement; apply: () => void } {
  const url = h("input", {
    type: "url",
    value: webappUrl(),
    placeholder: "http://192.168.1.20:8787",
  }) as HTMLInputElement;
  const token = h("input", {
    type: "password",
    value: webappToken(),
    placeholder: "pbt_…",
    autocomplete: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  return {
    url,
    token,
    apply: () => {
      setWebappUrl(url.value);
      setWebappToken(token.value);
    },
  };
}

/** Ask for the webapp URL and the API token (empty URL = sync off) */
export function webappUrlDialog() {
  const f = webappFields();
  const close = openModal(
    t("Webapp sync"),
    h(
      "div",
      {},
      h("p", { class: "hint" }, t("Address of the mobile webapp; empty = sync off.")),
      f.url,
      h("p", { class: "hint" }, t("API token from the webapp (More → Desktop app tokens).")),
      f.token,
    ),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h(
        "button",
        {
          class: "primary",
          onclick: () => {
            f.apply();
            close();
            if (webappUrl() && webappToken()) void syncWithFeedback();
          },
        },
        t("Save"),
      ),
    ],
  );
  f.url.focus();
}

/** Flip the auto-sync; turning it on syncs once right away (with feedback) */
export function toggleAutoSync() {
  const on = !autoSyncEnabled();
  setAutoSyncEnabled(on);
  if (on) void syncWithFeedback();
}

/** Sync now and say how it went; opens the dialog when URL or token are missing */
export async function syncWithFeedback(): Promise<SyncResult | null> {
  if (!webappUrl() || !webappToken()) {
    toast(t("No webapp URL or token configured."), "err");
    webappUrlDialog();
    return null;
  }
  try {
    const r = await syncNow();
    toast(syncResultText(r), r.ok ? "info" : "err");
    return r;
  } catch (e) {
    toast(`${t("Sync failed")}: ${errMsg(e)}`, "err");
    return null;
  }
}
