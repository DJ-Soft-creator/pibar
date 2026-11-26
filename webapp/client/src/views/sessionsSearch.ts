// Search above the session list (task E2, like src/main/search.ts): every keystroke filters the list at once; after a
// short pause every shown host is asked for sessions whose messages contain the text (search_sessions: one grep
// over its session files). The hits are drawn above the hosts, newest first; answers to an older query are dropped.
import type { SearchHit } from "@shared/api";
import { api } from "@shared/api";
import { errMsg, h } from "@shared/dom";
import { cleanTitle } from "@shared/format";
import { t } from "@shared/i18n";
import { cleanQuery, highlight, isSearching, roleLabel } from "@shared/search";
import { state } from "../state";
import { isCollapsed, keyOf, prefs, rerender, sessionOf, titleOf, toggleCollapsed } from "./sessionsData";
import { hostName, openRow } from "./sessionsRows";

/** Pause after the last keystroke before the hosts are asked */
const DELAY = 350;

export const search = {
  query: "",
  hits: new Map<string, SearchHit[]>(),
  pending: 0,
  done: true,
  error: "",
};

let timer = 0;
let generation = 0;

function restart(query: string) {
  generation++;
  search.query = query;
  search.hits.clear();
  search.error = "";
  search.pending = 0;
  search.done = !isSearching(query);
}

/** The field changed: filter now, ask the hosts after a pause */
export function setQuery(raw: string) {
  const q = cleanQuery(raw);
  if (q === search.query) return;
  clearTimeout(timer);
  restart(q);
  rerender();
  if (isSearching(q)) timer = window.setTimeout(() => void searchAll(q), DELAY);
}

/** The host filter changed: ask again */
export function researchHosts() {
  if (!isSearching(search.query)) return;
  const q = search.query;
  restart(q);
  void searchAll(q);
}

function shownHosts() {
  const host = prefs().host;
  return state.hosts.filter((x) => !host || x.id === host);
}

async function searchAll(query: string) {
  const mine = generation;
  const hosts = shownHosts();
  search.pending = hosts.length;
  search.done = hosts.length === 0;
  rerender();
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const hits = await api.searchSessions(host.id, query);
        if (mine === generation) search.hits.set(host.id, hits);
      } catch (e) {
        // one unreachable host must not hide what the others found
        if (mine === generation && !search.error) search.error = `${host.name}: ${errMsg(e)}`;
      }
      if (mine !== generation) return;
      search.pending--;
      search.done = search.pending === 0;
      rerender();
    }),
  );
}

/** The block "In messages" above the hosts (null while not searching) */
export function hitsBlock(): HTMLElement | null {
  if (!isSearching(search.query)) return null;
  const host = prefs().host;
  const rows: { hostId: string; hit: SearchHit; modified: number }[] = [];
  for (const [hostId, list] of search.hits) {
    if (host && host !== hostId) continue;
    for (const hit of list) rows.push({ hostId, hit, modified: sessionOf(keyOf(hostId, hit.path))?.modified ?? 0 });
  }
  rows.sort((a, b) => b.modified - a.modified);
  const line = search.pending ? t("Searching …") : !search.done ? "" : rows.length ? "" : t("No messages found");
  const closed = isCollapsed("hits");
  const many = state.hosts.length > 1 && !host;
  return h(
    "section",
    { class: `sl-block sl-hits ${closed ? "collapsed" : ""}` },
    h(
      "button",
      { type: "button", class: "sl-block-head", "aria-expanded": closed ? "false" : "true", onclick: () => toggleCollapsed("hits") },
      h("span", { class: "sl-chev" }, "▾"),
      h("span", { class: "sl-block-name" }, t("In messages")),
      line ? h("span", { class: "sl-state" }, line) : null,
      h("span", { class: "sl-count" }, String(rows.length)),
    ),
    closed || !search.error ? null : h("p", { class: "sl-error" }, search.error),
    ...(closed
      ? []
      : rows.slice(0, 60).map(({ hostId, hit }) => {
          const key = keyOf(hostId, hit.path);
          const info = sessionOf(key);
          const s = info ?? { path: hit.path, cwd: hit.cwd, name: null, title: hit.title, id: "", timestamp: "", parent: null, modified: 0 };
          const parts = highlight(hit.snippet, search.query);
          return h(
            "div",
            { class: "sl-hit", role: "button", tabindex: 0, title: s.cwd, onclick: () => openRow({ key, hostId, s }) },
            h(
              "span",
              { class: "sl-hit-head" },
              h("span", { class: "sl-hit-role" }, t(roleLabel(hit.role))),
              many ? h("span", { class: "sl-hit-host" }, hostName(hostId)) : null,
              h("span", { class: "sl-hit-title" }, cleanTitle(titleOf(hostId, s)) || t("New session")),
            ),
            h("span", { class: "sl-hit-snip" }, ...(parts ? [parts[0], h("mark", {}, parts[1]), parts[2]] : [hit.snippet])),
          );
        })),
  );
}
