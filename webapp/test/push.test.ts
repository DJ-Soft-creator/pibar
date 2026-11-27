// Web push (task J3): subscription checks (only https endpoints of known push services), VAPID keys kept in DATA_DIR,
// "answer finished" for users who had the session open (not while it is on their screen, only with host rights),
// due reminders from the meta store exactly once, gone subscriptions removed, and the push_* commands.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUser } from "../src/server/auth.js";
import { CommandRegistry } from "../src/server/commands.js";
import { registerPushCommands } from "../src/server/cmd/push.js";
import { PiManager } from "../src/server/host/pi.js";
import { sessionKey, UserMetaStores } from "../src/server/meta.js";
import { parseSubscription, PushService, sessionTitle, startWebPush, stopWebPush, type PushMessage, type Sender } from "../src/server/push.js";
import { Store, type UserRecord } from "../src/server/store.js";
import { fakeHost } from "./fakeHost.js";

const SUB = (n = 1) => ({
  endpoint: `https://web.push.apple.com/QK${n}abcdefghijklmnop`,
  keys: { p256dh: "BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM", auth: "tBHItJI5svbpez7KI4CCXg" },
});

function tmp(t: TestContext) {
  const d = mkdtempSync(join(tmpdir(), "pibar-push-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
}

async function setup(t: TestContext, opts: { pi?: PiManager; now?: () => number } = {}) {
  const dir = tmp(t);
  const store = new Store(dir);
  const anna = await createUser("anna", "pw-anna-123", "user", ["fake"]);
  const ben = await createUser("ben", "pw-ben-1234", "user", []);
  store.saveUser(anna);
  store.saveUser(ben);
  const metas = new UserMetaStores(dir);
  // anna's own organisation (names and reminders of her sessions)
  const meta = metas.of(anna.id);
  const sent: { endpoint: string; msg: PushMessage }[] = [];
  let fail = 0;
  const sender: Sender = (sub, payload) => {
    if (fail) return Promise.reject(Object.assign(new Error("gone"), { statusCode: fail }));
    sent.push({ endpoint: sub.endpoint, msg: JSON.parse(payload) as PushMessage });
    return Promise.resolve();
  };
  const push = new PushService({ dataDir: dir, store, metas, pi: opts.pi, sender, now: opts.now });
  t.after(() => push.stop());
  return { dir, store, metas, meta, push, anna, ben, sent, failWith: (s: number) => (fail = s) };
}

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("parseSubscription: https endpoints of known push services only, keys checked", () => {
  assert.deepEqual(parseSubscription(SUB()), SUB());
  assert.equal(typeof parseSubscription({ ...SUB(), endpoint: "https://fcm.googleapis.com/fcm/send/abc" }), "object");
  assert.match(String(parseSubscription({ ...SUB(), endpoint: "http://web.push.apple.com/x" })), /https/);
  assert.match(String(parseSubscription({ ...SUB(), endpoint: "https://192.0.2.10/x" })), /known push service/);
  assert.match(String(parseSubscription({ ...SUB(), endpoint: "https://evilpush.apple.com.example/x" })), /known push service/);
  assert.match(String(parseSubscription({ endpoint: SUB().endpoint, keys: { p256dh: "x y", auth: "z" } })), /keys/);
  assert.match(String(parseSubscription(null)), /endpoint/);
});

test("sessionTitle: own name, otherwise the folder", () => {
  assert.equal(sessionTitle({ name: " Release " }, "/w"), "Release");
  assert.equal(sessionTitle(null, "/home/user/PiBar/"), "PiBar");
  assert.equal(sessionTitle(undefined, "~"), "");
});

test("VAPID keys are created once and kept (owner only); subscriptions persisted, moved and removed", async (t) => {
  const s = await setup(t);
  const key = s.push.vapid.publicKey;
  assert.match(key, /^[A-Za-z0-9_-]{80,}$/);
  assert.equal(statSync(join(s.dir, "vapid.json")).mode & 0o777, 0o600);
  s.push.subscribe(s.anna, SUB(), "de-DE");
  s.push.subscribe(s.anna, SUB(), "de");
  assert.equal(s.push.subscriptionsOf(s.anna.id).length, 1);
  // the same device logged in as another user: the subscription moves
  s.push.subscribe(s.ben, SUB(), "en");
  assert.equal(s.push.subscriptionsOf(s.anna.id).length, 0);
  const again = new PushService({ dataDir: s.dir, store: s.store });
  assert.equal(again.vapid.publicKey, key);
  assert.equal(again.subscriptionsOf(s.ben.id)[0]?.lang, "en");
  assert.equal(s.push.unsubscribe(s.anna, SUB().endpoint), false);
  assert.equal(s.push.unsubscribe(s.ben, SUB().endpoint), true);
});

test("answer finished: pushed to users who had the session open, not while on screen, not without host rights", async (t) => {
  const f = fakeHost(t);
  const pi = new PiManager(f.exec);
  t.after(() => pi.closeAll());
  const s = await setup(t, { pi });
  s.push.start();
  const path = f.writeSession("--w--", "s.jsonl", [{ type: "session", id: "s1", cwd: "/w" }]);
  s.meta.setSession(sessionKey("fake", path), { name: "Release" });
  s.push.subscribe(s.anna, SUB(1), "de");
  s.push.subscribe(s.ben, SUB(2), "en");
  const { handle } = pi.open(f.host, "~", { sessionPath: path });
  // ben has no right on the host: his watch is ignored
  s.push.watch(s.anna, "dev-anna-1", "fake", path, "~", true);
  s.push.watch(s.ben, "dev-ben-01", "fake", path, "~", false);

  // on screen: nothing
  await pi.send(handle, { type: "prompt", message: "a" });
  await until(() => pi.replay(handle, 0).events.some((e) => (e.event as { type?: string }).type === "agent_settled"));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(s.sent.length, 0);

  // phone locked
  s.push.watch(s.anna, "dev-anna-1", "fake", path, "~", false);
  const before = pi.replay(handle, 0).seq;
  await pi.send(handle, { type: "prompt", message: "b" });
  await until(() => s.sent.length > 0);
  assert.ok(pi.replay(handle, 0).seq > before);
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0]?.endpoint, SUB(1).endpoint);
  assert.deepEqual(s.sent[0]?.msg.title, "Pi ist fertig");
  assert.equal(s.sent[0]?.msg.body, "Release");
  assert.deepEqual(s.sent[0]?.msg.data, { hostId: "fake", path, cwd: "~", title: "Release" });
});

test("answer finished in a new session (no file yet): matched by host and folder", async (t) => {
  const f = fakeHost(t);
  const pi = new PiManager(f.exec);
  t.after(() => pi.closeAll());
  const s = await setup(t, { pi });
  s.push.subscribe(s.anna, SUB(1), "en");
  const { handle } = pi.open(f.host, "/w/proj");
  s.push.watch(s.anna, "dev-anna-1", "fake", null, "/w/proj", false);
  assert.equal(await s.push.settled(handle), 1);
  assert.equal(s.sent[0]?.msg.title, "Pi is done");
  assert.equal(s.sent[0]?.msg.body, "proj");
  // a user who never opened it gets nothing
  s.push.watch(s.anna, "dev-anna-1", "fake", null, "/other", false);
  const other = pi.open(f.host, "/w/else");
  assert.equal(await s.push.settled(other.handle), 0);
});

test("reminders: due ones pushed once, a new time again, overdue ones at the first start silently", async (t) => {
  let now = 1_000_000_000_000;
  const s = await setup(t, { now: () => now });
  s.push.subscribe(s.anna, SUB(1), "de");
  const k = sessionKey("fake", "/s/a.jsonl");
  s.meta.setSession(k, { name: "Deploy", remindAt: now - 60_000, remindNote: "Logs prüfen" });
  s.meta.setSession(sessionKey("other", "/s/b.jsonl"), { remindAt: now - 60_000 });
  // first start: what is already due is only marked
  assert.equal(await s.push.checkReminders(true), 0);
  assert.equal(await s.push.checkReminders(), 0);
  s.meta.setSession(k, { name: "Deploy", remindAt: now + 60_000, remindNote: "Logs prüfen" });
  assert.equal(await s.push.checkReminders(), 0);
  now += 61_000;
  assert.equal(await s.push.checkReminders(), 1);
  assert.equal(await s.push.checkReminders(), 0);
  assert.equal(s.sent[0]?.msg.title, "Erinnerung: Deploy");
  assert.equal(s.sent[0]?.msg.body, "Logs prüfen");
  assert.equal(s.sent[0]?.msg.data?.path, "/s/a.jsonl");
  // reminders much older than a day are not pushed late
  s.meta.setSession(k, { remindAt: now - 2 * 24 * 3600_000 });
  assert.equal(await s.push.checkReminders(), 0);
  // kept across a restart
  const again = new PushService({ dataDir: s.dir, store: s.store, metas: s.metas, sender: () => Promise.resolve(), now: () => now });
  assert.equal(await again.checkReminders(), 0);
});

test("a subscription the push service no longer knows (410) is removed", async (t) => {
  const s = await setup(t);
  s.push.subscribe(s.anna, SUB(1), "en");
  s.failWith(410);
  assert.equal(await s.push.test(s.anna), 0);
  assert.equal(s.push.subscriptionsOf(s.anna.id).length, 0);
});

test("push commands: 404 without the service, subscribe / info / watch rights / unsubscribe", async (t) => {
  const reg = new CommandRegistry();
  registerPushCommands(reg);
  const dir = tmp(t);
  const store = new Store(dir);
  const anna: UserRecord = await createUser("anna", "pw-anna-123", "user", ["fake"]);
  store.saveUser(anna);
  const run = (name: string, args: Record<string, unknown>) => Promise.resolve().then(() => reg.get(name)?.run({ user: anna } as never, args));
  stopWebPush();
  await assert.rejects(run("push_info", {}), /not available/);
  const svc = startWebPush({ dataDir: dir, store, sender: () => Promise.resolve() });
  t.after(stopWebPush);
  const info = (await run("push_info", { endpoint: SUB().endpoint })) as { publicKey: string; subscribed: boolean };
  assert.equal(info.publicKey, svc.vapid.publicKey);
  assert.equal(info.subscribed, false);
  await run("push_subscribe", { subscription: SUB(), lang: "de" });
  assert.equal(((await run("push_info", { endpoint: SUB().endpoint })) as { subscribed: boolean }).subscribed, true);
  await assert.rejects(run("push_subscribe", { subscription: { ...SUB(), endpoint: "https://192.0.2.1/x" } }), /push service/);
  await assert.rejects(run("push_watch", { device: "dev-anna-1", hostId: "other", sessionPath: "/x" }), /No access/);
  await assert.rejects(run("push_watch", { device: "x", hostId: "" }), /device/);
  assert.equal(await run("push_watch", { device: "dev-anna-1", hostId: "fake", sessionPath: "/x", cwd: "/w", visible: true }), null);
  assert.equal(await run("push_watch", { device: "dev-anna-1", hostId: "" }), null);
  assert.equal(await run("push_test", {}), 1);
  assert.equal(await run("push_unsubscribe", { endpoint: SUB().endpoint }), true);
});
