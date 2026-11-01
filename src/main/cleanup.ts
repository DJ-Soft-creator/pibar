// "Tidy up": move many sessions at once into the "Archive" group (collapsed, at the end of the list), with undo.
import type { SessionMeta } from "../shared/api";
import { h, openModal, toast } from "../shared/dom";
import { t } from "../shared/i18n";
import { groups, metaOf } from "./sessionGroups";
import { renderHosts, selectedHost } from "./sessions";
import { saveConfig, state } from "./state";

/** Fixed id of the archive group */
export const ARCHIVE = "archive";

const DAY = 86_400_000;

/** The archive group, created (collapsed, without colour) on first use */
export function archiveGroup() {
  let g = groups().find((x) => x.id === ARCHIVE);
  if (!g) {
    g = { id: ARCHIVE, name: t("Archive"), color: "", collapsed: true };
    groups().push(g);
  }
  return g;
}

export interface CleanupOptions {
  /** Only sessions older than this many days (0 = all) */
  olderThanDays: number;
  /** Also sessions that are in another group */
  grouped: boolean;
  /** Also pinned sessions */
  pinned: boolean;
}

/** Keys of the sessions that would go into the archive (visible hosts; never the open or a working session) */
export function cleanupCandidates(o: CleanupOptions, now = Date.now()): string[] {
  const sel = selectedHost();
  const hosts = sel === "all" ? state.config.hosts : state.config.hosts.filter((x) => x.id === sel);
  const out: string[] = [];
  for (const host of hosts) {
    for (const s of state.sessionsByHost.get(host.id) ?? []) {
      const key = `${host.id}|${s.path}`;
      const m = metaOf(key);
      if (m.group === ARCHIVE) continue;
      if (m.pinned && !o.pinned) continue;
      if (m.group && !o.grouped) continue;
      const tab = state.tabs.get(key);
      if (tab && (tab === state.active || tab.streaming)) continue;
      const ts = Date.parse(s.timestamp);
      if (o.olderThanDays && ts && now - ts < o.olderThanDays * DAY) continue;
      out.push(key);
    }
  }
  return out;
}

/** Move the sessions into the archive; returns a function that undoes it */
export function archive(keys: string[]): () => void {
  archiveGroup();
  const all = (state.config.sessionMeta ??= {});
  const before = new Map<string, SessionMeta | undefined>(keys.map((k) => [k, all[k] ? { ...all[k] } : undefined]));
  for (const k of keys) {
    const m: SessionMeta = { ...all[k], group: ARCHIVE };
    delete m.pinned;
    all[k] = m;
  }
  saveConfig();
  renderHosts();
  return () => {
    for (const [k, m] of before) {
      if (m) all[k] = m;
      else delete all[k];
    }
    saveConfig();
    renderHosts();
  };
}

/** Dialog of the "tidy up" button: what goes into the archive, with a live count */
export function cleanupDialog() {
  const age = h(
    "select",
    {},
    h("option", { value: "0" }, t("all sessions")),
    h("option", { value: "1" }, t("older than 1 day")),
    h("option", { value: "7" }, t("older than 1 week")),
    h("option", { value: "30" }, t("older than 1 month")),
  ) as HTMLSelectElement;
  const grouped = h("input", { type: "checkbox", checked: true, style: "width:auto" }) as HTMLInputElement;
  const pinned = h("input", { type: "checkbox", style: "width:auto" }) as HTMLInputElement;
  const count = h("p", { class: "cleanup-count" });
  const go = h("button", { class: "primary" }, t("Move to archive")) as HTMLButtonElement;
  const opts = (): CleanupOptions => ({
    olderThanDays: Number(age.value),
    grouped: grouped.checked,
    pinned: pinned.checked,
  });
  const update = () => {
    const n = cleanupCandidates(opts()).length;
    count.textContent = n
      ? t("{n} sessions go into the archive.", { n })
      : t("Nothing to tidy up with these settings.");
    go.disabled = !n;
  };
  for (const el of [age, grouped, pinned]) el.addEventListener("change", update);
  go.addEventListener("click", () => {
    const keys = cleanupCandidates(opts());
    close();
    const undo = archive(keys);
    toast(t("{n} sessions moved to the archive.", { n: keys.length }), "info", 10000, {
      label: t("Undo"),
      run: undo,
    });
  });
  update();
  const close = openModal(
    t("Tidy up sessions"),
    h(
      "div",
      {},
      h("div", { class: "row" }, h("label", {}, t("Sessions")), age),
      h(
        "div",
        { class: "row" },
        h("label", {}, ""),
        h("label", { class: "check" }, grouped, ` ${t("also sessions in other groups")}`),
      ),
      h(
        "div",
        { class: "row" },
        h("label", {}, ""),
        h("label", { class: "check" }, pinned, ` ${t("also pinned sessions")}`),
      ),
      count,
      h(
        "p",
        { class: "hint" },
        t(
          "The archive is a collapsed group at the end of the list; nothing is deleted. The open session and sessions where Pi is working stay.",
        ),
      ),
    ),
    [h("button", { class: "ghost", onclick: () => close() }, t("Cancel")), go],
  );
}
