// Extras started after login (tasks I5, J1–J4): the shared settings (reloaded when an admin saves them), the chat
// colours of the open chat's host, web push (service worker, "Notifications" card in More, open-chat reports) and
// keyboard shortcuts on tablets. Every part wires itself only once per page, also when the user logs in again.
import { wireChatColors } from "./chatColors";
import { wirePush } from "./push";
import { loadSharedConfig, wireSharedConfig } from "./sharedConfig";
import { wireShortcuts } from "./shortcuts";

export function initExtras() {
  wireSharedConfig();
  // fresh settings for the user who just logged in (voice buttons and colours follow via onSharedConfig)
  void loadSharedConfig();
  wireChatColors();
  wirePush();
  wireShortcuts();
}
