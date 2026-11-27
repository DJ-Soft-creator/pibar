// "More": appearance (theme, language, text size), own account (password, log out, log out everywhere) and – for
// admins – the way to the host and user management.
import { errMsg, h, openModal, toast } from "@shared/dom";
import { LANGUAGES, t } from "@shared/i18n";
import { account } from "../rest";
import { go, isAdmin, saveSettings, settings, state } from "../state";
import { button, field, header } from "../ui";

function select<V extends string>(value: V, options: [V, string][], onchange: (v: V) => void): HTMLSelectElement {
  return h(
    "select",
    { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value as V) },
    ...options.map(([v, label]) => h("option", { value: v, selected: v === value }, label)),
  );
}

function passwordDialog() {
  const cur = h("input", { type: "password", autocomplete: "current-password" });
  const next = h("input", { type: "password", autocomplete: "new-password", minlength: 8 });
  const close = openModal(
    t("Change password"),
    h(
      "div",
      { class: "form" },
      field(t("Current password"), cur),
      field(t("New password"), next, t("At least 8 characters. Other devices are logged out.")),
    ),
    [
      button(t("Cancel"), () => close()),
      button(
        t("Save"),
        () => {
          account
            .changePassword(cur.value, next.value)
            .then(() => {
              close();
              toast(t("Password changed"));
            })
            .catch((e: unknown) => toast(errMsg(e), "err"));
        },
        "primary",
      ),
    ],
  );
}

export function renderMore(root: HTMLElement, onLogout: () => void, rerender: () => void) {
  const s = settings();
  const save = (patch: Parameters<typeof saveSettings>[0]) =>
    saveSettings(patch)
      .then(rerender)
      .catch((e: unknown) => toast(errMsg(e), "err"));
  const me = state.me?.user;

  const appearance = h(
    "section",
    { class: "card" },
    h("h2", {}, t("Appearance")),
    field(
      t("Theme"),
      select(s.theme ?? "auto", [
        ["auto", t("Automatic")],
        ["light", t("Light")],
        ["dark", t("Dark")],
      ], (theme) => void save({ theme })),
    ),
    field(t("Language"), select(s.language ?? "auto", LANGUAGES.map(([v, l]) => [v, v === "auto" ? t("Automatic") : l]), (language) => void save({ language }))),
    field(
      t("Text size"),
      select(String(s.textScale ?? 100), [
        ["90", "90 %"],
        ["100", "100 %"],
        ["115", "115 %"],
        ["130", "130 %"],
      ], (v) => void save({ textScale: Number(v) })),
    ),
  );

  const accountCard = h(
    "section",
    { class: "card" },
    h("h2", {}, t("Account")),
    h("p", { class: "muted" }, `${me?.username ?? ""} · ${me?.role === "admin" ? t("Admin") : t("User")}`),
    h(
      "div",
      { class: "stack" },
      button(t("Change password"), passwordDialog),
      button(t("Desktop apps"), () => go("desktops")),
      button(t("Log out"), () => {
        account
          .logout()
          .catch(() => {})
          .finally(onLogout);
      }),
      button(
        t("Log out everywhere"),
        () => {
          account
            .logoutAll()
            .catch(() => {})
            .finally(onLogout);
        },
        "danger",
      ),
    ),
  );

  const admin = isAdmin()
    ? [
        h(
          "section",
          { class: "card" },
          h("h2", {}, t("Administration")),
          h(
            "div",
            { class: "stack" },
            button(t("Hosts"), () => go("admin/hosts")),
            button(t("Users"), () => go("admin/users")),
            button(t("Model presets"), () => go("admin/presets")),
            button(t("Quick actions"), () => go("admin/quick-actions")),
            button(t("Chat colours"), () => go("admin/colors")),
            button(t("Voice"), () => go("admin/voice")),
          ),
        ),
      ]
    : [];

  root.replaceChildren(header(t("More")), appearance, accountCard, ...admin);
}
