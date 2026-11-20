// Terminal at the very bottom of the chat column, under the input (VS Code style): one shell per tab,
// locally or on the SSH host of the active session.
// The Rust core owns the pty (src-tauri/src/terminal.rs); xterm.js renders the bytes and sends keys back.
import { listen } from "@tauri-apps/api/event";
import type { Terminal as XTerm } from "@xterm/xterm";
import type { FitAddon as XTermFit } from "@xterm/addon-fit";
import { api } from "../shared/api";
import { $, h, errMsg, toast } from "../shared/dom";
import { baseName } from "../shared/format";
import { t } from "../shared/i18n";
import { normalizeScale } from "../shared/textScale";
import { isDark } from "./colors";
import type { SessionTab } from "./sessionTab";
import { saveConfig, state } from "./state";

const DEFAULT_H = 260;
const MIN_H = 80;
const elDock = $("term-dock");
const elBody = $("term-body");
const elTabs = $("term-tabs");
const elSplit = $("rs-term");

const LIGHT = {
  background: "#fafaf9",
  foreground: "#1c1b19",
  cursor: "#3563d9",
  selectionBackground: "#d5dcf7",
  black: "#3b3a37",
  red: "#c8372d",
  green: "#2f8a4c",
  yellow: "#b7791f",
  blue: "#3563d9",
  magenta: "#8a4bb5",
  cyan: "#1f7a8c",
  white: "#e7e5e0",
  brightBlack: "#6d6b66",
  brightRed: "#e0574c",
  brightGreen: "#3fa865",
  brightYellow: "#d29a33",
  brightBlue: "#5b82ec",
  brightMagenta: "#a86bd0",
  brightCyan: "#2f97ab",
  brightWhite: "#fafaf9",
};
const DARK = {
  background: "#1b1b1d",
  foreground: "#ebeae6",
  cursor: "#7a9cf5",
  selectionBackground: "#33405e",
  black: "#2e2e32",
  red: "#f06b5f",
  green: "#5cc27e",
  yellow: "#e0a84a",
  blue: "#7a9cf5",
  magenta: "#c58ae0",
  cyan: "#63c3d4",
  white: "#c9c8c3",
  brightBlack: "#9b9a95",
  brightRed: "#ff8a7e",
  brightGreen: "#7ad99a",
  brightYellow: "#f2c46a",
  brightBlue: "#9db8ff",
  brightMagenta: "#dbaaf0",
  brightCyan: "#88dbe9",
  brightWhite: "#ffffff",
};

interface TermTab {
  /** Id in the Rust core */
  id: number;
  hostId: string;
  cwd: string;
  label: string;
  /** Fallback name for a shell without a session (a plain shell in a folder) */
  name: string;
  /** The session this shell belongs to: its name and colour show in the tab (null = plain shell) */
  session: SessionTab | null;
  term: XTerm;
  fit: XTermFit;
  pane: HTMLElement;
  exited: boolean;
}

/** xterm.js is only loaded when the terminal is opened for the first time (keeps the start light) */
let lib: {
  Terminal: typeof import("@xterm/xterm").Terminal;
  FitAddon: typeof import("@xterm/addon-fit").FitAddon;
} | null = null;

async function loadLib() {
  if (!lib) {
    const [xterm, fit, css] = await Promise.all([
      import("@xterm/xterm"),
      import("@xterm/addon-fit"),
      import("@xterm/xterm/css/xterm.css"),
    ]);
    void css;
    lib = { Terminal: xterm.Terminal, FitAddon: fit.FitAddon };
  }
  return lib;
}

const tabs: TermTab[] = [];
let active: number | null = null;
/** Listener registration; terminals are only started once the events arrive */
let ready: Promise<unknown> = Promise.resolve();

function find(id: number): TermTab | undefined {
  return tabs.find((x) => x.id === id);
}

function height(): number {
  return state.config.ui.termHeight || DEFAULT_H;
}

/** Largest sensible height: everything above the dock except the input and status line, keeping a sliver of chat */
function maxHeight(): number {
  const chat = document.querySelector<HTMLElement>(".chat");
  if (!chat) return window.innerHeight - 120;
  const fixed = [...chat.children]
    .filter((el) => el !== elDock && el !== elSplit && !el.classList.contains("chat-scroll"))
    .reduce((sum, el) => sum + el.getBoundingClientRect().height, 0);
  return Math.max(MIN_H + 40, chat.clientHeight - fixed - 40);
}

function applyHeight() {
  elDock.style.height = `${height()}px`;
}

function hostName(hostId: string): string {
  return state.config.hosts.find((x) => x.id === hostId)?.name ?? hostId;
}

/**
 * Name and colour of a terminal's tab. They follow the session settings (name, colour of the session list, see
 * src/main/sessionGroups.ts), so renaming or recolouring a session also changes its terminal. A shell without a
 * session keeps the folder name it was started in.
 */
function tabMeta(x: TermTab): { name: string; color: string } {
  const s = x.session;
  if (!s) return { name: x.name || x.label, color: "" };
  const meta = state.config.sessionMeta?.[s.key];
  return { name: meta?.name?.trim() || s.title || x.label, color: meta?.color ?? "" };
}

/** Rename and recolour tabs after the session settings changed (called from setMeta/setMetaMany/rekey) */
export function refreshTermTabs() {
  if (tabs.length) renderTabs();
}

/**
 * Show the terminal of another session (switching sessions in the list): only if that session has a shell of its own
 * and the dock is open – a hidden terminal stays hidden, and a session without a shell keeps the current one.
 * Settings → Terminal → "Terminal follows the session" switches this off.
 */
export function focusSessionTab(session: SessionTab) {
  if (!visible() || state.config.ui.termFollowSession === false) return;
  const tab = tabs.find((x) => x.session === session);
  if (tab && tab.id !== active) show(tab.id);
}

/**
 * A session started. It gets a terminal of its own only when that is wanted: Settings → Terminal → "Own terminal per
 * session" (`ui.termAutoOpen`, off by default) and only while the dock is already open – sessions you open without
 * ever showing the terminal do not fill the tab bar. A shell for the current session on demand: the "+" button or
 * ⌘⌥J.
 */
export function sessionStarted(session: SessionTab) {
  if (!visible() || !state.config.ui.termAutoOpen) return;
  void openTab(session.hostId, session.cwd, { name: session.title, session, reuse: true });
}

/** Bytes of a terminal stream arrive base64 encoded, as xterm.js wants them */
function decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function renderTabs() {
  elTabs.replaceChildren(
    ...tabs.map((x) => {
      const meta = tabMeta(x);
      return h(
        "div",
        {
          class: `term-tab ${x.id === active ? "active" : ""} ${x.exited ? "dead" : ""} ${meta.color ? `c-${meta.color}` : ""}`,
          title: `${hostName(x.hostId)} · ${x.cwd}`,
          onclick: () => activate(x.id),
        },
        meta.color ? h("span", { class: "cdot term-tab-dot" }) : null,
        h("span", { class: "term-tab-name" }, meta.name),
        h(
          "button",
          {
            class: "icon-btn term-tab-close",
            title: t("Close this terminal"),
            onclick: (e: Event) => {
              e.stopPropagation();
              closeTab(x.id);
            },
          },
          "×",
        ),
      );
    }),
  );
}

function show(id: number | null) {
  active = id;
  for (const x of tabs) x.pane.hidden = x.id !== id;
  renderTabs();
  const tab = id === null ? undefined : find(id);
  if (!tab) return;
  requestAnimationFrame(() => {
    fit(tab);
    tab.term.focus();
  });
}

function activate(id: number) {
  if (id === active) return;
  show(id);
}

function fit(tab: TermTab) {
  try {
    tab.fit.fit();
  } catch {
    /* the pane has no size yet (hidden) */
  }
}

function fitAll() {
  const tab = active === null ? undefined : find(active);
  if (tab) fit(tab);
}

function visible() {
  return !elDock.hidden;
}

function setVisible(on: boolean) {
  elDock.hidden = !on;
  elSplit.hidden = !on;
  if (on) {
    applyHeight();
    requestAnimationFrame(fitAll);
  }
}

/** Folder and host for a new terminal: the active session, otherwise the selected or first host */
function target(): { hostId: string; cwd: string } {
  const tab = state.active;
  if (tab) return { hostId: tab.hostId, cwd: tab.cwd };
  const selected = state.config.ui.selectedHost;
  const host = state.config.hosts.find((x) => x.id === selected) ?? state.config.hosts[0];
  return { hostId: host?.id ?? "local", cwd: host?.defaultDir ?? "" };
}

export interface TabOptions {
  /** Fallback name for a plain shell (without a session) */
  name?: string;
  /** Session whose name and colour the tab follows */
  session?: SessionTab | null;
  /** Open once per session: a restart of Pi (reconnect, background run) shows the existing shell again */
  reuse?: boolean;
  /** Script to run right after the shell started (quick actions, src/main/quickActions.ts) */
  run?: string;
}

/** Start a shell and show it in a new tab */
export async function openTab(hostId: string, cwd: string, opts: TabOptions = {}) {
  await ready.catch(() => {});
  const { name = "", session = null, reuse = false, run = "" } = opts;
  if (reuse && session) {
    const existing = tabs.find((x) => x.session === session);
    if (existing) {
      setVisible(true);
      show(existing.id);
      return;
    }
  }
  setVisible(true);
  const { Terminal, FitAddon } = await loadLib();
  const term = new Terminal({
    fontFamily: 'ui-monospace, "SF Mono", Menlo, Consolas, monospace',
    fontSize: termFontSize(),
    lineHeight: 1.25,
    cursorBlink: true,
    scrollback: 5000,
    theme: isDark() ? DARK : LIGHT,
  });

  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  const pane = h("div", { class: "term-pane" });
  elBody.append(pane);
  term.open(pane);
  fitAddon.fit();
  requestAnimationFrame(() => fitAddon.fit());

  let id: number;
  try {
    id = await api.termOpen(hostId, cwd, term.cols, term.rows);
  } catch (e) {
    toast(`${t("Terminal could not start")}: ${errMsg(e)}`, "err");
    term.dispose();
    pane.remove();
    if (!tabs.length) setVisible(false);
    return;
  }
  const entry: TermTab = {
    id,
    hostId,
    cwd,
    label: baseName(cwd) || hostName(hostId),
    name: name || "",
    session,
    term,
    fit: fitAddon,
    pane,
    exited: false,
  };
  tabs.push(entry);
  term.onData((data) => {
    if (!entry.exited) api.termWrite(id, data).catch(() => {});
  });
  term.onResize(({ cols, rows }) => {
    if (!entry.exited) api.termResize(id, cols, rows).catch(() => {});
  });
  show(id);
  // a quick action script: the pty buffers the keys until the shell reads them
  if (run) api.termWrite(id, run.endsWith("\n") ? run : `${run}\n`).catch(() => {});
}

/** Open terminals follow the colour scheme of the window (called from setTheme) */
export function applyTermTheme() {
  const theme = isDark() ? DARK : LIGHT;
  for (const x of tabs) x.term.options.theme = theme;
}

/** Terminal font follows the text size of the window (called from setFontScale) */
function termFontSize(): number {
  return Math.round(12.5 * normalizeScale(state.config.ui.fontScale) * 2) / 2;
}

export function applyTermFont() {
  for (const x of tabs) {
    x.term.options.fontSize = termFontSize();
    x.fit.fit();
  }
}

/** Show the terminal below the chat, starting a shell if there is none yet */
export function toggleTerminal() {
  if (visible()) {
    setVisible(false);
    return;
  }
  setVisible(true);
  if (!tabs.length) {
    const a = state.active;
    const { hostId, cwd } = a ? { hostId: a.hostId, cwd: a.cwd } : target();
    void openTab(hostId, cwd, { name: a?.title, session: a ?? null, reuse: true });
  } else {
    show(active ?? tabs[0].id);
  }
}

function closeTab(id: number) {
  const i = tabs.findIndex((x) => x.id === id);
  if (i < 0) return;
  const [tab] = tabs.splice(i, 1);
  api.termClose(id).catch(() => {});
  tab.term.dispose();
  tab.pane.remove();
  if (!tabs.length) {
    active = null;
    renderTabs();
    setVisible(false);
    return;
  }
  if (active === id) show(tabs[Math.min(i, tabs.length - 1)].id);
  else renderTabs();
}

/** Drag handle above the dock: height in pixels, remembered in the settings */
function wireSplit() {
  let dragging = false;
  elSplit.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    dragging = true;
    elSplit.setPointerCapture(e.pointerId);
    document.body.classList.add("resizing-v");
  });
  elSplit.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const bottom = elDock.getBoundingClientRect().bottom;
    const next = Math.round(Math.min(maxHeight(), Math.max(MIN_H, bottom - e.clientY)));
    state.config.ui.termHeight = next;
    applyHeight();
    fitAll();
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    document.body.classList.remove("resizing-v");
    saveConfig();
  };
  elSplit.addEventListener("pointerup", end);
  elSplit.addEventListener("pointercancel", end);
  elSplit.addEventListener("dblclick", () => {
    state.config.ui.termHeight = null;
    applyHeight();
    fitAll();
    saveConfig();
  });
}

export function wireTerminal() {
  ready = Promise.all([
    listen<{ id: number; data: string }>("term-output", (e) => {
      find(e.payload.id)?.term.write(decode(e.payload.data));
    }),
    listen<{ id: number }>("term-exit", (e) => {
      const tab = find(e.payload.id);
      if (!tab || tab.exited) return;
      tab.exited = true;
      tab.term.write(`\r\n\x1b[2m[${t("Terminal ended")}]\x1b[0m\r\n`);
      renderTabs();
    }),
  ]).catch((e) => toast(errMsg(e), "err"));

  $("btn-term").addEventListener("click", () => toggleTerminal());
  $("btn-term-dock").addEventListener("click", () => setVisible(false));
  $("btn-term-kill").addEventListener("click", () => active !== null && closeTab(active));
  $("btn-term-new").addEventListener("click", () => {
    const shown = active === null ? undefined : find(active);
    // The session on screen: a shell of its own, in its folder. If the shown tab already belongs to it, the new shell
    // stays in that tab's folder (a second shell next to the first).
    const a = state.active;
    const session = a && shown?.session !== a ? a : (shown?.session ?? a ?? null);
    const { hostId, cwd } = session
      ? { hostId: session.hostId, cwd: session.cwd }
      : (shown ?? { hostId: target().hostId, cwd: target().cwd });
    void openTab(hostId, cwd, { name: session?.title ?? shown?.name, session });
  });
  wireSplit();
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener?.("change", applyTermTheme);
  new ResizeObserver(() => {
    if (visible()) requestAnimationFrame(fitAll);
  }).observe(elBody);
  window.addEventListener("resize", () => visible() && requestAnimationFrame(fitAll));
  applyHeight();
}
