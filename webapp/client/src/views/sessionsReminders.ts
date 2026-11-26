// Reminders on sessions (task H6, like src/main/reminders.ts): set or clear with date, time and note, stored in the
// session metadata as remindAt (ms) and remindNote – shared with the extras area's web push. The list of reminders
// sits at the top of the session list, due ones highlighted; tapping one opens the session and clears it.
import { h, openModal, toast } from "@shared/dom";
import { cleanTitle, dateTime } from "@shared/format";
import { t } from "@shared/i18n";
import { button } from "../ui";
import { data, isCollapsed, keyOf, sessionOf, setMeta, splitKey, titleOf, toggleCollapsed } from "./sessionsData";
import { openRow } from "./sessionsRows";
import { run } from "./sessionsUi";

/** Preset times relative to now (same as the desktop) */
export function presetTimes(now = new Date()): { label: string; at: number }[] {
  const plusHours = (n: number) => now.getTime() + n * 3_600_000;
  const evening = new Date(now);
  evening.setHours(18, 0, 0, 0);
  if (evening <= now) evening.setDate(evening.getDate() + 1);
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  tomorrow.setHours(9, 0, 0, 0);
  const monday = new Date(now);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  monday.setHours(9, 0, 0, 0);
  return [
    { label: t("In 1 hour"), at: plusHours(1) },
    { label: t("In 3 hours"), at: plusHours(3) },
    { label: t("This evening (18:00)"), at: evening.getTime() },
    { label: t("Tomorrow 9:00"), at: tomorrow.getTime() },
    { label: t("Next Monday 9:00"), at: monday.getTime() },
  ];
}

/** Value for <input type="datetime-local"> in local time */
function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

export function clearReminder(key: string) {
  return setMeta(key, { remindAt: 0, remindNote: "" });
}

/** Dialog: a preset or an own date and time, plus an optional note */
export function reminderDialog(key: string, title: string) {
  const m = data.meta.sessionMeta[key] ?? {};
  const presets = presetTimes();
  const custom = h("input", { type: "datetime-local", class: "sl-datetime", value: toLocalInput(m.remindAt || (presets[3]?.at ?? Date.now())) });
  const note = h("input", { type: "text", placeholder: t("Note (optional)"), value: m.remindNote ?? "", maxlength: 300 });
  const save = (at: number) => {
    if (!at || Number.isNaN(at)) return;
    close();
    run(async () => {
      await setMeta(key, { remindAt: at, remindNote: note.value.trim() });
      toast(t("Reminder set: {when}", { when: dateTime(at) }));
    });
  };
  const close = openModal(
    m.remindAt ? t("Change reminder") : t("Remind me later"),
    h(
      "div",
      { class: "form" },
      h("p", { class: "hint" }, title),
      h(
        "div",
        { class: "sl-presets" },
        ...presets.map((p) => h("button", { type: "button", class: "btn", onclick: () => save(p.at) }, p.label)),
      ),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Custom time")), custom),
      h("label", { class: "field" }, h("span", { class: "field-label" }, t("Note")), note),
    ),
    [
      m.remindAt
        ? button(t("Remove reminder"), () => {
            close();
            run(() => clearReminder(key));
          }, "danger")
        : null,
      button(t("Cancel"), () => close()),
      button(t("Set"), () => save(new Date(custom.value).getTime()), "primary"),
    ].filter((x): x is HTMLButtonElement => !!x),
  );
}

interface Due {
  key: string;
  at: number;
  note: string;
  title: string;
}

/** Reminders of the hosts the user may use, earliest first */
export function reminders(): Due[] {
  const out: Due[] = [];
  for (const [key, m] of Object.entries(data.meta.sessionMeta)) {
    if (!m.remindAt) continue;
    const { hostId, path } = splitKey(key);
    const s = sessionOf(key);
    const title = s ? titleOf(hostId, s) : m.name || path.split("/").pop() || path;
    out.push({ key, at: m.remindAt, note: m.remindNote ?? "", title: cleanTitle(title) });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** The block at the top of the list (null without reminders); a closed block still shows how many are due */
export function remindersBlock(now = Date.now()): HTMLElement | null {
  const list = reminders();
  if (!list.length) return null;
  const due = list.filter((r) => r.at <= now).length;
  const closed = isCollapsed("rem");
  return h(
    "section",
    { class: `sl-block sl-rems ${due ? "has-due" : ""} ${closed ? "collapsed" : ""}` },
    h(
      "button",
      { type: "button", class: "sl-block-head", "aria-expanded": closed ? "false" : "true", onclick: () => toggleCollapsed("rem") },
      h("span", { class: "sl-chev" }, "▾"),
      h("span", { class: "sl-block-name" }, t("Reminders")),
      due ? h("span", { class: "sl-mark due" }, `${t("due")}: ${due}`) : null,
      h("span", { class: "sl-count" }, String(list.length)),
    ),
    ...(closed
      ? []
      : list.map((r) => {
          const isDue = r.at <= now;
          const open = () => {
            const { hostId, path } = splitKey(r.key);
            const s = sessionOf(r.key) ?? { path, cwd: "~", name: null, title: r.title, id: "", timestamp: "", parent: null, modified: 0 };
            run(() => clearReminder(r.key));
            openRow({ key: keyOf(hostId, path), hostId, s });
          };
          return h(
            "div",
            { class: `sl-rem ${isDue ? "due" : ""}`, role: "button", tabindex: 0, onclick: open },
            h("span", { class: "sl-rem-icon", "aria-hidden": "true" }, isDue ? "🔔" : "⏰"),
            h(
              "span",
              { class: "sl-rem-text" },
              h("span", { class: "sl-rem-title" }, r.title || t("Session")),
              h("span", { class: "sl-rem-meta" }, [isDue ? t("due") : dateTime(r.at), r.note].filter(Boolean).join(" · ")),
            ),
            h(
              "button",
              {
                type: "button",
                class: "sl-more",
                title: t("Remove reminder"),
                "aria-label": t("Remove reminder"),
                onclick: (e: MouseEvent) => {
                  e.stopPropagation();
                  run(() => clearReminder(r.key));
                },
              },
              "×",
            ),
          );
        })),
  );
}
