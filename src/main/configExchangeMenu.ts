// Webapp sync entries for the session list's view menu (src/main/sessions.ts): sync now, toggle the automatic sync,
// set webapp URL and API token. Actions: src/main/configExchangeTool.ts, the sync itself: configExchange.ts.
import { t } from "../shared/i18n";
import type { MenuItem } from "./menu";
import { autoSyncEnabled } from "./configExchange";
import { syncWithFeedback, toggleAutoSync, webappUrlDialog } from "./configExchangeTool";

/** Menu entries; the session list redraws itself when a sync brings changes (wireConfigAutoSync) */
export function configExchangeItems(_refresh?: () => void): MenuItem[] {
  return [
    {
      label: t("Sync with webapp now"),
      desc: t("Names, colours, groups and projects in both directions"),
      onSelect: () => void syncWithFeedback(),
    },
    {
      label: t("Sync with webapp automatically"),
      desc: t("At start, after every change and every minute"),
      selected: autoSyncEnabled(),
      onSelect: toggleAutoSync,
    },
    { label: t("Webapp sync…"), onSelect: webappUrlDialog },
  ];
}
