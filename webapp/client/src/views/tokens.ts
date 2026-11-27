// "Desktop apps" (More → Account, every user): the PiBar desktop apps signed in with the own account. A desktop signs
// in with name and password (Settings → Webapp) and gets a token of this user; here it can be renamed or signed out
// (revoked). The desktop syncs the user's own session names, colours, groups and projects with it
// (src/main/configExchange.ts). REST: /api/me/tokens* (webapp/src/server/routes/tokens.ts).
import { errMsg, h, openModal, toast } from "@shared/dom";
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
  list: () => rest<ApiToken[]>("GET", "/api/me/tokens"),
  rename: (id: string, name: string) => rest<ApiToken>("PATCH", `/api/me/tokens/${encodeURIComponent(id)}`, { name }),
  revoke: (id: string) => rest("DELETE", `/api/me/tokens/${encodeURIComponent(id)}`),
};

const back = () => h("button", { class: "icon-btn", "aria-label": t("Back"), onclick: () => go("more") }, "‹");

/** Ask for a new name; the dialog stays open on an error */
function renameDialog(tok: ApiToken, reload: () => void) {
  const input = h("input", { type: "text", value: tok.name, maxlength: "64", autocomplete: "off", placeholder: t("e.g. MacBook") });
  const submit = () => {
    if (!input.value.trim()) {
      input.focus();
      return;
    }
    tokenApi
      .rename(tok.id, input.value.trim())
      .then(() => {
        close();
        reload();
      })
      .catch((e: unknown) => toast(errMsg(e), "err"));
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit();
  });
  const close = openModal(t("Rename desktop app"), h("div", { class: "form" }, field(t("Name"), input)), [
    button(t("Cancel"), () => close()),
    button(t("Save"), submit, "primary"),
  ]);
}

function tokenCard(tok: ApiToken, reload: () => void): HTMLElement {
  const used = tok.lastUsedAt ? t("last sync {when}", { when: relTime(tok.lastUsedAt) }) : t("never used");
  return h(
    "section",
    { class: "card token-card" },
    h("h2", {}, tok.name),
    h("p", { class: "muted small" }, `${t("signed in {when}", { when: relTime(tok.createdAt) })} · ${used}`),
    h(
      "div",
      { class: "row-actions" },
      button(t("Rename"), () => renameDialog(tok, reload)),
      button(
        t("Sign out"),
        () => {
          void confirmDialog(
            t("Sign out"),
            t("Sign out {name}? That desktop app stops syncing until it signs in again.", { name: tok.name }),
            t("Sign out"),
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
    root.replaceChildren(header(t("Desktop apps"), [], back()), empty(errMsg(e)));
    return;
  }
  root.replaceChildren(
    header(t("Desktop apps"), [], back()),
    h(
      "p",
      { class: "muted token-intro" },
      t(
        "A PiBar desktop app signed in with your account syncs your session names, colours, groups and projects. Sign in on the desktop under Settings → Webapp with this address:",
      ),
    ),
    h("code", { class: "mono token-url" }, location.origin),
    ...(list.length ? list.map((tok) => tokenCard(tok, reload)) : [empty(t("No desktop app signed in yet."))]),
  );
}
