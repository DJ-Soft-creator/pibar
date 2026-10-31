// Reminders on sessions: set ("remind me later"), list at the top of the left column,
// and notify when due (system notification + highlighted entry).
import { icon } from "../shared/icons";
import { isPermissionGranted, requestPermission, sendNotification } from "@tauri-apps/plugin-notification";
import { Reminder } from "../shared/api";
import { $, h, openModal, toast } from "../shared/dom";
import { dateTime } from "../shared/format";
import { t } from "../shared/i18n";
import { activate, openSession } from "./sessions";
import { saveConfig, state } from "./state";

const elReminders = $("reminders");
const CHECK_EVERY_MS = 30_000;

export function reminderFor(key: string): Reminder | undefined {
  return (state.config.reminders ?? []).find((r) => r.key === key);
}

/** Preset times relative to now */
export function presetTimes(now = new Date()): { label: string; at: number }[] {
  const at = (d: Date) => d.getTime();
  const plusHours = (h: number) => at(new Date(now.getTime() + h * 3_600_000));
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
    { label: t("This evening (18:00)"), at: at(evening) },
    { label: t("Tomorrow 9:00"), at: at(tomorrow) },
    { label: t("Next Monday 9:00"), at: at(monday) },
  ];
}

/** Value for <input type="datetime-local"> in local time */
function toLocalInput(ts: number): string {
  const d = new Date(ts - new Date(ts).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
}

function setReminder(r: Reminder) {
  state.config.reminders = [...(state.config.reminders ?? []).filter((x) => x.key !== r.key), r];
  saveConfig();
  renderReminders();
}

export function removeReminder(key: string) {
  state.config.reminders = (state.config.reminders ?? []).filter((x) => x.key !== key);
  saveConfig();
  renderReminders();
}

/** Dialog: pick a time (preset or custom) and an optional note */
export function reminderDialog(s: { hostId: string; path: string; cwd: string; title: string }) {
  const key = `${s.hostId}|${s.path}`;
  const existing = reminderFor(key);
  const presets = presetTimes();
  const custom = h("input", {
    type: "datetime-local",
    value: toLocalInput(existing?.at ?? presets[3].at),
  }) as HTMLInputElement;
  const note = h("input", {
    type: "text",
    placeholder: t("Note (optional)"),
    value: existing?.note ?? "",
  }) as HTMLInputElement;
  const save = (at: number) => {
    if (!at || Number.isNaN(at)) return;
    setReminder({
      key,
      hostId: s.hostId,
      path: s.path,
      cwd: s.cwd,
      title: s.title,
      at,
      note: note.value.trim(),
      fired: false,
    });
    close();
    toast(t("Reminder set: {when}", { when: dateTime(at) }));
  };
  const close = openModal(
    t("Remind me later"),
    h(
      "div",
      {},
      h("p", { class: "hint" }, s.title),
      h(
        "div",
        { class: "preset-row" },
        ...presets.map((p) => h("button", { class: "ghost", onclick: () => save(p.at) }, p.label)),
      ),
      h("div", { class: "row" }, h("label", {}, t("Custom time")), custom),
      h("div", { class: "row" }, h("label", {}, t("Note")), note),
    ),
    [
      existing
        ? h("button", { class: "ghost", onclick: () => (removeReminder(key), close()) }, t("Remove reminder"))
        : null,
      h("button", { class: "ghost", onclick: () => close() }, t("Cancel")),
      h("button", { class: "primary", onclick: () => save(new Date(custom.value).getTime()) }, t("Set")),
    ].filter((x): x is HTMLButtonElement => !!x),
  );
}

/** Open the session of a reminder and remove the reminder */
async function openReminder(r: Reminder) {
  removeReminder(r.key);
  const tab = state.tabs.get(r.key);
  if (tab) activate(tab);
  else await openSession(r.hostId, r.path, r.cwd, r.title);
}

/** Reminder list at the top of the left column (hidden when empty) */
export function renderReminders() {
  const list = [...(state.config.reminders ?? [])].sort((a, b) => a.at - b.at);
  elReminders.hidden = list.length === 0;
  if (!list.length) return elReminders.replaceChildren();
  const now = Date.now();
  elReminders.replaceChildren(
    h("div", { class: "rem-head" }, t("Reminders")),
    ...list.map((r) =>
      h(
        "div",
        {
          class: `rem ${r.at <= now ? "due" : ""}`,
          role: "button",
          tabindex: 0,
          title: r.note || r.title,
          onclick: () => openReminder(r),
        },
        icon(r.at <= now ? "bell" : "clock", 14, "rem-icon"),
        h(
          "span",
          { class: "rem-text" },
          h("span", { class: "rem-title" }, r.title || t("Session")),
          h(
            "span",
            { class: "rem-meta" },
            [r.at <= now ? t("due") : dateTime(r.at), r.note].filter(Boolean).join(" · "),
          ),
        ),
        h(
          "button",
          {
            class: "sess-act",
            title: t("Remove reminder"),
            onclick: (e: MouseEvent) => {
              e.stopPropagation();
              removeReminder(r.key);
            },
          },
          icon("close", 13),
        ),
      ),
    ),
  );
}

async function notify(r: Reminder) {
  try {
    let ok = await isPermissionGranted();
    if (!ok) ok = (await requestPermission()) === "granted";
    if (ok) {
      sendNotification({ title: r.title || "PiBar", body: r.note || t("Reminder for this session is due.") });
      return;
    }
  } catch {
    /* notifications unavailable: fall back to a toast */
  }
  toast(`${t("Reminder")}: ${r.title}${r.note ? ` – ${r.note}` : ""}`, "info", 15000);
}

/** Check every 30 s for due reminders (also runs while the window is hidden) */
export function startReminderClock() {
  const check = () => {
    const due = (state.config.reminders ?? []).filter((r) => !r.fired && r.at <= Date.now());
    if (!due.length) return renderReminders();
    for (const r of due) {
      r.fired = true;
      notify(r);
    }
    saveConfig();
    renderReminders();
  };
  check();
  setInterval(check, CHECK_EVERY_MS);
}
