// Session list of one host (mobile): host switcher, search, sections by date like the desktop
// (src/shared/sessionOrder.ts), reload button. Tapping a session opens its chat, "+" starts a new session in the
// host's default folder.
import { api, type SessionInfo } from "@shared/api";
import { errMsg, h } from "@shared/dom";
import { cleanTitle, relTime, shortPath } from "@shared/format";
import { getLang, t } from "@shared/i18n";
import { matchesQuery } from "@shared/search";
import { sectionRows } from "@shared/sessionOrder";
import { currentHost, go, isAdmin, openChat, saveSettings, state } from "../state";
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
  const hostName = host.name;
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
            {
              class: "row",
              onclick: () =>
                openChat({ hostId, hostName, path: r.s.path, cwd: r.s.cwd, title: r.title }),
            },
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
  const add = h(
    "button",
    {
      class: "icon-btn",
      title: t("New session"),
      "aria-label": t("New session"),
      onclick: () => openChat({ hostId, hostName: host.name, path: null, cwd: host.defaultDir || "~", title: "" }),
    },
    "+",
  );
  root.replaceChildren(header(t("Sessions"), [add, reload]), h("div", { class: "toolbar" }, picker, search), ...banner, listEl);
  fillList();
  if (!list && !error) void load(host.id, render);
}
