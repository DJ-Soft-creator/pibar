// Actions behind the webapp sync entries (src/main/configExchangeMenu.ts, settings.ts): the sign-in dialog (webapp
// address, user name, password), sign-out, the account block of the settings, "Sync now" with feedback, the
// auto-sync toggle, and the text of the last sync result.
import { errMsg, h, openModal, toast } from "../shared/dom";
import { relTime } from "../shared/format";
import { t } from "../shared/i18n";
import {
  autoSyncEnabled,
  onSyncResult,
  setAutoSyncEnabled,
  signedIn,
  signIn,
  signOut,
  syncNow,
  webappUrl,
  webappUser,
  type SyncResult,
} from "./configExchange";

/** One line about a sync result for the settings and toasts */
export function syncResultText(r: SyncResult | null): string {
  if (!r) return t("Not synced yet.");
  const when = relTime(r.at);
  if (!r.ok) return t("Last sync {when} failed: {error}", { when, error: r.error ?? "" });
  let s = t("Last sync {when}: {updated} received, {removed} removed.", {
    when,
    updated: r.updated ?? 0,
    removed: r.removed ?? 0,
  });
  if (r.unmatched?.length) s += ` ${t("Not in the webapp: {hosts}", { hosts: r.unmatched.join(", ") })}`;
  return s;
}

/** Who this desktop is signed in as, in one line */
export function accountText(): string {
  return signedIn()
    ? t("Signed in as {user} at {url}.", { user: webappUser() || "?", url: webappUrl() })
    : t("Not signed in.");
}

const accountListeners = new Set<() => void>();
const accountChanged = () => {
  for (const cb of accountListeners) cb();
};

/** Follow sign-in and sign-out (the settings redraw their account block); returns the unsubscribe function */
export function onAccountChange(cb: () => void): () => void {
  accountListeners.add(cb);
  return () => accountListeners.delete(cb);
}

/** Ask for the webapp address, user name and password; signs in and syncs once */
export function signInDialog() {
  const url = h("input", {
    type: "url",
    value: webappUrl(),
    placeholder: "http://192.168.1.20:8787",
    spellcheck: "false",
  }) as HTMLInputElement;
  const user = h("input", {
    type: "text",
    value: webappUser(),
    autocomplete: "username",
    autocapitalize: "off",
    spellcheck: "false",
  }) as HTMLInputElement;
  const password = h("input", { type: "password", autocomplete: "current-password" }) as HTMLInputElement;
  const error = h("p", { class: "hint", style: "color: var(--danger)" });
  const go = h("button", { class: "primary" }, t("Sign in")) as HTMLButtonElement;
  const submit = async () => {
    const missing = [url, user, password].find((i) => !i.value.trim());
    if (missing) {
      missing.focus();
      return;
    }
    go.disabled = true;
    error.textContent = "";
    try {
      const name = await signIn(url.value, user.value, password.value);
      close();
      accountChanged();
      toast(t("Signed in as {user}.", { user: name }));
      void syncWithFeedback();
    } catch (e) {
      error.textContent = errMsg(e);
      password.select();
    } finally {
      go.disabled = false;
    }
  };
  go.addEventListener("click", () => void submit());
  for (const i of [url, user, password]) {
    i.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void submit();
    });
  }
  const close = openModal(
    t("Sign in to the webapp"),
    h(
      "div",
      {},
      h("p", { class: "hint" }, t("Address of the mobile webapp.")),
      url,
      h("p", { class: "hint" }, t("Username")),
      user,
      h("p", { class: "hint" }, t("Password")),
      password,
      h(
        "p",
        { class: "hint" },
        t(
          "Your user of the webapp. The password is not stored; this desktop gets its own sign-in, which you can end in the webapp (More → Desktop apps).",
        ),
      ),
      error,
    ),
    [h("button", { class: "ghost", onclick: () => close() }, t("Cancel")), go],
  );
  (url.value ? (user.value ? password : user) : url).focus();
}

/** Sign out after asking; the automatic sync stops with it */
export async function signOutWithFeedback() {
  await signOut();
  accountChanged();
  toast(t("Signed out of the webapp."));
}

/** The account block of the settings: who is signed in, sign in / sign out; redraws itself */
export function accountBlock(): { el: HTMLElement; dispose: () => void } {
  const el = h("div", {});
  const draw = () => {
    const status = h("p", { class: "hint", "data-testid": "webapp-account" }, accountText());
    const action = signedIn()
      ? h("button", { class: "ghost", onclick: () => void signOutWithFeedback() }, t("Sign out"))
      : h("button", { class: "primary", onclick: signInDialog }, t("Sign in…"));
    const change = signedIn() ? [h("button", { class: "ghost", onclick: signInDialog }, t("Change user…"))] : [];
    el.replaceChildren(status, h("div", { class: "row" }, action, ...change));
  };
  draw();
  // a background sync forgets a revoked sign-in
  const offSync = onSyncResult(draw);
  const offAccount = onAccountChange(draw);
  return {
    el,
    dispose: () => {
      offSync();
      offAccount();
    },
  };
}

/** Flip the auto-sync; turning it on syncs once right away (with feedback) */
export function toggleAutoSync() {
  const on = !autoSyncEnabled();
  setAutoSyncEnabled(on);
  if (on) void syncWithFeedback();
}

/** Sync now and say how it went; opens the sign-in when this desktop is not signed in */
export async function syncWithFeedback(): Promise<SyncResult | null> {
  if (!signedIn()) {
    toast(t("Not signed in to the webapp."), "err");
    signInDialog();
    return null;
  }
  try {
    const r = await syncNow();
    toast(syncResultText(r), r.ok ? "info" : "err");
    // a revoked sign-in is forgotten by the sync: show it
    if (!signedIn()) accountChanged();
    return r;
  } catch (e) {
    toast(`${t("Sync failed")}: ${errMsg(e)}`, "err");
    return null;
  }
}
