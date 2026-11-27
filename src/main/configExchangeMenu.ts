// Webapp sync entries for the session list's view menu (src/main/sessions.ts): sync now, toggle the automatic sync,
// sign in to the webapp / sign out. Actions: src/main/configExchangeTool.ts, the sync itself: configExchange.ts.
import { t } from "../shared/i18n";
import type { MenuItem } from "./menu";
import { autoSyncEnabled, signedIn, webappUser } from "./configExchange";
import { signInDialog, signOutWithFeedback, syncWithFeedback, toggleAutoSync } from "./configExchangeTool";

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
    signedIn()
      ? {
          label: t("Sign out of the webapp"),
          desc: t("Signed in as {user}", { user: webappUser() }),
          onSelect: () => void signOutWithFeedback(),
        }
      : { label: t("Sign in to the webapp…"), onSelect: signInDialog },
  ];
}
