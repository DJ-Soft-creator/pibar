// Web push in the client (task J3): the service worker (/sw.js, only for push – no offline caching), subscribing this
// device on the server (push_subscribe with the server's VAPID key), the "Notifications" card in More, telling the
// server which chat this device has open and whether it is on screen (push_watch), and opening the session of a
// tapped notification. iOS: only as a home screen app (iOS 16.4+), there the browser tab has no PushManager.
import { api } from "@shared/api";
import { errMsg, h, toast } from "@shared/dom";
import { getLang, t } from "@shared/i18n";
import { invoke } from "./bridge";
import { currentRoute, openChat, state } from "./state";
import { button } from "./ui";

/** Heartbeat of "this chat is on screen" (the server forgets it after 75 s) */
const HEARTBEAT_MS = 30_000;

export function pushSupported(): boolean {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true;
}

/** The server's base64url key as the bytes PushManager wants */
export function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const pad = "=".repeat((4 - (base64url.length % 4)) % 4);
  const bin = atob((base64url + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

let registration: Promise<ServiceWorkerRegistration> | null = null;

function swRegistration(): Promise<ServiceWorkerRegistration> {
  registration ??= navigator.serviceWorker.register("/sw.js", { scope: "/" }).then(() => navigator.serviceWorker.ready);
  return registration;
}

async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const reg = await swRegistration();
  return reg.pushManager.getSubscription();
}

export interface PushStatus {
  supported: boolean;
  permission: NotificationPermission | "unsupported";
  /** This device is subscribed for the logged-in user */
  subscribed: boolean;
}

export async function pushStatus(): Promise<PushStatus> {
  if (!pushSupported()) return { supported: false, permission: "unsupported", subscribed: false };
  const sub = await currentSubscription();
  let subscribed = false;
  if (sub) {
    const info = await invoke<{ subscribed: boolean }>("push_info", { endpoint: sub.endpoint });
    subscribed = info.subscribed;
  }
  return { supported: true, permission: Notification.permission, subscribed };
}

/** Ask for permission and subscribe this device; must start in a tap (iOS asks only then) */
export async function enablePush(): Promise<void> {
  // first thing in the tap: iOS refuses the question after other awaits
  const permission = await Notification.requestPermission();
  if (permission !== "granted") throw new Error(t("Notifications are blocked for this page – allow them in the settings."));
  const reg = await swRegistration();
  const { publicKey } = await invoke<{ publicKey: string }>("push_info");
  const options = { userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) };
  let sub: PushSubscription;
  try {
    sub = await reg.pushManager.subscribe(options);
  } catch {
    // an old subscription with another server key (DATA_DIR was reset): replace it
    await (await reg.pushManager.getSubscription())?.unsubscribe();
    sub = await reg.pushManager.subscribe(options);
  }
  await invoke("push_subscribe", { subscription: sub.toJSON(), lang: getLang() });
}

export async function disablePush(): Promise<void> {
  const sub = await currentSubscription();
  if (!sub) return;
  await invoke("push_unsubscribe", { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// ---------------------------------------------------------------- "Notifications" card in More

/** The card for More: switch notifications on/off for this device, test, and the iOS hint */
export function pushSection(): HTMLElement {
  const status = h("p", { class: "muted small", "aria-live": "polite" }, t("Checking …"));
  const actions = h("div", { class: "row-actions" });
  const card = h(
    "section",
    { class: "card", "data-extras": "push" },
    h("h2", {}, t("Notifications")),
    h("p", { class: "small" }, t("A message on this device when Pi has finished an answer in a session you had open, and when a reminder is due.")),
    status,
    actions,
  );

  const render = (s: PushStatus) => {
    actions.replaceChildren();
    if (!s.supported) {
      status.textContent =
        isIos() && !isStandalone()
          ? t("On the iPhone and iPad notifications only work in the app on the home screen (iOS 16.4 or newer): Share → Add to Home Screen, then open PiBar from there.")
          : t("This browser does not support notifications.");
      return;
    }
    if (s.permission === "denied") {
      status.textContent = t("Notifications are blocked for this page – allow them in the settings.");
      return;
    }
    status.textContent = s.subscribed ? t("On for this device.") : t("Off for this device.");
    const run = (fn: () => Promise<unknown>, done?: string) => () => {
      fn()
        .then(() => {
          if (done) toast(done);
          return refresh();
        })
        .catch((e: unknown) => toast(errMsg(e), "err"));
    };
    if (s.subscribed) {
      actions.append(
        button(t("Send a test"), run(() => invoke<number>("push_test"), t("Test sent."))),
        button(t("Turn off"), run(disablePush)),
      );
    } else {
      actions.append(button(t("Turn on"), run(enablePush, t("Notifications are on.")), "primary"));
    }
  };
  const refresh = () =>
    pushStatus()
      .then(render)
      .catch((e: unknown) => {
        status.textContent = errMsg(e);
      });
  void refresh();
  return card;
}

/**
 * Keep the card in More: more.ts renders its page itself (also again after a settings change), so the card is added
 * whenever the More page is on screen without it.
 */
export function wireMoreSection() {
  const app = document.getElementById("app");
  if (!app) return;
  const place = () => {
    if (currentRoute() !== "more") return;
    const page = app.querySelector<HTMLElement>(".page");
    if (!page || !page.querySelector(".page-head") || page.querySelector('[data-extras="push"]')) return;
    // above the administration (the last card for admins) or at the end
    const cards = [...page.querySelectorAll<HTMLElement>(":scope > section.card")];
    const anchor = cards.length > 2 ? cards[2] : null;
    page.insertBefore(pushSection(), anchor ?? null);
  };
  new MutationObserver(place).observe(app, { childList: true, subtree: true });
  place();
}

// ---------------------------------------------------------------- which chat is open (push_watch)

function deviceId(): string {
  const KEY = "pibar.device";
  try {
    const known = localStorage.getItem(KEY);
    if (known && /^[A-Za-z0-9-]{8,64}$/.test(known)) return known;
    const id = crypto.randomUUID?.() ?? Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
    localStorage.setItem(KEY, id);
    return id;
  } catch {
    return "nostorage-device";
  }
}

let lastSent = "";
let lastAt = 0;
let unavailable = false;

/** Tell the server what this device shows (only when it changed or for the heartbeat) */
function report(force = false) {
  if (unavailable || !state.me) return;
  const c = currentRoute() === "chat" ? state.chat : null;
  const visible = document.visibilityState === "visible";
  const args = c
    ? { device: deviceId(), hostId: c.hostId, sessionPath: c.path, cwd: c.cwd, visible }
    : { device: deviceId(), hostId: "" };
  const sig = JSON.stringify(args);
  const now = Date.now();
  if (!force && sig === lastSent && (!visible || !c || now - lastAt < HEARTBEAT_MS)) return;
  lastSent = sig;
  lastAt = now;
  invoke("push_watch", args).catch((e: unknown) => {
    // a server without web push: stop asking
    if (String(e).includes("not available")) unavailable = true;
    lastSent = "";
  });
}

// ---------------------------------------------------------------- open the session of a tapped notification

interface OpenData {
  hostId: string;
  path: string | null;
  cwd: string;
  title: string;
}

async function openFromNotification(d: OpenData) {
  const host = state.hosts.find((x) => x.id === d.hostId);
  if (!host) return;
  let cwd = d.cwd;
  let title = d.title;
  if (d.path && !cwd) {
    // reminders know only the session file: its folder and title come from the session list
    let list = state.sessions.get(d.hostId);
    if (!list) list = await api.listSessions(d.hostId).catch(() => undefined);
    const s = list?.find((x) => x.path === d.path);
    cwd = s?.cwd ?? "";
    title ||= s?.name || s?.title || "";
  }
  openChat({ hostId: host.id, hostName: host.name, path: d.path, cwd: cwd || host.defaultDir || "~", title });
}

function isOpenData(v: unknown): v is OpenData {
  return typeof v === "object" && v !== null && typeof (v as OpenData).hostId === "string";
}

let wired = false;

/** Push for this page (once): service worker if already allowed, chat reports, notification taps */
export function wirePush() {
  if (wired) return;
  wired = true;
  wireMoreSection();
  if (pushSupported()) {
    // keeps the worker up to date; asking for permission only happens in the card
    if (Notification.permission === "granted") void swRegistration().catch(() => {});
    navigator.serviceWorker.addEventListener("message", (e: MessageEvent) => {
      const m = e.data as { type?: string; data?: unknown } | null;
      if (m?.type === "pibar-open" && isOpenData(m.data)) void openFromNotification(m.data);
    });
  }
  // a notification that opened the app: /?open=<json>#/chat
  const open = new URLSearchParams(location.search).get("open");
  if (open) {
    history.replaceState(null, "", `/${location.hash}`);
    try {
      const d: unknown = JSON.parse(open);
      if (isOpenData(d)) void openFromNotification(d);
    } catch {
      /* not ours */
    }
  }
  window.addEventListener("hashchange", () => report());
  document.addEventListener("visibilitychange", () => report(true));
  // a new session gets its file only with the first answer: the chat updates state.chat, the check notices it
  window.setInterval(() => report(), 5_000);
  report(true);
}
