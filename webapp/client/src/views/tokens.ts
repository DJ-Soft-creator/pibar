// API tokens for desktop apps (task I3): create (shown once), name, revoke. The desktop syncs the organisation of
// the session list with such a token (task D3). Placeholder of the rebuild.
import { h } from "@shared/dom";

export function renderTokens(root: HTMLElement) {
  root.replaceChildren(h("div", { class: "empty" }, h("p", {}, "…")));
}
