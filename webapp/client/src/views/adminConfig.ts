// Shared settings for admins (tasks I4, I5, J1/J2 settings): model presets, quick actions, chat colours and colour
// descriptions, voice services. Stored on the server (GET/PUT /api/app-config). Placeholder of the rebuild.
import { h } from "@shared/dom";
import type { Route } from "../state";

export function renderAdminConfig(root: HTMLElement, section: Route) {
  root.replaceChildren(h("div", { class: "empty" }, h("p", {}, section)));
}
