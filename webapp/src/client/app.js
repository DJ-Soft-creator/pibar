/* ------------------------------------------------------------------ */
/*  PiBar Webapp – Hauptmodul (Vanilla ES-Module, kein Framework)      */
/*  Screens: Login · Sessions · Projekte · Verwaltung (Admin)          */
/* ------------------------------------------------------------------ */

import { api, auth, openSocket, onUnauthorized } from "./api.js";
import {
  COLORS,
  COLOR_NAMES,
  colorLabel,
  el,
  clear,
  relativeTime,
  fullTime,
  sessionParts,
  store,
} from "./util.js";

const $ = (id) => document.getElementById(id);

/* ----------------------------- State ------------------------------ */

const state = {
  user: auth.getUser(),
  sessions: [],
  hosts: [], // [{id, name, kind, address, source}] – Cache für Namensauflösung
  config: null, // {sessions, projects, groups, meta} oder null (404 / noch nichts)
  status: null, // {hasConfig, receivedAt, counts}
  serverOnline: true,
  wsLive: false,
  tab: "sessions",
  filters: { search: "", color: null, group: "all", pinned: false },
  collapsed: new Set(store.get("pibar.collapsed", [])),
};

let socket = null;
let toastTimer = null;
let lastFocus = null;
let editingUser = null;
let editingHost = null;
let collapsedInitialized = false;

/* ----------------------------- Theme ------------------------------ */

const THEME_KEY = "pibar.theme";
const THEME_LABELS = { system: "System", light: "Hell", dark: "Dunkel" };
const darkQuery = matchMedia("(prefers-color-scheme: dark)");

function themeSetting() {
  try {
    const v = localStorage.getItem(THEME_KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

function applyTheme() {
  const setting = themeSetting();
  const dark = setting === "dark" || (setting === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  $("menu-theme").textContent = `Design: ${THEME_LABELS[setting]}`;
}

function cycleTheme() {
  const setting = themeSetting();
  // Erster Klick weg von "System" soll sichtbar etwas ändern.
  const next =
    setting === "system" ? (darkQuery.matches ? "light" : "dark")
    : setting === "light" ? "dark"
    : "system";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* ignorieren */
  }
  applyTheme();
}

/* --------------------------- Toast / Sheet ------------------------ */

function showToast(message, kind = "ok") {
  const t = $("toast");
  t.textContent = message;
  t.className = kind === "error" ? "toast toast-error" : "toast";
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
  }, 3500);
}

function openSheet(id) {
  lastFocus = document.activeElement;
  $("sheet-backdrop").hidden = false;
  $(id).hidden = false;
  document.body.classList.add("sheet-open");
  const closeBtn = $(id).querySelector(".icon-btn");
  if (closeBtn) closeBtn.focus();
}

function closeSheets() {
  $("sheet-backdrop").hidden = true;
  $("detail-sheet").hidden = true;
  $("user-sheet").hidden = true;
  $("host-sheet").hidden = true;
  document.body.classList.remove("sheet-open");
  editingUser = null;
  editingHost = null;
  if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
  lastFocus = null;
}

/* ------------------------- Screens / Navigation ------------------- */

function showLogin(message) {
  $("screen-app").hidden = true;
  $("screen-login").hidden = false;
  const err = $("login-error");
  err.hidden = !message;
  err.textContent = message || "";
  $("login-password").value = "";
  $("login-username").focus();
}

function enterApp() {
  $("screen-login").hidden = true;
  $("screen-app").hidden = false;
  const u = state.user || { username: "?", role: "user" };
  $("menu-username").textContent = u.username;
  $("menu-role").textContent = u.role === "admin" ? "Admin" : "Benutzer";
  $("menu-btn").textContent = (u.username || "?").trim().charAt(0).toUpperCase() || "?";
  const isAdmin = u.role === "admin";
  $("menu-admin").hidden = !isAdmin;
  $("tab-admin").hidden = !isAdmin;
  setTab(isAdmin ? state.tab : state.tab === "admin" ? "sessions" : state.tab);
  refreshAll();
  if (!socket) socket = openSocket(handleSocketEvent);
}

function setTab(tab) {
  if (tab === "admin" && state.user?.role !== "admin") tab = "sessions";
  state.tab = tab;
  for (const btn of document.querySelectorAll(".tabbar .tab")) {
    const active = btn.dataset.tab === tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  }
  $("view-sessions").hidden = tab !== "sessions";
  $("view-projects").hidden = tab !== "projects";
  $("view-admin").hidden = tab !== "admin";
  if (tab === "admin") loadAdmin();
}

function toggleMenu(force) {
  const menu = $("user-menu");
  const open = force !== undefined ? force : menu.hidden;
  menu.hidden = !open;
  $("menu-btn").setAttribute("aria-expanded", String(open));
}

/* ----------------------------- Daten laden ------------------------ */

async function loadStatus() {
  state.status = await api.configStatus();
}

async function loadSessions() {
  const data = await api.sessions();
  state.sessions = Array.isArray(data) ? data : [];
}

async function loadHosts() {
  const data = await api.hosts();
  state.hosts = Array.isArray(data) ? data : [];
}

async function loadConfig() {
  try {
    state.config = await api.config();
    // Beim ersten Mal die eingeklappten Gruppen aus der Config übernehmen.
    if (!collapsedInitialized && state.config && Array.isArray(state.config.groups)) {
      collapsedInitialized = true;
      if (store.get("pibar.collapsed", null) === null) {
        for (const g of state.config.groups) {
          if (g && g.collapsed) {
            if (g.id) state.collapsed.add("g:" + g.id);
            if (g.name) state.collapsed.add("g:" + g.name);
          }
        }
      }
    }
  } catch (err) {
    if (err.status === 404) state.config = null;
    else throw err;
  }
}

async function refreshAll() {
  const results = await Promise.allSettled([loadStatus(), loadSessions(), loadConfig(), loadHosts()]);
  const failed = results.filter((r) => r.status === "rejected");
  // Online, wenn mindestens ein Call durchkam oder ein echter HTTP-Fehler kam.
  state.serverOnline =
    failed.length < results.length || failed.some((r) => (r.reason?.status ?? 0) > 0);
  $("offline-banner").hidden = state.serverOnline;
  const realError = failed.find((r) => r.reason?.status !== 401 && r.reason?.status !== 0);
  if (realError && state.serverOnline) {
    showToast(realError.reason?.message || "Laden fehlgeschlagen", "error");
  }
  try {
    renderAll();
  } catch (err) {
    console.error("Render-Fehler:", err);
  }
}

function renderAll() {
  renderSyncStatus();
  renderGroupFilter();
  renderSessions();
  renderProjects();
  renderHosts();
}

/* ------------------------------ Hosts ----------------------------- */

function hostById(id) {
  return state.hosts.find((h) => h && h.id === id) || null;
}

function hostKindLabel(kind) {
  return kind === "ssh" ? "SSH" : "Lokal";
}

/** Host-ID -> Anzeigename; unbekannte IDs (Legacy) bleiben roh stehen. */
function hostDisplayName(id) {
  const h = hostById(id);
  return h ? h.name : id;
}

/** Host-<select> füllen: "Kein Host", alle Hosts, ggf. Legacy-Wert als Option. */
function fillHostSelect(select, current) {
  const value = current || "";
  clear(select);
  select.append(el("option", { value: "", text: "Kein Host" }));
  for (const h of state.hosts) {
    if (!h) continue;
    select.append(el("option", { value: h.id, text: `${h.name} (${hostKindLabel(h.kind)})` }));
  }
  if (value && !hostById(value)) {
    select.append(el("option", { value, text: `${value} (Legacy)` }));
  }
  select.value = value;
}

function renderHosts() {
  const list = $("host-list");
  clear(list);
  // Auswahl im Anlege-Formular aktualisieren, aktuelle Auswahl beibehalten.
  fillHostSelect($("create-host"), $("create-host").value);
  if (state.hosts.length === 0) {
    list.append(
      el("p", {
        class: "hint",
        text: "Noch keine Hosts – PiBar sendet Hosts beim nächsten Sync, oder lege manuell einen an.",
      })
    );
    return;
  }
  for (const h of state.hosts) {
    if (!h) continue;
    const synced = h.source === "pibar";
    list.append(
      el(
        "article",
        { class: "card user-card" },
        el(
          "div",
          { class: "user-info" },
          el("span", { class: "user-name", text: h.name }),
          el("span", { class: "badge", text: hostKindLabel(h.kind) }),
          el("span", { class: synced ? "badge badge-admin" : "badge", text: synced ? "PiBar" : "manuell" }),
          h.address ? el("span", { class: "user-host mono", text: h.address }) : null
        ),
        synced
          ? el("span", { class: "host-sync-hint", text: "wird von PiBar synchronisiert" })
          : el(
              "div",
              { class: "user-actions" },
              el("button", {
                class: "btn btn-small",
                type: "button",
                onclick: () => openHostEdit(h),
                text: "Bearbeiten",
              }),
              el("button", {
                class: "btn btn-small btn-danger",
                type: "button",
                onclick: () => deleteHost(h),
                text: "Löschen",
              })
            )
      )
    );
  }
}

/** Admin-Ansicht: Hosts zuerst laden (Namensauflösung), dann Benutzer. */
async function loadAdmin() {
  try {
    await loadHosts();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Hosts konnten nicht geladen werden", "error");
  }
  renderHosts();
  renderProjects();
  await loadUsers();
}

async function handleCreateHost(ev) {
  ev.preventDefault();
  const name = $("create-host-name").value.trim();
  if (!name) {
    showToast("Bitte einen Host-Namen angeben", "error");
    return;
  }
  const body = { name, kind: $("create-host-kind").value };
  const address = $("create-host-address").value.trim();
  if (address) body.address = address;
  const btn = $("host-create-submit");
  btn.disabled = true;
  try {
    await api.createHost(body);
    showToast(`Host „${name}“ angelegt`);
    $("host-create-form").reset();
    await loadAdmin();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Anlegen fehlgeschlagen", "error");
  } finally {
    btn.disabled = false;
  }
}

function openHostEdit(h) {
  editingHost = h;
  $("host-sheet-title").textContent = `„${h.name}“ bearbeiten`;
  $("edit-host-name").value = h.name || "";
  $("edit-host-kind").value = h.kind === "ssh" ? "ssh" : "local";
  $("edit-host-address").value = h.address || "";
  openSheet("host-sheet");
}

async function handleEditHost(ev) {
  ev.preventDefault();
  if (!editingHost) return;
  const name = $("edit-host-name").value.trim();
  if (!name) {
    showToast("Bitte einen Host-Namen angeben", "error");
    return;
  }
  const patch = {
    name,
    kind: $("edit-host-kind").value,
    address: $("edit-host-address").value.trim(),
  };
  const btn = $("host-edit-submit");
  btn.disabled = true;
  try {
    await api.updateHost(editingHost.id, patch);
    showToast("Host aktualisiert");
    closeSheets();
    await loadAdmin();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Speichern fehlgeschlagen", "error");
  } finally {
    btn.disabled = false;
  }
}

async function deleteHost(h) {
  if (!window.confirm(`Host „${h.name}“ wirklich löschen? Zugewiesene Benutzer behalten den Wert als Legacy-Eintrag.`)) return;
  try {
    await api.deleteHost(h.id);
    showToast(`Host „${h.name}“ gelöscht`);
    await loadAdmin();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Löschen fehlgeschlagen", "error");
  }
}

/* ----------------------------- Sync-Status ------------------------ */

function hasConfig() {
  return state.status ? !!state.status.hasConfig : state.config !== null;
}

function renderSyncStatus() {
  const dot = $("sync-dot");
  const text = $("sync-text");
  const wrap = $("sync-status");
  const has = hasConfig();
  dot.className =
    "sync-dot " +
    (!state.serverOnline ? "is-off" : has ? (state.wsLive ? "is-live" : "is-ok") : "is-none");
  if (!state.serverOnline) text.textContent = "Offline";
  else if (has && state.status?.receivedAt)
    text.textContent = "Sync " + relativeTime(state.status.receivedAt);
  else if (has) text.textContent = "Config vorhanden";
  else text.textContent = "Noch kein Sync";

  const parts = [];
  if (state.status?.receivedAt) parts.push("Letzter Sync: " + fullTime(state.status.receivedAt));
  const c = state.status?.counts;
  if (c) parts.push(`${c.sessions ?? 0} Sessions · ${c.projects ?? 0} Projekte · ${c.groups ?? 0} Gruppen`);
  parts.push(state.wsLive ? "Live-Verbindung aktiv" : "Live-Verbindung getrennt");
  wrap.title = parts.join("\n");
}

/* ----------------------------- Sessions --------------------------- */

function groupInfoFor(session) {
  const key = session.group || "";
  if (!key) return { key: "", name: "Ohne Gruppe", color: "" };
  const groups = state.config?.groups || [];
  const g = groups.find((g) => g && (g.id === key || g.name === key));
  return { key, name: g?.name || key, color: g?.color || "" };
}

function filteredSessions() {
  const f = state.filters;
  const q = f.search.trim().toLowerCase();
  return state.sessions.filter((s) => {
    if (f.pinned && !s.pinned) return false;
    if (f.color && s.color !== f.color) return false;
    if (q && !String(s.name || "").toLowerCase().includes(q)) return false;
    if (f.group !== "all") {
      const key = s.group || "";
      if (f.group === "none" ? key !== "" : key !== f.group) return false;
    }
    return true;
  });
}

function sessionRow(s) {
  const color = COLOR_NAMES.has(s.color) ? s.color : "none";
  return el(
    "button",
    { class: "session-row", type: "button", title: s.id, onclick: () => openDetail(s) },
    el("span", { class: `chip c-${color}`, "aria-hidden": "true" }),
    el("span", { class: "session-name", text: s.name || s.id }),
    s.pinned ? el("span", { class: "pin", title: "Angepinnt", text: "📌" }) : null
  );
}

function groupSection(info, items) {
  const key = "g:" + info.key;
  const collapsed = state.collapsed.has(key);
  const header = el(
    "button",
    {
      class: "group-header",
      type: "button",
      "aria-expanded": String(!collapsed),
      onclick: () => {
        if (state.collapsed.has(key)) state.collapsed.delete(key);
        else state.collapsed.add(key);
        store.set("pibar.collapsed", [...state.collapsed]);
        renderSessions();
      },
    },
    el("span", { class: collapsed ? "chevron" : "chevron open", "aria-hidden": "true", text: "▸" }),
    COLOR_NAMES.has(info.color) ? el("span", { class: `chip chip-sm c-${info.color}` }) : null,
    el("span", { class: "group-name", text: info.name }),
    el("span", { class: "count", text: String(items.length) })
  );
  const body = el("div", { class: "group-body" }, items.map(sessionRow));
  body.hidden = collapsed;
  return el("section", { class: "group" }, header, body);
}

function renderSessions() {
  const list = $("session-list");
  const empty = $("sessions-empty");
  clear(list);
  clear(empty);

  if (state.sessions.length === 0) {
    empty.hidden = false;
    if (!hasConfig()) {
      empty.append(
        el("div", { class: "empty-icon", "aria-hidden": "true", text: "📡" }),
        el("h2", { text: "Noch keine Konfiguration" }),
        el("p", {
          text:
            "Sende deine Konfiguration aus der PiBar-Desktop-App: Menü → Config Exchange. " +
            "Sobald sie hier ankommt, erscheint die Session-Liste automatisch.",
        })
      );
    } else {
      empty.append(
        el("div", { class: "empty-icon", "aria-hidden": "true", text: "🗂️" }),
        el("h2", { text: "Keine Sessions" }),
        el("p", { text: "Die synchronisierte Konfiguration enthält keine Sessions." })
      );
    }
    return;
  }

  const sessions = filteredSessions();
  if (sessions.length === 0) {
    empty.hidden = false;
    empty.append(
      el("div", { class: "empty-icon", "aria-hidden": "true", text: "🔍" }),
      el("h2", { text: "Keine Treffer" }),
      el("p", { text: "Für die aktuellen Filter gibt es keine Sessions." }),
      el("button", { class: "btn", type: "button", onclick: resetFilters, text: "Filter zurücksetzen" })
    );
    return;
  }
  empty.hidden = true;

  const pinned = sessions.filter((s) => s.pinned);
  const rest = sessions.filter((s) => !s.pinned);

  if (pinned.length > 0) {
    list.append(
      el(
        "section",
        { class: "group" },
        el(
          "div",
          { class: "group-header static" },
          el("span", { class: "pin", "aria-hidden": "true", text: "📌" }),
          el("span", { class: "group-name", text: "Angepinnt" }),
          el("span", { class: "count", text: String(pinned.length) })
        ),
        el("div", { class: "group-body" }, pinned.map(sessionRow))
      )
    );
  }

  // Gruppieren; Reihenfolge: Config-Gruppen, dann weitere alphabetisch, "Ohne Gruppe" zuletzt.
  const buckets = new Map();
  for (const s of rest) {
    const info = groupInfoFor(s);
    if (!buckets.has(info.key)) buckets.set(info.key, { info, items: [] });
    buckets.get(info.key).items.push(s);
  }
  const order = [];
  for (const g of state.config?.groups || []) {
    if (!g) continue;
    for (const key of buckets.keys()) {
      if ((key === g.id || key === g.name) && !order.includes(key)) order.push(key);
    }
  }
  const extra = [...buckets.keys()]
    .filter((k) => k !== "" && !order.includes(k))
    .sort((a, b) => a.localeCompare(b, "de"));
  order.push(...extra);
  if (buckets.has("")) order.push("");
  for (const key of order) {
    const b = buckets.get(key);
    list.append(groupSection(b.info, b.items));
  }
}

/* ------------------------------ Filter ---------------------------- */

function buildColorFilters() {
  const row = $("color-filters");
  for (const c of COLORS) {
    row.append(
      el(
        "button",
        {
          class: "color-filter",
          type: "button",
          title: c.label,
          "aria-label": `Nach Farbe ${c.label} filtern`,
          "aria-pressed": "false",
          dataset: { color: c.name },
          onclick: () => {
            state.filters.color = state.filters.color === c.name ? null : c.name;
            renderColorFilters();
            renderSessions();
          },
        },
        el("span", { class: `chip c-${c.name}` })
      )
    );
  }
}

function renderColorFilters() {
  for (const btn of $("color-filters").children) {
    const active = btn.dataset.color === state.filters.color;
    btn.setAttribute("aria-pressed", String(active));
  }
}

function renderGroupFilter() {
  const select = $("group-filter");
  const keys = new Map();
  for (const s of state.sessions) {
    if (s.group) keys.set(s.group, groupInfoFor(s).name);
  }
  const hasUngrouped = state.sessions.some((s) => !s.group);
  clear(select);
  select.append(el("option", { value: "all", text: "Alle Gruppen" }));
  const sorted = [...keys.entries()].sort((a, b) => a[1].localeCompare(b[1], "de"));
  for (const [key, name] of sorted) select.append(el("option", { value: key, text: name }));
  if (hasUngrouped) select.append(el("option", { value: "none", text: "Ohne Gruppe" }));
  const current = state.filters.group;
  select.value = [...select.options].some((o) => o.value === current) ? current : "all";
  state.filters.group = select.value;
}

function resetFilters() {
  state.filters = { search: "", color: null, group: "all", pinned: false };
  $("search-input").value = "";
  $("pinned-filter").setAttribute("aria-pressed", "false");
  renderColorFilters();
  renderGroupFilter();
  renderSessions();
}

/* --------------------------- Detail-Sheet ------------------------- */

function detailRow(label, value) {
  return el(
    "div",
    { class: "detail-row" },
    el("span", { class: "detail-label", text: label }),
    el("span", { class: "detail-value" }, value)
  );
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast("Kopiert");
    return;
  } catch {
    /* Fallback für unsichere Kontexte (http im LAN) */
  }
  try {
    const ta = el("textarea", { class: "visually-hidden" });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    showToast(ok ? "Kopiert" : "Kopieren nicht möglich", ok ? "ok" : "error");
  } catch {
    showToast("Kopieren nicht möglich", "error");
  }
}

function openDetail(s) {
  const parts = sessionParts(s.id);
  const info = groupInfoFor(s);
  const projects = state.config?.projects || [];
  const project = projects.find((p) => {
    if (!p || p.hostId !== parts.hostId || !parts.dir || !p.dir) return false;
    const base = String(p.dir).replace(/\/+$/, "");
    return parts.dir === base || parts.dir.startsWith(base + "/");
  });
  const color = COLOR_NAMES.has(s.color) ? s.color : "none";

  $("detail-title").textContent = s.name || "Session";
  const body = $("detail-body");
  clear(body);
  body.append(
    detailRow(
      "Farbe",
      el("span", { class: "detail-color" }, el("span", { class: `chip c-${color}` }), colorLabel(s.color))
    ),
    detailRow("Gruppe", info.name),
    detailRow("Angepinnt", s.pinned ? "Ja" : "Nein"),
    detailRow("Host", parts.hostId ? hostDisplayName(parts.hostId) : "–"),
    project ? detailRow("Projekt", project.name || project.id) : null,
    detailRow("Verzeichnis", el("span", { class: "mono", text: parts.dir || "–" })),
    detailRow("Datei", el("span", { class: "mono", text: parts.file || "–" })),
    detailRow(
      "Vollständige ID",
      el(
        "span",
        { class: "id-line" },
        el("span", { class: "mono", text: s.id }),
        el("button", {
          class: "btn btn-small",
          type: "button",
          onclick: () => copyText(s.id),
          text: "Kopieren",
        })
      )
    ),
    el("p", {
      class: "hint",
      text: "Schreibgeschützt – die Chat-Funktion folgt in einer späteren Version.",
    })
  );
  openSheet("detail-sheet");
}

/* ------------------------------ Projekte -------------------------- */

function renderProjects() {
  const list = $("project-list");
  const empty = $("projects-empty");
  clear(list);
  clear(empty);
  const projects = state.config?.projects || [];
  empty.hidden = projects.length > 0;
  if (projects.length === 0) {
    empty.append(
      el("div", { class: "empty-icon", "aria-hidden": "true", text: "📁" }),
      el("h2", { text: "Keine Projekte" }),
      el("p", {
        text:
          "Sobald PiBar eine Konfiguration sendet (Menü → Config Exchange), " +
          "erscheinen hier die Projekte.",
      })
    );
    return;
  }
  for (const p of projects) {
    if (!p) continue;
    list.append(
      el(
        "article",
        { class: "card project-card" },
        el(
          "div",
          { class: "project-head" },
          el("h3", { class: "project-name", text: p.name || p.id || "Unbenannt" }),
          el("span", { class: "badge", text: p.hostId ? hostDisplayName(p.hostId) : "?" })
        ),
        el("p", { class: "mono project-dir", text: p.dir || "" })
      )
    );
  }
}

/* --------------------------- Verwaltung (Admin) ------------------- */

async function loadUsers() {
  const list = $("user-list");
  try {
    const users = await api.users();
    clear(list);
    const arr = Array.isArray(users) ? users : [];
    if (arr.length === 0) {
      list.append(el("p", { class: "hint", text: "Keine Benutzer vorhanden." }));
      return;
    }
    for (const u of arr) {
      if (!u) continue;
      const isSelf = u.username === state.user?.username;
      list.append(
        el(
          "article",
          { class: "card user-card" },
          el(
            "div",
            { class: "user-info" },
            el("span", { class: "user-name", text: u.username }),
            el("span", {
              class: u.role === "admin" ? "badge badge-admin" : "badge",
              text: u.role === "admin" ? "Admin" : "Benutzer",
            }),
            el("span", {
              class: "user-host",
              text: u.host ? (hostById(u.host) ? hostDisplayName(u.host) : `${u.host} (Legacy)`) : "–",
            })
          ),
          el(
            "div",
            { class: "user-actions" },
            el("button", {
              class: "btn btn-small",
              type: "button",
              onclick: () => openUserEdit(u),
              text: "Bearbeiten",
            }),
            el("button", {
              class: "btn btn-small btn-danger",
              type: "button",
              disabled: isSelf,
              title: isSelf ? "Das eigene Konto kann nicht gelöscht werden" : "",
              onclick: () => deleteUser(u),
              text: "Löschen",
            })
          )
        )
      );
    }
  } catch (err) {
    if (err.status === 403) showToast("Keine Berechtigung für die Benutzerverwaltung", "error");
    else if (err.status !== 401) showToast(err.message || "Benutzer konnten nicht geladen werden", "error");
  }
}

async function handleCreateUser(ev) {
  ev.preventDefault();
  const username = $("create-username").value.trim();
  const password = $("create-password").value;
  const role = $("create-role").value;
  const host = $("create-host").value;
  if (!username || !password) {
    showToast("Bitte Benutzername und Passwort angeben", "error");
    return;
  }
  const btn = $("create-submit");
  btn.disabled = true;
  try {
    const body = { username, password, role };
    if (host) body.host = host;
    await api.createUser(body);
    showToast(`Benutzer „${username}“ angelegt`);
    $("user-create-form").reset();
    await loadUsers();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Anlegen fehlgeschlagen", "error");
  } finally {
    btn.disabled = false;
  }
}

function openUserEdit(u) {
  editingUser = u;
  $("user-sheet-title").textContent = `„${u.username}“ bearbeiten`;
  fillHostSelect($("edit-host"), u.host || "");
  $("edit-role").value = u.role === "admin" ? "admin" : "user";
  $("edit-password").value = "";
  openSheet("user-sheet");
}

async function handleEditUser(ev) {
  ev.preventDefault();
  if (!editingUser) return;
  const patch = {
    host: $("edit-host").value,
    role: $("edit-role").value,
  };
  const pw = $("edit-password").value;
  if (pw) patch.password = pw;
  const btn = $("user-edit-submit");
  btn.disabled = true;
  try {
    await api.updateUser(editingUser.id, patch);
    showToast("Benutzer aktualisiert");
    closeSheets();
    await loadUsers();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Speichern fehlgeschlagen", "error");
  } finally {
    btn.disabled = false;
  }
}

async function deleteUser(u) {
  if (!window.confirm(`Benutzer „${u.username}“ wirklich löschen?`)) return;
  try {
    await api.deleteUser(u.id);
    showToast(`Benutzer „${u.username}“ gelöscht`);
    await loadUsers();
  } catch (err) {
    if (err.status !== 401) showToast(err.message || "Löschen fehlgeschlagen", "error");
  }
}

/* ------------------------------ Auth ------------------------------ */

async function handleLogin(ev) {
  ev.preventDefault();
  const username = $("login-username").value.trim();
  const password = $("login-password").value;
  const errEl = $("login-error");
  if (!username || !password) {
    errEl.hidden = false;
    errEl.textContent = "Bitte Benutzername und Passwort eingeben.";
    return;
  }
  const btn = $("login-submit");
  btn.disabled = true;
  btn.textContent = "Anmelden …";
  errEl.hidden = true;
  try {
    const data = await api.login(username, password);
    auth.setSession(data.token, {
      username: data.username || username,
      role: data.role === "admin" ? "admin" : "user",
    });
    state.user = auth.getUser();
    $("login-password").value = "";
    enterApp();
  } catch (err) {
    errEl.hidden = false;
    errEl.textContent =
      err.status === 401
        ? err.serverMessage || "Benutzername oder Passwort falsch."
        : err.message || "Anmeldung fehlgeschlagen.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Anmelden";
  }
}

function leaveApp(message) {
  if (socket) {
    socket.close();
    socket = null;
  }
  state.user = null;
  state.sessions = [];
  state.hosts = [];
  state.config = null;
  state.status = null;
  state.wsLive = false;
  state.tab = "sessions";
  closeSheets();
  toggleMenu(false);
  showLogin(message);
}

async function handleLogout() {
  try {
    await api.logout();
  } catch {
    /* Logout ist best effort – lokal wird immer abgemeldet. */
  }
  auth.clearSession();
  leaveApp();
}

/* ----------------------------- WebSocket -------------------------- */

function handleSocketEvent(msg) {
  if (msg.type === "ws/open") {
    state.wsLive = true;
    renderSyncStatus();
    // Nach (Re-)Connect verpasste Updates holen: Sessions + Config + Status.
    refreshAll();
    return;
  }
  if (msg.type === "ws/close") {
    state.wsLive = false;
    renderSyncStatus();
    return;
  }
  if (msg.type === "config/updated") {
    refreshAll();
  }
}

/* ------------------------------ Events ---------------------------- */

function bindEvents() {
  $("login-form").addEventListener("submit", handleLogin);

  $("menu-btn").addEventListener("click", () => toggleMenu());
  $("menu-theme").addEventListener("click", () => {
    cycleTheme();
  });
  $("menu-admin").addEventListener("click", () => {
    toggleMenu(false);
    setTab("admin");
  });
  $("menu-logout").addEventListener("click", handleLogout);

  for (const btn of document.querySelectorAll(".tabbar .tab")) {
    btn.addEventListener("click", () => setTab(btn.dataset.tab));
  }

  $("search-input").addEventListener("input", () => {
    state.filters.search = $("search-input").value;
    renderSessions();
  });
  $("group-filter").addEventListener("change", () => {
    state.filters.group = $("group-filter").value;
    renderSessions();
  });
  $("pinned-filter").addEventListener("click", () => {
    state.filters.pinned = !state.filters.pinned;
    $("pinned-filter").setAttribute("aria-pressed", String(state.filters.pinned));
    renderSessions();
  });

  $("sheet-backdrop").addEventListener("click", closeSheets);
  $("detail-close").addEventListener("click", closeSheets);
  $("user-edit-close").addEventListener("click", closeSheets);
  $("host-edit-close").addEventListener("click", closeSheets);

  $("user-create-form").addEventListener("submit", handleCreateUser);
  $("user-edit-form").addEventListener("submit", handleEditUser);
  $("host-create-form").addEventListener("submit", handleCreateHost);
  $("host-edit-form").addEventListener("submit", handleEditHost);

  document.addEventListener("click", (ev) => {
    if (!$("user-menu").hidden && !ev.target.closest(".menu-wrap")) toggleMenu(false);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape") {
      toggleMenu(false);
      closeSheets();
    }
  });

  if (typeof darkQuery.addEventListener === "function") {
    darkQuery.addEventListener("change", () => {
      if (themeSetting() === "system") applyTheme();
    });
  }
}

/* ------------------------------ Start ----------------------------- */

function init() {
  applyTheme();
  buildColorFilters();
  bindEvents();
  onUnauthorized(() => leaveApp("Sitzung abgelaufen – bitte erneut anmelden."));
  if (auth.getToken() && state.user) enterApp();
  else showLogin();
  setInterval(renderSyncStatus, 30000);
}

init();