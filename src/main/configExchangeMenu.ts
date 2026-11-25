// Config exchange entries for the session list's view menu (src/main/sessions.ts): send the config to the
// mobile webapp, import it back, toggle the auto-sync, set the webapp URL. Actions: src/main/configExchangeTool.ts.
import { t } from "../shared/i18n";
import type { MenuItem } from "./menu";
import { autoSyncEnabled } from "./configExchange";
import { exportConfig, importConfig, toggleAutoSync, webappUrlDialog } from "./configExchangeTool";

/** Menu entries; `refresh` redraws the session list after an import */
export function configExchangeItems(refresh: () => void): MenuItem[] {
  return [
    {
      label: t("Send config to webapp"),
      desc: t("Sessions, projects and groups to the mobile webapp"),
      onSelect: () => void exportConfig(),
    },
    { label: t("Import config from webapp"), onSelect: () => void importConfig(refresh) },
    {
      label: t("Auto-sync to webapp"),
      desc: t("Send the config automatically after every change"),
      selected: autoSyncEnabled(),
      onSelect: toggleAutoSync,
    },
    { label: t("Webapp URL…"), onSelect: webappUrlDialog },
  ];
}
