// Web push of the webapp (task J3): a notification on the phone when Pi finished an answer in a session the user had
// open, and when a reminder of the session list is due (meta store: remindAt/remindNote of a session entry).
//
// - VAPID keys are generated on the first start and kept in DATA_DIR/vapid.json (owner only).
// - Subscriptions (one per browser/device) belong to a user and live in DATA_DIR/push.json together with the
//   reminders already notified ("<session key>" → remindAt), so a restart does not notify twice.
// - Which sessions a user "had open" is told by the client (push_watch): the open chat, refreshed while the page is
//   visible. While a device shows that very chat, no push is sent for it (the user sees the answer anyway).
// - Endpoints must be https on a known push service – the server POSTs to them, so no user can point it elsewhere.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import webpush from "web-push";
import { canUseHost } from "./helpers.js";
import type { PiManager } from "./host/pi.js";
import { keyHost, sessionKey, type MetaStore } from "./meta.js";
import type { Store, UserRecord } from "./store.js";
import { isRecord } from "./validation.js";

/** A watch ("had the session open") counts this long */
const WATCH_MS = 3 * 24 * 3600_000;
/** "This chat is on screen" counts this long after the client's last heartbeat (it sends one every 30 s) */
const VISIBLE_MS = 75_000;
/** Reminders that were due longer ago than this when the server first sees them are not pushed any more */
const REMINDER_LATE_MS = 24 * 3600_000;
const REMINDER_CHECK_MS = 30_000;
const MAX_SUBS_PER_USER = 20;

/** Push services of the browsers (Apple, Google/Chromium, Mozilla, Microsoft) */
export const PUSH_HOSTS = ["push.apple.com", "fcm.googleapis.com", "android.googleapis.com", "push.services.mozilla.com", "notify.windows.com"];

export interface PushKeys {
  p256dh: string;
  auth: string;
}

export interface SubscriptionRecord {
  id: string;
  userId: string;
  endpoint: string;
  keys: PushKeys;
  /** Language of the device's UI ("de", "en"), for the notification texts */
  lang: string;
  createdAt: number;
}

interface PushFile {
  subscriptions: SubscriptionRecord[];
  notified: Record<string, number>;
}

export interface PushMessage {
  title: string;
  body: string;
  /** Same tag = the newer notification replaces the older one */
  tag: string;
  /** Session to open on a tap */
  data?: { hostId: string; path: string | null; cwd: string; title: string };
}

/** Sends one message; rejects with an error that has `statusCode` (404/410 = subscription gone) */
export type Sender = (sub: SubscriptionRecord, payload: string, vapid: Vapid) => Promise<unknown>;

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

const defaultSender: Sender = (sub, payload, vapid) =>
  webpush.sendNotification({ endpoint: sub.endpoint, keys: sub.keys }, payload, {
    vapidDetails: vapid,
    TTL: 6 * 3600,
    urgency: "high",
  });

/** Checked subscription from the browser (PushSubscription.toJSON()); returns an error text when invalid */
export function parseSubscription(v: unknown): { endpoint: string; keys: PushKeys } | string {
  if (!isRecord(v) || typeof v.endpoint !== "string" || !isRecord(v.keys)) return "subscription needs endpoint and keys";
  const { p256dh, auth } = v.keys;
  if (typeof p256dh !== "string" || typeof auth !== "string" || !/^[A-Za-z0-9_=-]{16,200}$/.test(p256dh) || !/^[A-Za-z0-9_=-]{8,100}$/.test(auth)) {
    return "subscription keys are invalid";
  }
  let url: URL;
  try {
    url = new URL(v.endpoint);
  } catch {
    return "endpoint is not a URL";
  }
  if (url.protocol !== "https:" || v.endpoint.length > 1000) return "endpoint must be an https URL";
  const host = url.hostname.toLowerCase();
  if (!PUSH_HOSTS.some((s) => host === s || host.endsWith(`.${s}`))) return "endpoint is not a known push service";
  return { endpoint: v.endpoint, keys: { p256dh, auth } };
}

const TEXTS = {
  done: { en: "Pi is done", de: "Pi ist fertig" },
  reminder: { en: "Reminder", de: "Erinnerung" },
  test: { en: "Test notification", de: "Test-Benachrichtigung" },
  testBody: { en: "Notifications work on this device.", de: "Benachrichtigungen funktionieren auf diesem Gerät." },
  session: { en: "Session", de: "Session" },
} as const;

const tr = (key: keyof typeof TEXTS, lang: string) => (lang.startsWith("de") ? TEXTS[key].de : TEXTS[key].en);

/** Name of a session for the notification: its own name, otherwise the folder it works in */
export function sessionTitle(meta: Record<string, unknown> | null | undefined, cwd: string): string {
  const name = typeof meta?.name === "string" ? meta.name.trim() : "";
  if (name) return name;
  const dir = cwd.replace(/\/+$/, "");
  return dir && dir !== "~" ? basename(dir) : "";
}

/** Key of a watch: the session file, or for a session Pi has not saved yet the folder it was started in */
export const watchKey = (hostId: string, path: string | null, cwd: string) =>
  path ? sessionKey(hostId, path) : `${hostId}|new:${cwd}`;

export interface PushOptions {
  dataDir: string;
  store: Store;
  pi?: PiManager;
  meta?: MetaStore;
  sender?: Sender;
  /** VAPID subject (mailto: or https: URL of the operator); env VAPID_SUBJECT */
  subject?: string;
  now?: () => number;
}

export class PushService {
  readonly vapid: Vapid;
  private data: PushFile = { subscriptions: [], notified: {} };
  private readonly file: string;
  private readonly sender: Sender;
  private readonly now: () => number;
  /** user id → watch key → last seen */
  private watches = new Map<string, Map<string, number>>();
  /** user id → device id → chat on screen until */
  private visible = new Map<string, Map<string, { key: string; until: number }>>();
  private stops: (() => void)[] = [];

  constructor(private readonly opts: PushOptions) {
    mkdirSync(opts.dataDir, { recursive: true });
    this.file = join(opts.dataDir, "push.json");
    this.sender = opts.sender ?? defaultSender;
    this.now = opts.now ?? Date.now;
    this.vapid = loadVapid(opts.dataDir, opts.subject?.trim() || "mailto:admin@example.com");
    if (existsSync(this.file)) {
      const raw: unknown = JSON.parse(readFileSync(this.file, "utf8"));
      if (isRecord(raw)) {
        this.data.subscriptions = Array.isArray(raw.subscriptions)
          ? (raw.subscriptions.filter((s) => isRecord(s) && typeof s.endpoint === "string" && typeof s.userId === "string") as SubscriptionRecord[])
          : [];
        this.data.notified = isRecord(raw.notified) ? (raw.notified as Record<string, number>) : {};
      }
    }
  }

  /** Listen to Pi and the meta store, check reminders regularly */
  start() {
    const { pi, meta } = this.opts;
    if (pi) {
      this.stops.push(
        pi.addListener({
          onEvent: (handle, _seq, event) => {
            if (isRecord(event) && event.type === "agent_settled") void this.settled(handle);
          },
          onExit: () => {},
        }),
      );
    }
    if (meta) {
      // reminders that are already overdue at the first start are not pushed (no flood after an update)
      this.checkReminders(true);
      this.stops.push(meta.onChange(() => void this.checkReminders()));
      const timer = setInterval(() => void this.checkReminders(), REMINDER_CHECK_MS);
      timer.unref();
      this.stops.push(() => clearInterval(timer));
    }
    return this;
  }

  stop() {
    for (const s of this.stops.splice(0)) s();
  }

  private persist() {
    const tmp = `${this.file}.${randomUUID()}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.data), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.file);
  }

  subscriptionsOf(userId: string): SubscriptionRecord[] {
    return this.data.subscriptions.filter((s) => s.userId === userId);
  }

  /** Register (or move to this user) the subscription of a device */
  subscribe(user: UserRecord, sub: { endpoint: string; keys: PushKeys }, lang: string): SubscriptionRecord {
    const rest = this.data.subscriptions.filter((s) => s.endpoint !== sub.endpoint);
    const rec: SubscriptionRecord = {
      id: randomUUID(),
      userId: user.id,
      endpoint: sub.endpoint,
      keys: sub.keys,
      lang: lang.startsWith("de") ? "de" : "en",
      createdAt: this.now(),
    };
    const own = rest.filter((s) => s.userId === user.id);
    // a user with very many devices: the oldest subscription goes
    const drop = own.length >= MAX_SUBS_PER_USER ? new Set(own.slice(0, own.length - MAX_SUBS_PER_USER + 1).map((s) => s.id)) : new Set<string>();
    this.data.subscriptions = [...rest.filter((s) => !drop.has(s.id)), rec];
    this.persist();
    return rec;
  }

  /** Remove the user's subscription of a device; true when there was one */
  unsubscribe(user: UserRecord, endpoint: string): boolean {
    const before = this.data.subscriptions.length;
    this.data.subscriptions = this.data.subscriptions.filter((s) => !(s.userId === user.id && s.endpoint === endpoint));
    if (this.data.subscriptions.length === before) return false;
    this.persist();
    return true;
  }

  /** The client tells which chat is open on a device and whether it is on screen */
  watch(user: UserRecord, device: string, hostId: string, path: string | null, cwd: string, visible: boolean) {
    const now = this.now();
    const key = watchKey(hostId, path, cwd);
    let w = this.watches.get(user.id);
    if (!w) this.watches.set(user.id, (w = new Map()));
    w.set(key, now);
    for (const [k, at] of w) if (now - at > WATCH_MS) w.delete(k);
    let v = this.visible.get(user.id);
    if (!v) this.visible.set(user.id, (v = new Map()));
    if (visible) v.set(device, { key, until: now + VISIBLE_MS });
    else v.delete(device);
  }

  /** A device stopped showing any chat (other tab, page hidden) */
  hide(user: UserRecord, device: string) {
    this.visible.get(user.id)?.delete(device);
  }

  private onScreen(userId: string, keys: string[]): boolean {
    const now = this.now();
    for (const v of this.visible.get(userId)?.values() ?? []) if (v.until > now && keys.includes(v.key)) return true;
    return false;
  }

  /** Send a message to every device of a user; subscriptions the push service no longer knows are removed */
  async notifyUser(userId: string, msg: (lang: string) => PushMessage): Promise<number> {
    let sent = 0;
    let gone = false;
    await Promise.all(
      this.subscriptionsOf(userId).map(async (s) => {
        try {
          await this.sender(s, JSON.stringify(msg(s.lang)), this.vapid);
          sent++;
        } catch (e) {
          const status = isRecord(e) && typeof e.statusCode === "number" ? e.statusCode : 0;
          if (status === 404 || status === 410) {
            this.data.subscriptions = this.data.subscriptions.filter((x) => x.id !== s.id);
            gone = true;
          } else {
            // only the push service's host: the endpoint itself works like a secret
            console.warn(`[pibar-webapp] push to ${new URL(s.endpoint).host} failed: ${status || (e instanceof Error ? e.message : String(e))}`);
          }
        }
      }),
    );
    if (gone) this.persist();
    return sent;
  }

  private liveUsers(hostId: string): UserRecord[] {
    return [...this.opts.store.users.values()].filter((u) => canUseHost(u, hostId) && this.subscriptionsOf(u.id).length > 0);
  }

  /** Pi finished an answer: tell the users who had this session open and do not see it right now */
  async settled(handle: number): Promise<number> {
    const info = this.opts.pi?.info(handle);
    if (!info) return 0;
    const keys = [watchKey(info.hostId, info.sessionPath, info.cwd)];
    if (info.sessionPath) keys.push(watchKey(info.hostId, null, info.cwd));
    const metaValue = info.sessionPath ? this.opts.meta?.state.sessions[sessionKey(info.hostId, info.sessionPath)]?.value : null;
    const title = sessionTitle(metaValue, info.cwd);
    const now = this.now();
    let sent = 0;
    for (const user of this.liveUsers(info.hostId)) {
      const w = this.watches.get(user.id);
      const watched = keys.some((k) => {
        const at = w?.get(k);
        return at !== undefined && now - at <= WATCH_MS;
      });
      if (!watched || this.onScreen(user.id, keys)) continue;
      sent += await this.notifyUser(user.id, (lang) => ({
        title: tr("done", lang),
        body: title || tr("session", lang),
        tag: `done:${keys[0]}`,
        data: { hostId: info.hostId, path: info.sessionPath, cwd: info.cwd, title },
      }));
    }
    return sent;
  }

  /** Due reminders of the meta store that were not pushed yet; `silent` only marks them (first start) */
  async checkReminders(silent = false): Promise<number> {
    const meta = this.opts.meta;
    if (!meta) return 0;
    const now = this.now();
    let changed = false;
    let sent = 0;
    const live = new Set<string>();
    for (const [key, entry] of Object.entries(meta.state.sessions)) {
      const v = entry.value;
      const at = v && typeof v.remindAt === "number" ? v.remindAt : null;
      if (at === null) continue;
      live.add(key);
      if (at > now || this.data.notified[key] === at) continue;
      this.data.notified[key] = at;
      changed = true;
      if (silent || now - at > REMINDER_LATE_MS) continue;
      const hostId = keyHost(key);
      const path = key.slice(hostId.length + 1);
      const note = typeof v?.remindNote === "string" ? v.remindNote.trim() : "";
      const title = sessionTitle(v, "");
      for (const user of this.liveUsers(hostId)) {
        sent += await this.notifyUser(user.id, (lang) => ({
          title: `${tr("reminder", lang)}${title ? `: ${title}` : ""}`,
          body: note || title || tr("session", lang),
          tag: `reminder:${key}`,
          data: { hostId, path, cwd: "", title },
        }));
      }
    }
    // forget reminders that were removed or changed, so the file does not grow
    for (const k of Object.keys(this.data.notified)) {
      if (!live.has(k)) {
        delete this.data.notified[k];
        changed = true;
      }
    }
    if (changed) this.persist();
    return sent;
  }

  /** "Test" button in More: a message to the user's own devices */
  test(user: UserRecord): Promise<number> {
    return this.notifyUser(user.id, (lang) => ({ title: tr("test", lang), body: tr("testBody", lang), tag: "test" }));
  }
}

/** VAPID keys of this installation: read from DATA_DIR/vapid.json, generated on the first start */
export function loadVapid(dataDir: string, subject: string): Vapid {
  const file = join(dataDir, "vapid.json");
  if (existsSync(file)) {
    const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (isRecord(raw) && typeof raw.publicKey === "string" && typeof raw.privateKey === "string") {
      return { publicKey: raw.publicKey, privateKey: raw.privateKey, subject };
    }
  }
  const keys = webpush.generateVAPIDKeys();
  const tmp = `${file}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(keys), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, file);
  return { ...keys, subject };
}

// One service per server process; commands reach it through pushService() (cmd/push.ts), server.ts starts it.
let current: PushService | null = null;

export function pushService(): PushService | null {
  return current;
}

/** Start web push for this server (server.ts); replaces a running one */
export function startWebPush(opts: PushOptions): PushService {
  current?.stop();
  current = new PushService(opts).start();
  return current;
}

/** Tests: stop and forget the running service */
export function stopWebPush() {
  current?.stop();
  current = null;
}
