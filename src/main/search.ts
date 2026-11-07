// The search field above the session list. Every keystroke filters the list at once (sessions.ts); after a short pause
// each shown host is asked for sessions whose messages contain the text (sessions::search in Rust: one grep over its
// session files, over SSH or locally). The hits land in state.search and are drawn above the hosts.
import { api } from "../shared/api";
import { $, errMsg, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import { cleanQuery, isSearching } from "../shared/search";
import { togglePanel } from "./layout";
import { renderHosts, selectedHost } from "./sessions";
import { state } from "./state";

const elInput = $("sess-search") as HTMLInputElement;
const elClear = $("btn-search-clear") as HTMLButtonElement;

/** Pause after the last keystroke before the hosts are asked: typing should not start a grep per letter */
const DELAY = 350;

let timer = 0;
/** Number of the current search: answers of an older one are dropped, they would show the wrong query */
let generation = 0;

/** A new query: forget what the hosts said before, answers to the old query are dropped (see `generation`) */
function restart(query: string) {
  generation++;
  state.search.query = query;
  state.search.hits.clear();
  state.search.error = "";
  state.search.pending = 0;
  state.search.done = !isSearching(query);
}

export function wireSearch() {
  elInput.addEventListener("input", () => {
    const q = cleanQuery(elInput.value);
    elClear.hidden = !elInput.value;
    if (q === state.search.query) return;
    clearTimeout(timer);
    restart(q);
    renderHosts();
    if (isSearching(q)) timer = window.setTimeout(() => void searchAll(q), DELAY);
  });
  // Esc in the field clears the search; the list stays filtered until then
  elInput.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key !== "Escape") return;
    e.preventDefault();
    e.stopPropagation();
    if (state.search.query) clearSearch();
    else elInput.blur();
  });
  elClear.addEventListener("click", () => {
    clearSearch();
    elInput.focus();
  });
  // another host tab was chosen: it was not asked yet, and the hits of the other hosts are not shown any more
  window.addEventListener("pibar-host-changed", () => {
    const q = state.search.query;
    if (!isSearching(q)) return;
    restart(q);
    void searchAll(q);
  });
}

/** Empty the field and show the whole list again */
export function clearSearch() {
  clearTimeout(timer);
  restart("");
  elInput.value = "";
  elClear.hidden = true;
  renderHosts();
}

/** ⌘F: into the search field (and open the left column if it is closed) */
export function focusSearch() {
  if (!elInput.offsetParent) togglePanel("left");
  elInput.focus();
  elInput.select();
}

/** Ask every shown host; each answer renders as soon as it is there, so a slow host does not hold back the others */
async function searchAll(query: string) {
  const mine = generation;
  const sel = selectedHost();
  const hosts = sel === "all" ? state.config.hosts : state.config.hosts.filter((x) => x.id === sel);
  state.search.pending = hosts.length;
  state.search.done = hosts.length === 0;
  renderHosts();
  await Promise.all(
    hosts.map(async (host) => {
      try {
        const hits = await api.searchSessions(host.id, query);
        if (mine === generation) state.search.hits.set(host.id, hits);
      } catch (e) {
        // one unreachable host must not hide what the others found
        if (mine === generation && !state.search.error) state.search.error = `${host.name}: ${errMsg(e)}`;
      }
      // a new query was typed meanwhile: this answer would show the wrong text
      if (mine !== generation) return;
      state.search.pending--;
      state.search.done = state.search.pending === 0;
      renderHosts();
    }),
  );
  if (mine === generation && state.search.error) toast(`${t("Search failed")}: ${state.search.error}`, "err");
}
