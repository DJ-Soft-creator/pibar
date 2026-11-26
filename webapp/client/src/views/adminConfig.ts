// Shared settings for admins (tasks I4, I5, J1/J2 settings): model presets, quick actions, chat colours and colour
// descriptions, voice services. Stored on the server: the page loads GET /api/app-config (API keys only as
// "apiKeySet"), changes its part and sends the whole object back with PUT (an empty key with apiKeySet keeps it).
import "./adminConfig.css";
import { errMsg, h } from "@shared/dom";
import { t } from "@shared/i18n";
import { rest } from "../rest";
import { loadSharedConfig, type SharedConfig } from "../sharedConfig";
import { currentRoute, type Route } from "../state";
import { empty, header } from "../ui";
import { renderColors } from "./adminColors";
import { backToMore } from "./adminForm";
import { renderPresets, renderQuickActions } from "./adminPresets";
import { renderVoice } from "./adminVoice";

/** The settings as the admin gets them (same shape as for every user, keys left out) */
export type AdminSettings = SharedConfig;

/** Send the settings with `patch` applied; resolves with what the server stored */
export type SaveSettings = (patch: Partial<AdminSettings>) => Promise<AdminSettings>;

const TITLES: Partial<Record<Route, () => string>> = {
  "admin/presets": () => t("Model presets"),
  "admin/quick-actions": () => t("Quick actions"),
  "admin/colors": () => t("Chat colours"),
  "admin/voice": () => t("Voice"),
};

export async function renderAdminConfig(root: HTMLElement, section: Route) {
  const title = TITLES[section]?.() ?? section;
  root.replaceChildren(header(title, [], backToMore()), h("p", { class: "loading" }, t("Loading …")));
  let settings: AdminSettings;
  try {
    settings = await rest<AdminSettings>("GET", "/api/app-config");
  } catch (e) {
    if (currentRoute() === section) root.replaceChildren(header(title, [], backToMore()), empty(errMsg(e)));
    return;
  }
  // the admin went elsewhere while the settings loaded
  if (currentRoute() !== section) return;
  const save: SaveSettings = async (patch) => {
    settings = await rest<AdminSettings>("PUT", "/api/app-config", { ...settings, ...patch });
    // this page's own copy for the voice buttons and colours, without waiting for the socket message
    void loadSharedConfig();
    return settings;
  };
  const body = h("div", { class: "cfg-page" });
  root.replaceChildren(header(title, [], backToMore()), body);
  switch (section) {
    case "admin/presets":
      renderPresets(body, settings, save);
      break;
    case "admin/quick-actions":
      renderQuickActions(body, settings, save);
      break;
    case "admin/colors":
      renderColors(body, settings, save);
      break;
    case "admin/voice":
      renderVoice(body, settings, save);
      break;
    default:
      body.append(empty(section));
  }
}
