// Session list of one host (mobile): host switcher, search, sections by date like the desktop
// (src/shared/sessionOrder.ts), pull the list again with the reload button. Tapping a session shows its details;
// opening the chat follows with tasks E3/E4.
import { api, type SessionInfo } from "@shared/api";
import { copyText, errMsg, h, openModal, toast } from "@shared/dom";
import { cleanTitle, relTime, shortPath } from "@shared/format";
import { getLang, t } from "@shared/i18n";
import { matchesQuery } from "@shared/search";
import { sectionRows } from "@shared/sessionOrder";
import { currentHost, isAdmin, saveSettings, state, go } from "../state";
import { button, empty, header } from "../ui";

let query = "";

function sectionLabel(key: string): string {
  const fixed: Record<string, string> = {
    today: t("Today"),
    yesterday: t("Yesterday"),
    week: t("Last 7 days"),
    month: t("Last 30 days"),
  };
  if (fixed[key]) return fixed[key];
  const [y, m] = key.split("-").map(Number);
  return new Date(y ?? 1970, (m ?? 1) - 1, 1).toLocaleDateString(getLang(), { month: "long", year: "numeric" });
}

export const displayTitle = (s: SessionInfo) => s.name || cleanTitle(s.title);

function openDetail(s: SessionInfo) {
  const row = (label: string, value: string) =>
    h("div", { class: "detail-row" }, h("span", {}, label), h("code", {}, value || "–"));
  const body = h(
    "div",
    { class: "detail" },
    row(t("Folder"), s.cwd),
    row(t("Last activity"), s.modified ? new Date(s.modified * 1000).toLocaleString(getLang()) : ""),
    row(t("Session ID"), s.id),
    h("p", { class: "hint" }, t("Opening the chat follows with the next step of the webapp.")),
  );
  const close = openModal(displayTitle(s), body, [
    button(t("Copy session ID"), () => {
      copyText(s.id)
        .then(() => toast(t("Copied")))
        .catch((e: unknown) => toast(errMsg(e), "err"));
    }),
    button(t("Close"), () => close(), "primary"),
  ]);
}

async function load(hostId: string, render: () => void) {
  try {
    state.sessions.set(hostId, await api.listSessions(hostId));
    state.sessionErrors.delete(hostId);
  } catch (e) {
    state.sessionErrors.set(hostId, errMsg(e));
  }
  render();
}

export function renderSessions(root: HTMLElement) {
  const host = currentHost();
  if (!host) {
    root.replaceChildren(
      header(t("Sessions")),
      isAdmin()
        ? empty(t("No hosts yet."), button(t("Add host"), () => go("admin/hosts"), "primary"))
        : empty(t("No host has been assigned to you yet. Ask the admin.")),
    );
    return;
  }
  const render = () => renderSessions(root);
  const hostId = host.id;
  const list = state.sessions.get(hostId);
  const error = state.sessionErrors.get(host.id);

  const reload = h(
    "button",
    {
      class: "icon-btn",
      title: t("Reload"),
      "aria-label": t("Reload"),
      onclick: () => {
        reload.classList.add("spin");
        void load(host.id, render);
      },
    },
    "↻",
  );
  const picker =
    state.hosts.length > 1
      ? h(
          "select",
          {
            class: "host-picker",
            "aria-label": t("Host"),
            onchange: (e: Event) => {
              void saveSettings({ hostId: (e.target as HTMLSelectElement).value }).catch(() => {});
              render();
            },
          },
          ...state.hosts.map((x) => h("option", { value: x.id, selected: x.id === host.id }, x.name)),
        )
      : h("span", { class: "host-name" }, host.name);

  const search = h("input", {
    type: "search",
    class: "search",
    placeholder: t("Search"),
    value: query,
    oninput: (e: Event) => {
      query = (e.target as HTMLInputElement).value;
      fillList();
    },
  });
  const listEl = h("div", { class: "list" });

  function fillList() {
    if (error && !list) {
      listEl.replaceChildren(empty(error, button(t("Reload"), () => void load(hostId, render))));
      return;
    }
    if (!list) {
      listEl.replaceChildren(h("div", { class: "loading" }, t("Loading …")));
      return;
    }
    const rows = list
      .filter((s) => matchesQuery([displayTitle(s), s.cwd], query))
      .map((s) => ({
        s,
        title: displayTitle(s),
        cwd: s.cwd,
        created: Date.parse(s.timestamp) || 0,
        modified: (s.modified ?? 0) * 1000,
      }));
    if (!rows.length) {
      listEl.replaceChildren(empty(query ? t("No session matches.") : t("No sessions on this host yet.")));
      return;
    }
    listEl.replaceChildren(
      ...sectionRows(rows, "activity", "date").flatMap((sec) => [
        h("h2", { class: "section" }, sectionLabel(sec.key)),
        ...sec.rows.map((r) =>
          h(
            "button",
            { class: "row", onclick: () => openDetail(r.s) },
            h("span", { class: "row-title" }, r.title),
            h(
              "span",
              { class: "row-meta" },
              h("span", { class: "row-folder" }, shortPath(r.cwd) || "~"),
              h("span", {}, r.modified ? relTime(r.modified) : ""),
            ),
          ),
        ),
      ]),
    );
  }

  const banner = error && list ? [h("p", { class: "error banner" }, error)] : [];
  root.replaceChildren(header(t("Sessions"), [reload]), h("div", { class: "toolbar" }, picker, search), ...banner, listEl);
  fillList();
  if (!list && !error) void load(host.id, render);
}
