// Login screen: username + password; on success the session cookie is set and the app starts.
import { errMsg, h } from "@shared/dom";
import { t } from "@shared/i18n";
import { account } from "../rest";

export function renderLogin(root: HTMLElement, onDone: () => void) {
  const user = h("input", { type: "text", autocomplete: "username", autocapitalize: "none", required: true });
  const pass = h("input", { type: "password", autocomplete: "current-password", required: true });
  const error = h("p", { class: "error", role: "alert" });
  const submit = h("button", { type: "submit", class: "btn primary block" }, t("Log in"));
  const form = h(
    "form",
    {
      class: "login-card",
      onsubmit: (e: SubmitEvent) => {
        e.preventDefault();
        error.textContent = "";
        submit.disabled = true;
        account
          .login(user.value.trim(), pass.value)
          .then(() => onDone())
          .catch((err: unknown) => {
            const msg = errMsg(err);
            error.textContent = msg === "Invalid credentials" ? t("Wrong username or password") : msg;
            pass.select();
          })
          .finally(() => (submit.disabled = false));
      },
    },
    h("img", { src: "/icon-192.png", alt: "", class: "login-logo" }),
    h("h1", {}, "PiBar"),
    h("label", { class: "field" }, h("span", { class: "field-label" }, t("Username")), user),
    h("label", { class: "field" }, h("span", { class: "field-label" }, t("Password")), pass),
    error,
    submit,
  );
  root.replaceChildren(h("main", { class: "login-screen" }, form));
  user.focus();
}
