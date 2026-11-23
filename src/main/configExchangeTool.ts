// Actions behind the config exchange menu (src/main/configExchangeMenu.ts): send the config to the webapp,
// import it back and set the webapp URL. Feedback via toast; the URL dialog is also opened when no URL is set.
import { errMsg, h, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import {
  fetchFromWebapp,
  importSessionConfig,
  loadConfig,
  sendToWebapp,
  setWebappUrl,
  webappUrl,
} from "./configExchange";

/** Ask for the base URL of the mobile webapp (empty = config exchange off) */
export function webappUrlDialog() {
  const input = h("input", {
    type: "url",
    value: webappUrl(),
    placeholder: "http://192.168.1.20:8787",
  }) as HTMLInputElement;
  const close = openModal(
    t("Webapp URL"),
    h("div", {}, h("p", { class: "hint" }, t("Address of the mobile webapp; empty = config exchange off.")), input),
    [
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h(
        "button",
        {
          class: "primary",
          onclick: () => {
            setWebappUrl(input.value);
            close();
          },
        },
        t("Save"),
      ),
    ],
  );
  input.focus();
}

/** Send sessions, projects and groups to the webapp */
export async function exportConfig(): Promise<boolean> {
  if (!webappUrl()) {
    toast(t("No webapp URL configured."), "err");
    webappUrlDialog();
    return false;
  }
  try {
    await sendToWebapp(loadConfig());
    toast(t("Config sent to the webapp."));
    return true;
  } catch (e) {
    toast(`${t("Sending failed")}: ${errMsg(e)}`, "err");
    return false;
  }
}

/** Import a payload from the webapp; `refresh` redraws the session list afterwards */
export async function importConfig(refresh?: () => void): Promise<boolean> {
  if (!webappUrl()) {
    toast(t("No webapp URL configured."), "err");
    webappUrlDialog();
    return false;
  }
  try {
    const config = await fetchFromWebapp();
    const added = await importSessionConfig(config);
    if (!added.sessions && !added.groups && !added.projects) {
      toast(t("Nothing new to import."));
    } else {
      toast(t("Imported {sessions} session(s), {groups} group(s), {projects} project(s).", added));
      refresh?.();
    }
    return true;
  } catch (e) {
    toast(`${t("Import failed")}: ${errMsg(e)}`, "err");
    return false;
  }
}
