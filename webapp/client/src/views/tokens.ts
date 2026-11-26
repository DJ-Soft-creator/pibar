// API tokens for desktop apps (task I3, admins only): create one per desktop (the secret is shown exactly once),
// rename, revoke. The desktop syncs session names, colours, groups and projects with it (POST /api/sync/meta,
// src/main/configExchange.ts). REST: /api/tokens* (webapp/src/server/routes/tokens.ts).
import { copyText, errMsg, h, openModal, toast } from "@shared/dom";
import { relTime } from "@shared/format";
import { t } from "@shared/i18n";
import { rest } from "../rest";
import { go } from "../state";
import { button, confirmDialog, empty, field, header } from "../ui";
import "./tokens.css";

interface ApiToken {
  id: string;
  name: string;
  hint: string;
  createdAt: number;
  lastUsedAt: number | null;
}

const tokenApi = {
  list: () => rest<ApiToken[]>("GET", "/api/tokens"),
  create: (name: string) => rest<{ token: ApiToken; secret: string }>("POST", "/api/tokens", { name }),
  rename: (id: string, name: string) => rest<ApiToken>("PATCH", `/api/tokens/${encodeURIComponent(id)}`, { name }),
  revoke: (id: string) => rest("DELETE", `/api/tokens/${encodeURIComponent(id)}`),
};

const back = () => h("button", { class: "icon-btn", "aria-label": t("Back"), onclick: () => go("more") }, "‹");

function nameInput(value: string): HTMLInputElement {
  return h("input", { type: "text", value, maxlength: "64", autocomplete: "off", placeholder: t("e.g. MacBook") });
}

/** Ask for a name; `save` returns a promise, the dialog stays open on an error */
function nameDialog(title: string, value: string, yes: string, save: (name: string) => Promise<unknown>) {
  const input = nameInput(value);
  const submit = () => {
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    save(input.value.trim())
      .then(() => close())
      .catch((e: unknown) => toast(errMsg(e), "err"));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  const close = openModal(title, h("div", { class: "form" }, field(t("Name"), input)), [
    button(t("Cancel"), () => close()),
    button(yes, submit, "primary"),
  ]);
}

/** The new secret, once: copy it now, it cannot be shown again */
function showSecret(token: ApiToken, secret: string) {
  const copy = button(t("Copy"), () => {
    copyText(secret)
      .then(() => toast(t("Copied")))
      .catch((e: unknown) => toast(errMsg(e), "err"));
  });
  const body = h(
    "div",
    { class: "form token-secret" },
    h("p", { class: "token-warn" }, t("Copy the token now – it is shown only this once.")),
    h("code", { class: "mono token-value", "data-testid": "token-secret" }, secret),
    copy,
    h(
      "p",
      { class: "muted small" },
      t("In the desktop app: Settings → Webapp. Enter this address and the token there:"),
    ),
    h("code", { class: "mono token-url" }, location.origin),
  );
  const close = openModal(t("Token for {name}", { name: token.name }), body, [button(t("Done"), () => close(), "primary")]);
}

function tokenCard(tok: ApiToken, reload: () => void): HTMLElement {
  const used = tok.lastUsedAt ? t("last sync {when}", { when: relTime(tok.lastUsedAt) }) : t("never used");
  return h(
    "section",
    { class: "card token-card" },
    h("h2", {}, tok.name),
    h("p", { class: "muted small" }, h("span", { class: "mono" }, `${tok.hint}…`), ` · ${t("created {when}", { when: relTime(tok.createdAt) })} · ${used}`),
    h(
      "div",
      { class: "row-actions" },
      button(t("Rename"), () =>
        nameDialog(t("Rename token"), tok.name, t("Save"), (name) => tokenApi.rename(tok.id, name).then(reload)),
      ),
      button(
        t("Revoke"),
        () => {
          void confirmDialog(
            t("Revoke"),
            t("Revoke the token {name}? The desktop app using it can no longer sync.", { name: tok.name }),
            t("Revoke"),
          ).then((yes) => {
            if (yes) tokenApi.revoke(tok.id).then(reload).catch((e: unknown) => toast(errMsg(e), "err"));
          });
        },
        "danger",
      ),
    ),
  );
}

export async function renderTokens(root: HTMLElement) {
  const reload = () => void renderTokens(root);
  let list: ApiToken[];
  try {
    list = await tokenApi.list();
  } catch (e) {
    root.replaceChildren(header(t("Desktop app tokens"), [], back()), empty(errMsg(e)));
    return;
  }
  const create = button(
    t("Create token"),
    () =>
      nameDialog(t("New token"), "", t("Create"), (name) =>
        tokenApi.create(name).then(({ token, secret }) => {
          reload();
          showSecret(token, secret);
        }),
      ),
    "primary",
  );
  root.replaceChildren(
    header(t("Desktop app tokens"), [], back()),
    h(
      "p",
      { class: "muted token-intro" },
      t(
        "A PiBar desktop app syncs names, colours, groups and projects of the sessions with the webapp. Create one token per desktop app.",
      ),
    ),
    ...(list.length ? list.map((tok) => tokenCard(tok, reload)) : [empty(t("No tokens yet."))]),
    h("div", { class: "page-actions" }, create),
  );
}
