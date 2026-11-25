// Entry of the webapp client: check the login (/api/me), then the app shell – page area plus a tab bar at the
// bottom (Sessions · Chat · Files · More) – and the WebSocket. Routes live in the URL hash (state.ts).
import "./style.css";
import { h } from "@shared/dom";
import { t } from "@shared/i18n";
import { account, hosts, onUnauthorized } from "./rest";
import { connectSocket, type SocketHandle } from "./socket";
import { applySettings, currentRoute, go, isAdmin, state, type Route } from "./state";
import { empty, header } from "./ui";
import { renderHostsAdmin, renderUsersAdmin } from "./views/admin";
import { renderLogin } from "./views/login";
import { renderMore } from "./views/more";
import { renderSessions } from "./views/sessions";

const app = document.getElementById("app") as HTMLElement;
let socket: SocketHandle | null = null;
let page: HTMLElement | null = null;
let tabs: HTMLElement | null = null;
let offline: HTMLElement | null = null;

const TABS: { route: Route; label: () => string; icon: string }[] = [
  { route: "sessions", label: () => t("Sessions"), icon: "☰" },
  { route: "chat", label: () => t("Chat"), icon: "✎" },
  { route: "files", label: () => t("Files"), icon: "▤" },
  { route: "more", label: () => t("More"), icon: "⋯" },
];

function showLogin() {
  socket?.close();
  socket = null;
  state.me = null;
  state.sessions.clear();
  renderLogin(app, () => void boot());
}

function renderTabs() {
  if (!tabs) return;
  const route = currentRoute();
  const active: Route = route.startsWith("admin/") ? "more" : route;
  tabs.replaceChildren(
    ...TABS.map((tab) =>
      h(
        "button",
        {
          class: tab.route === active ? "tab active" : "tab",
          "aria-current": tab.route === active ? "page" : undefined,
          onclick: () => go(tab.route),
        },
        h("span", { class: "tab-icon", "aria-hidden": "true" }, tab.icon),
        h("span", { class: "tab-label" }, tab.label()),
      ),
    ),
  );
}

function renderPage() {
  if (!page) return;
  page.scrollTop = 0;
  const route = currentRoute();
  renderTabs();
  switch (route) {
    case "sessions":
      renderSessions(page);
      break;
    case "chat":
      page.replaceChildren(header(t("Chat")), empty(t("Pick a session in the list. The chat follows with the next step of the webapp.")));
      break;
    case "files":
      page.replaceChildren(header(t("Files")), empty(t("The files of a session follow with a later step of the webapp.")));
      break;
    case "more":
      renderMore(page, showLogin, renderPage);
      break;
    case "admin/hosts":
      if (isAdmin()) void renderHostsAdmin(page);
      else go("more");
      break;
    case "admin/users":
      if (isAdmin()) void renderUsersAdmin(page);
      else go("more");
      break;
  }
}

function shell() {
  page = h("div", { class: "page" });
  tabs = h("nav", { class: "tabbar", "aria-label": "Navigation" });
  offline = h("div", { class: "offline", hidden: true }, t("Connection lost – reconnecting …"));
  app.replaceChildren(h("div", { class: "shell" }, offline, page, tabs));
  renderPage();
}

async function boot() {
  try {
    state.me = await account.me();
  } catch {
    showLogin();
    return;
  }
  applySettings();
  try {
    state.hosts = await hosts.list();
  } catch {
    state.hosts = [];
  }
  shell();
  socket?.close();
  socket = connectSocket({
    onState: (open) => {
      state.online = open;
      if (offline) offline.hidden = open;
    },
  });
}

onUnauthorized(showLogin);
window.addEventListener("hashchange", renderPage);
applySettings();
void boot();
