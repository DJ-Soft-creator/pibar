// Administration (admins only): hosts with their SSH data (+ connection test) and users with role and host rights.
// SSH key and known_hosts are prepared on the Docker host (webapp/README.md), not here.
import { api } from "@shared/api";
import { errMsg, h, openModal, toast } from "@shared/dom";
import { t } from "@shared/i18n";
import { hosts as hostApi, users as userApi, type HostRecord, type PublicUser, type Role } from "../rest";
import { go, state } from "../state";
import { button, confirmDialog, empty, field, header } from "../ui";
import { colorProfileSelect } from "./adminColors";

const back = () => h("button", { class: "icon-btn", "aria-label": t("Back"), onclick: () => go("more") }, "‹");

function input(value: string, attrs: Record<string, string> = {}): HTMLInputElement {
  return h("input", { type: "text", value, autocapitalize: "none", autocorrect: "off", spellcheck: "false", ...attrs });
}

// ------------------------------------------------------------------ hosts

function hostDialog(host: HostRecord | null, done: () => void) {
  const name = input(host?.name ?? "");
  const target = input(host?.sshTarget ?? "", { placeholder: "pi-vm.lan" });
  const user = input(host?.sshUser ?? "", { placeholder: "root" });
  const port = input(host?.sshPort ? String(host.sshPort) : "", { inputmode: "numeric", placeholder: "22" });
  const pi = input(host?.piCommand ?? "", { placeholder: "pi" });
  const dir = input(host?.defaultDir ?? "", { placeholder: "~" });
  const colors = colorProfileSelect(host?.colorProfile ?? "");
  const body = h(
    "div",
    { class: "form" },
    field(t("Name"), name),
    field(t("SSH target"), target, t("Host name, IP address or an alias of the container's ssh config")),
    field(t("SSH user"), user),
    field(t("Port"), port),
    field(t("Pi command"), pi),
    field(t("Default folder"), dir),
    field(t("Colour profile"), colors),
  );
  const values = () => ({
    name: name.value,
    sshTarget: target.value,
    sshUser: user.value,
    sshPort: port.value.trim() ? Number(port.value) : null,
    piCommand: pi.value,
    defaultDir: dir.value,
    colorProfile: colors.value,
  });
  const close = openModal(host ? t("Edit host") : t("Add host"), body, [
    button(t("Cancel"), () => close()),
    button(
      t("Save"),
      () => {
        (host ? hostApi.update(host.id, values()) : hostApi.create(values()))
          .then(() => {
            close();
            done();
          })
          .catch((e: unknown) => toast(errMsg(e), "err"));
      },
      "primary",
    ),
  ]);
}

export async function renderHostsAdmin(root: HTMLElement) {
  const rerender = () => void renderHostsAdmin(root);
  const reloadAll = async () => {
    state.hosts = await hostApi.list();
    rerender();
  };
  const add = button(t("Add host"), () => hostDialog(null, () => void reloadAll()), "primary");
  const cards = state.hosts.map((host) => {
    const status = h("p", { class: "muted small" });
    return h(
      "section",
      { class: "card" },
      h("h2", {}, host.name),
      h("p", { class: "mono" }, `${host.sshUser ? `${host.sshUser}@` : ""}${host.sshTarget}${host.sshPort ? `:${host.sshPort}` : ""}`),
      status,
      h(
        "div",
        { class: "row-actions" },
        button(t("Test connection"), () => {
          status.textContent = t("Testing …");
          api
            .testHost(host.id)
            .then((v) => (status.textContent = t("Connection OK: {version}", { version: v })))
            .catch((e: unknown) => {
              status.textContent = errMsg(e);
              status.classList.add("error");
            });
        }),
        button(t("Edit"), () => hostDialog(host, () => void reloadAll())),
        button(
          t("Delete"),
          () => {
            void confirmDialog(t("Delete"), t("Delete host {name}?", { name: host.name }), t("Delete")).then((yes) => {
              if (yes) hostApi.remove(host.id).then(reloadAll).catch((e: unknown) => toast(errMsg(e), "err"));
            });
          },
          "danger",
        ),
      ),
    );
  });
  root.replaceChildren(
    header(t("Hosts"), [], back()),
    ...(cards.length ? cards : [empty(t("No hosts yet."))]),
    h("div", { class: "page-actions" }, add),
  );
}

// ------------------------------------------------------------------ users

function userDialog(user: PublicUser | null, done: () => void) {
  const name = input(user?.username ?? "", { autocomplete: "off" });
  const pass = h("input", { type: "password", autocomplete: "new-password" });
  const role = h(
    "select",
    {},
    ...(["user", "admin"] as Role[]).map((r) => h("option", { value: r, selected: (user?.role ?? "user") === r }, r === "admin" ? t("Admin") : t("User"))),
  );
  const checks = state.hosts.map((host) =>
    h("label", { class: "check" }, h("input", { type: "checkbox", value: host.id, checked: user?.hostIds.includes(host.id) ?? false }), ` ${host.name}`),
  );
  const body = h(
    "div",
    { class: "form" },
    user ? null : field(t("Username"), name),
    field(user ? t("New password (empty = keep)") : t("Password"), pass),
    field(t("Role"), role),
    h("fieldset", { class: "field" }, h("legend", { class: "field-label" }, t("Hosts this user may use")), ...(checks.length ? checks : [h("p", { class: "muted" }, t("No hosts yet."))])),
  );
  const hostIds = () =>
    checks.map((c) => c.querySelector("input") as HTMLInputElement).filter((i) => i.checked).map((i) => i.value);
  const close = openModal(user ? `${t("Edit user")}: ${user.username}` : t("Add user"), body, [
    button(t("Cancel"), () => close()),
    button(
      t("Save"),
      () => {
        const r = role.value as Role;
        const call = user
          ? userApi.update(user.id, { role: r, hostIds: hostIds(), ...(pass.value ? { password: pass.value } : {}) })
          : userApi.create({ username: name.value.trim(), password: pass.value, role: r, hostIds: hostIds() });
        call
          .then(() => {
            close();
            done();
          })
          .catch((e: unknown) => toast(errMsg(e), "err"));
      },
      "primary",
    ),
  ]);
}

export async function renderUsersAdmin(root: HTMLElement) {
  const rerender = () => void renderUsersAdmin(root);
  let list: PublicUser[] = [];
  try {
    list = await userApi.list();
  } catch (e) {
    root.replaceChildren(header(t("Users"), [], back()), empty(errMsg(e)));
    return;
  }
  const hostName = (id: string) => state.hosts.find((x) => x.id === id)?.name ?? id;
  const cards = list.map((u) =>
    h(
      "section",
      { class: "card" },
      h("h2", {}, u.username),
      h(
        "p",
        { class: "muted" },
        u.role === "admin" ? `${t("Admin")} · ${t("all hosts")}` : `${t("User")} · ${u.hostIds.map(hostName).join(", ") || t("no host")}`,
      ),
      h(
        "div",
        { class: "row-actions" },
        button(t("Edit"), () => userDialog(u, rerender)),
        u.id === state.me?.user.id
          ? null
          : button(
              t("Delete"),
              () => {
                void confirmDialog(t("Delete"), t("Delete user {name}?", { name: u.username }), t("Delete")).then((yes) => {
                  if (yes) userApi.remove(u.id).then(rerender).catch((e: unknown) => toast(errMsg(e), "err"));
                });
              },
              "danger",
            ),
      ),
    ),
  );
  root.replaceChildren(
    header(t("Users"), [], back()),
    ...cards,
    h("div", { class: "page-actions" }, button(t("Add user"), () => userDialog(null, rerender), "primary")),
  );
}
