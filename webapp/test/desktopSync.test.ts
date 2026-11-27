// Desktop sync and API tokens: token store (hash only, shown once, per user, revoke), desktop sign-in/-out, own and
// admin token routes, and the two-way sync POST /api/sync/meta – token-only access, one organisation per user, host
// rights, host mapping, merge (different entries, the same entry, delete vs change), clock skew, rate limit.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ApiTokenStore, hashSecret } from "../src/server/apiTokens.js";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createUser } from "../src/server/auth.js";
import type { HostRecord } from "../src/server/hosts.js";
import { MetaStore, sessionKey, UserMetaStores } from "../src/server/meta.js";
import { createLoginRateLimiter } from "../src/server/rateLimit.js";
import { Store } from "../src/server/store.js";
import { cleanSessionValue, clampTime, MAX_CLOCK_SKEW_MS, type SyncResponse } from "../src/server/sync.js";

const ADMIN = { username: "admin", password: "admin-pass-123" };

const tmp = (t: TestContext) => {
  const d = mkdtempSync(join(tmpdir(), "pibar-sync-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const host = (id: string, name: string, sshTarget: string, sshUser = ""): HostRecord => ({
  id,
  name,
  sshTarget,
  sshUser,
  sshPort: null,
  piCommand: "",
  defaultDir: "",
  colorProfile: "",
});

interface Ctx {
  url: string;
  store: Store;
  metas: UserMetaStores;
  /** the admin's own organisation */
  meta: MetaStore;
  adminId: string;
  apiTokens: ApiTokenStore;
  adminToken: string;
  changes: () => number;
}

async function start(t: TestContext, syncLimit = 1000): Promise<Ctx> {
  const dataDir = tmp(t);
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password }, () => {});
  store.saveHost(host("w-vm", "Pi-VM", "pi-vm.example", "user"));
  store.saveHost(host("w-mini", "Mini", "mini.example"));
  const metas = new UserMetaStores(dataDir);
  let n = 0;
  metas.onChange(() => n++);
  const adminId = store.findUserByName(ADMIN.username)?.id ?? "";
  const apiTokens = new ApiTokenStore(dataDir);
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    sync: {
      metas,
      apiTokens,
      syncLimiter: createLoginRateLimiter({ limit: syncLimit, windowMs: 60_000 }),
      loginLimiter: createLoginRateLimiter({ limit: 1000, windowMs: 60_000 }),
    },
  });
  const server = createServer(app);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const login = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminToken = ((await login.json()) as { token: string }).token;
  return { url, store, metas, meta: metas.of(adminId), adminId, apiTokens, adminToken, changes: () => n };
}

async function call(ctx: Ctx, method: string, path: string, body?: unknown, token?: string) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${ctx.url}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, json: (await res.json()) as unknown };
}

/** The desktop's hosts: "vm" matches Pi-VM by its SSH address, "mac" (local) has no webapp host */
const DESKTOP_HOSTS = [
  { id: "vm", name: "Server", kind: "ssh", address: "user@pi-vm.example" },
  { id: "mac", name: "Local", kind: "local", address: "" },
];

const sync = (ctx: Ctx, secret: string, body: Record<string, unknown>) =>
  call(ctx, "POST", "/api/sync/meta", { hosts: DESKTOP_HOSTS, ...body }, secret);

// ------------------------------------------------------------------ token store

test("ApiTokenStore: secret shown once, only the hash stored (0600), verify, rename, revoke, reload", (t) => {
  const dir = tmp(t);
  const s = new ApiTokenStore(dir);
  const { token, secret } = s.create("MacBook", "u1", 1000);
  assert.match(secret, /^pbt_[A-Za-z0-9_-]{43}$/);
  assert.equal(token.name, "MacBook");
  assert.ok(!("hash" in token));
  assert.equal(token.hint, secret.slice(0, 8));
  const file = readFileSync(join(dir, "api-tokens.json"), "utf8");
  assert.ok(!file.includes(secret), "the secret never reaches the disk");
  assert.ok(file.includes(hashSecret(secret)));
  assert.equal(statSync(join(dir, "api-tokens.json")).mode & 0o777, 0o600);
  assert.equal(s.verify(secret)?.id, token.id);
  assert.equal(s.verify(secret)?.userId, "u1");
  assert.equal(s.verify(`${secret}x`), null);
  assert.equal(s.verify("not-a-token"), null);
  assert.equal(s.rename(token.id, "Mac mini")?.name, "Mac mini");
  const reloaded = new ApiTokenStore(dir);
  assert.equal(reloaded.verify(secret)?.name, "Mac mini");
  s.touch(token.id, 5000);
  assert.equal(new ApiTokenStore(dir).list()[0]?.lastUsedAt, 5000);
  assert.equal(s.revoke(token.id), true);
  assert.equal(s.revoke(token.id), false);
  assert.equal(s.verify(secret), null);
  assert.equal(new ApiTokenStore(dir).list().length, 0);
});

test("ApiTokenStore: tokens per user, revokeUser; old tokens without a user are dropped on load", (t) => {
  const dir = tmp(t);
  const s = new ApiTokenStore(dir);
  const a = s.create("A", "u1");
  s.create("B", "u2");
  assert.deepEqual(s.list("u1").map((x) => x.name), ["A"]);
  assert.equal(s.get(a.token.id, "u2"), null);
  assert.equal(s.get(a.token.id, "u1")?.name, "A");
  assert.equal(s.revokeUser("u1"), 1);
  assert.equal(s.verify(a.secret), null);
  assert.deepEqual(new ApiTokenStore(dir).list().map((x) => x.name), ["B"]);

  const old = tmp(t);
  const legacy = { id: "old", name: "Old", hash: hashSecret("pbt_old"), hint: "pbt_", createdAt: 1, lastUsedAt: null };
  writeFileSync(join(old, "api-tokens.json"), JSON.stringify([legacy]));
  assert.equal(new ApiTokenStore(old).list().length, 0);
  assert.equal(JSON.parse(readFileSync(join(old, "api-tokens.json"), "utf8")).length, 0);
});

test("desktop sign-in: name + password give an API token of that user; it syncs, signs out, is no login", async (t) => {
  const ctx = await start(t);
  assert.equal((await call(ctx, "POST", "/api/desktop/login", { username: "admin", password: "wrong" })).status, 401);
  assert.equal((await call(ctx, "POST", "/api/desktop/login", { username: "admin" })).status, 400);
  const res = await call(ctx, "POST", "/api/desktop/login", { ...ADMIN, device: " MacBook " });
  assert.equal(res.status, 201);
  const signed = res.json as { token: string; tokenId: string; username: string; role: string };
  assert.match(signed.token, /^pbt_/);
  assert.equal(signed.username, "admin");
  assert.equal(signed.role, "admin");
  assert.equal(ctx.apiTokens.get(signed.tokenId)?.userId, ctx.adminId);
  assert.equal(ctx.apiTokens.get(signed.tokenId)?.name, "MacBook");
  // a device name that is too long falls back to the default
  const unnamed = (await call(ctx, "POST", "/api/desktop/login", { ...ADMIN, device: "x".repeat(99) })).json as { tokenId: string };
  assert.equal(ctx.apiTokens.get(unnamed.tokenId)?.name, "PiBar desktop");
  // an API token is no login
  assert.equal((await call(ctx, "GET", "/api/me", undefined, signed.token)).status, 401);
  const synced = await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, signed.token);
  assert.equal(synced.status, 200);
  assert.equal((synced.json as { user: string }).user, "admin");
  assert.equal((await call(ctx, "POST", "/api/desktop/logout", undefined, ctx.adminToken)).status, 401);
  assert.equal((await call(ctx, "POST", "/api/desktop/logout", undefined, signed.token)).status, 200);
  assert.equal((await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, signed.token)).status, 401);
});

test("token routes: own tokens for every user, every token for admins", async (t) => {
  const ctx = await start(t);
  ctx.store.saveUser(await createUser("alice", "alice-pass", "user", []));
  const alice = (await call(ctx, "POST", "/api/login", { username: "alice", password: "alice-pass" })).json as { token: string };
  const aliceDesk = (await call(ctx, "POST", "/api/desktop/login", { username: "alice", password: "alice-pass", device: "Laptop" }))
    .json as { tokenId: string; token: string };
  const adminDesk = (await call(ctx, "POST", "/api/desktop/login", { ...ADMIN, device: "Mac" })).json as { tokenId: string };
  assert.equal((await call(ctx, "GET", "/api/me/tokens")).status, 401);
  const own = (await call(ctx, "GET", "/api/me/tokens", undefined, alice.token)).json as { id: string; name: string }[];
  assert.deepEqual(own.map((x) => x.name), ["Laptop"]);
  assert.ok(!JSON.stringify(own).includes(aliceDesk.token));
  assert.ok(!("hash" in (own[0] ?? {})));
  // nobody touches another user's token through /api/me
  assert.equal((await call(ctx, "PATCH", `/api/me/tokens/${adminDesk.tokenId}`, { name: "x" }, alice.token)).status, 404);
  assert.equal((await call(ctx, "DELETE", `/api/me/tokens/${adminDesk.tokenId}`, undefined, alice.token)).status, 404);
  assert.equal((await call(ctx, "PATCH", `/api/me/tokens/${aliceDesk.tokenId}`, { name: " " }, alice.token)).status, 400);
  const renamed = await call(ctx, "PATCH", `/api/me/tokens/${aliceDesk.tokenId}`, { name: "Work laptop" }, alice.token);
  assert.equal((renamed.json as { name: string }).name, "Work laptop");
  // admins see every token with its user and may revoke any
  assert.equal((await call(ctx, "GET", "/api/tokens", undefined, alice.token)).status, 403);
  const all = (await call(ctx, "GET", "/api/tokens", undefined, ctx.adminToken)).json as { name: string; username: string }[];
  assert.deepEqual(all.map((x) => `${x.username}:${x.name}`).sort(), ["admin:Mac", "alice:Work laptop"]);
  assert.equal((await call(ctx, "DELETE", `/api/tokens/${aliceDesk.tokenId}`, undefined, ctx.adminToken)).status, 200);
  assert.equal((await call(ctx, "DELETE", `/api/me/tokens/${adminDesk.tokenId}`, undefined, ctx.adminToken)).status, 200);
  assert.equal(ctx.apiTokens.list().length, 0);
});

test("desktop sign-ins end with a password change, a password reset and the user", async (t) => {
  const ctx = await start(t);
  const bob = await createUser("bob", "bob-pass-1", "user", []);
  ctx.store.saveUser(bob);
  const desk = async (password: string) =>
    ((await call(ctx, "POST", "/api/desktop/login", { username: "bob", password })).json as { token: string }).token;
  const login = async (password: string) =>
    ((await call(ctx, "POST", "/api/login", { username: "bob", password })).json as { token: string }).token;
  const ok = async (token: string) => (await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, token)).status;

  const t1 = await desk("bob-pass-1");
  const own = await login("bob-pass-1");
  assert.equal((await call(ctx, "POST", "/api/me/password", { currentPassword: "bob-pass-1", newPassword: "bob-pass-2" }, own)).status, 200);
  assert.equal(await ok(t1), 401);

  const t2 = await desk("bob-pass-2");
  assert.equal((await call(ctx, "PATCH", `/api/users/${bob.id}`, { password: "bob-pass-3" }, ctx.adminToken)).status, 200);
  assert.equal(await ok(t2), 401);

  const t3 = await desk("bob-pass-3");
  ctx.metas.of(bob.id).setGroup("g", { id: "g", name: "Bob", color: "", collapsed: false });
  assert.equal((await call(ctx, "DELETE", `/api/users/${bob.id}`, undefined, ctx.adminToken)).status, 200);
  assert.equal(await ok(t3), 401);
  assert.deepEqual(ctx.metas.of(bob.id).state.groups, {}, "the deleted user's organisation is gone");
});

test("sync: every user has an own organisation and only the hosts they may use", async (t) => {
  const ctx = await start(t);
  // carol may use Mini only; her desktop has the same two hosts as the admin's plus Mini
  const carol = await createUser("carol", "carol-pass", "user", ["w-mini"]);
  ctx.store.saveUser(carol);
  const carolToken = ctx.apiTokens.create("Carol desk", carol.id).secret;
  const adminToken = ctx.apiTokens.create("Desk", ctx.adminId).secret;
  const hosts = [...DESKTOP_HOSTS, { id: "mini", name: "Mini", kind: "ssh", address: "mini.example" }];
  const res = await call(ctx, "POST", "/api/sync/meta", {
    hosts,
    sessionMeta: { "vm|/s/a.jsonl": { color: "red", updatedAt: 100 }, "mini|/s/m.jsonl": { color: "blue", updatedAt: 100 } },
    groups: [{ id: "g-carol", name: "Carol's", color: "", collapsed: false, updatedAt: 100 }],
  }, carolToken);
  const out = res.json as SyncResponse;
  assert.deepEqual(out.hosts, [
    { id: "vm", webappHost: null },
    { id: "mac", webappHost: null },
    { id: "mini", webappHost: "Mini" },
  ]);
  const carolState = ctx.metas.of(carol.id).state;
  assert.deepEqual(Object.keys(carolState.sessions), [sessionKey("w-mini", "/s/m.jsonl")]);
  assert.equal(carolState.groups["g-carol"]?.value?.name, "Carol's");
  // the admin's organisation is untouched and the admin's sync does not see Carol's
  assert.deepEqual(ctx.meta.state, { sessions: {}, groups: {}, projects: {} });
  const adminOut = (await call(ctx, "POST", "/api/sync/meta", { hosts }, adminToken)).json as SyncResponse;
  assert.deepEqual(adminOut.groups, []);
  assert.deepEqual(adminOut.sessionMeta, {});
});

test("UserMetaStores: a user without an own file starts with a copy of the old shared meta.json", (t) => {
  const dir = tmp(t);
  const legacy = new MetaStore(dir);
  legacy.setGroup("g", { id: "g", name: "Shared", color: "", collapsed: false }, 5);
  const metas = new UserMetaStores(dir, legacy);
  const changed: string[] = [];
  metas.onChange((id) => changed.push(id));
  const a = metas.of("user-a");
  assert.equal(a.state.groups.g?.value?.name, "Shared");
  a.setGroup("g", null, 10);
  assert.deepEqual(changed, ["user-a"]);
  assert.equal(legacy.state.groups.g?.value?.name, "Shared", "the copy is a copy");
  assert.equal(metas.of("user-b").state.groups.g?.value?.name, "Shared");
  // the own file wins from now on, also after a restart
  assert.equal(new UserMetaStores(dir, legacy).of("user-a").state.groups.g?.value, null);
  // ids cannot leave the folder
  metas.of("../evil").setGroup("x", null);
  assert.ok(statSync(join(dir, "meta", "___evil.json")).isFile());
});

// ------------------------------------------------------------------ sync

test("sync: only a valid API token of an existing user, no login token; revoked tokens are refused; bad bodies 400", async (t) => {
  const ctx = await start(t);
  const ghost = ctx.apiTokens.create("Ghost", "no-such-user").secret;
  assert.equal((await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, ghost)).status, 401);
  const { token, secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  assert.equal((await call(ctx, "POST", "/api/sync/meta", { hosts: [] })).status, 401);
  assert.equal((await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, ctx.adminToken)).status, 401);
  assert.equal((await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, secret)).status, 200);
  assert.ok(ctx.apiTokens.list()[0]?.lastUsedAt);
  for (const bad of [
    [],
    {},
    { hosts: [{ id: "x" }] },
    { hosts: [], sessionMeta: [] },
    { hosts: [], sessionMeta: { "vm|/a": "red" } },
    { hosts: [], groups: [{ name: "no id" }] },
    { hosts: [], projects: [{ id: "p", name: "n", hostId: "vm" }] },
    { hosts: [], deleted: { sessions: [{ key: "vm|/a" }] } },
  ]) {
    assert.equal((await call(ctx, "POST", "/api/sync/meta", bad, secret)).status, 400, JSON.stringify(bad));
  }
  ctx.apiTokens.revoke(token.id);
  assert.equal((await call(ctx, "POST", "/api/sync/meta", { hosts: [] }, secret)).status, 401);
});

test("sync: host mapping – desktop ids in, webapp ids stored, desktop ids back; unmapped hosts are left out", async (t) => {
  const ctx = await start(t);
  const { secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  const res = await sync(ctx, secret, {
    sessionMeta: {
      "vm|/home/user/.pi/agent/sessions/a.jsonl": { name: "Alpha", color: "blue", pinned: false, group: "", order: 0, tools: [], updatedAt: 100 },
      "mac|/Users/user/.pi/agent/sessions/b.jsonl": { name: "Local only", updatedAt: 100 },
    },
    groups: [{ id: "g1", name: "Work", color: "teal", collapsed: false, updatedAt: 100 }],
    projects: [
      { id: "p1", name: "PiBar", hostId: "vm", dir: "~/pibar", collapsed: true, preset: "", updatedAt: 100 },
      { id: "p2", name: "Mac project", hostId: "mac", dir: "~/x", collapsed: false, updatedAt: 100 },
    ],
  });
  assert.equal(res.status, 200);
  const st = ctx.meta.state;
  // the Rust defaults ("" / false / 0) are not kept, tools: [] means "no tools" and stays
  assert.deepEqual(st.sessions[sessionKey("w-vm", "/home/user/.pi/agent/sessions/a.jsonl")], {
    value: { name: "Alpha", color: "blue", tools: [] },
    updatedAt: 100,
  });
  assert.equal(Object.keys(st.sessions).length, 1);
  assert.equal(st.projects.p1?.value?.hostId, "w-vm");
  assert.equal(st.projects.p2, undefined);
  assert.equal(st.groups.g1?.value?.name, "Work");

  const out = res.json as SyncResponse;
  assert.deepEqual(out.sessionMeta, {
    "vm|/home/user/.pi/agent/sessions/a.jsonl": { name: "Alpha", color: "blue", tools: [], updatedAt: 100 },
  });
  assert.deepEqual(out.projects, [{ id: "p1", name: "PiBar", hostId: "vm", dir: "~/pibar", collapsed: true, preset: "", updatedAt: 100 }]);
  assert.deepEqual(out.hosts, [
    { id: "vm", webappHost: "Pi-VM" },
    { id: "mac", webappHost: null },
  ]);
  // entries of webapp hosts the desktop does not have stay out of the answer
  ctx.meta.setSession(sessionKey("w-mini", "/s/c.jsonl"), { color: "red" });
  const again = (await sync(ctx, secret, {})).json as SyncResponse;
  assert.deepEqual(Object.keys(again.sessionMeta), ["vm|/home/user/.pi/agent/sessions/a.jsonl"]);
});

test("sync merge: both sides change different entries – both are kept on both sides", async (t) => {
  const ctx = await start(t);
  const { secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  ctx.meta.setSession(sessionKey("w-vm", "/s/web.jsonl"), { color: "red" }, 200);
  const out = (await sync(ctx, secret, { sessionMeta: { "vm|/s/desk.jsonl": { color: "green", updatedAt: 210 } } }))
    .json as SyncResponse;
  assert.deepEqual(out.sessionMeta, {
    "vm|/s/web.jsonl": { color: "red", updatedAt: 200 },
    "vm|/s/desk.jsonl": { color: "green", updatedAt: 210 },
  });
  assert.equal(ctx.meta.state.sessions[sessionKey("w-vm", "/s/desk.jsonl")]?.value?.color, "green");
});

test("sync merge: both change the same entry – the newer one wins, in both directions", async (t) => {
  const ctx = await start(t);
  const { secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  const key = sessionKey("w-vm", "/s/a.jsonl");
  ctx.meta.setSession(key, { color: "red" }, 200);
  ctx.meta.setGroup("g", { id: "g", name: "Web name", color: "", collapsed: false }, 300);
  // desktop newer for the session, older for the group
  const out = (await sync(ctx, secret, {
    sessionMeta: { "vm|/s/a.jsonl": { color: "blue", updatedAt: 250 } },
    groups: [{ id: "g", name: "Desk name", color: "", collapsed: false, updatedAt: 250 }],
  })).json as SyncResponse;
  assert.equal(ctx.meta.state.sessions[key]?.value?.color, "blue");
  assert.equal(out.sessionMeta["vm|/s/a.jsonl"]?.color, "blue");
  assert.equal(ctx.meta.state.groups.g?.value?.name, "Web name");
  assert.deepEqual(out.groups, [{ id: "g", name: "Web name", color: "", collapsed: false, updatedAt: 300 }]);
  // a tie keeps the webapp's value
  await sync(ctx, secret, { sessionMeta: { "vm|/s/a.jsonl": { color: "pink", updatedAt: 250 } } });
  assert.equal(ctx.meta.state.sessions[key]?.value?.color, "blue");
});

test("sync merge: delete vs change – the later of the two wins", async (t) => {
  const ctx = await start(t);
  const { secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  ctx.meta.setGroup("g-old", { id: "g-old", name: "Changed on the phone earlier", color: "", collapsed: false }, 100);
  ctx.meta.setGroup("g-new", { id: "g-new", name: "Changed on the phone later", color: "", collapsed: false }, 400);
  ctx.meta.setProject("p", { id: "p", name: "P", hostId: "w-vm", dir: "~/p", collapsed: false }, 100);
  ctx.meta.setSession(sessionKey("w-vm", "/s/x.jsonl"), { color: "red" }, 100);
  const out = (await sync(ctx, secret, {
    deleted: {
      groups: [
        { id: "g-old", updatedAt: 300 },
        { id: "g-new", updatedAt: 300 },
      ],
      projects: [{ id: "p", updatedAt: 300 }],
      sessions: [{ key: "vm|/s/x.jsonl", updatedAt: 300 }],
    },
  })).json as SyncResponse;
  assert.equal(ctx.meta.state.groups["g-old"]?.value, null);
  assert.equal(ctx.meta.state.groups["g-new"]?.value?.name, "Changed on the phone later");
  assert.equal(ctx.meta.state.projects.p?.value, null);
  assert.equal(ctx.meta.state.sessions[sessionKey("w-vm", "/s/x.jsonl")]?.value, null);
  assert.deepEqual(out.deleted.groups, [{ id: "g-old", updatedAt: 300 }]);
  assert.deepEqual(out.deleted.projects, [{ id: "p", updatedAt: 300 }]);
  assert.deepEqual(out.deleted.sessions, [{ key: "vm|/s/x.jsonl", updatedAt: 300 }]);
  assert.deepEqual(out.groups.map((g) => g.id), ["g-new"]);
  // a deletion on the phone reaches the desktop as a tombstone; an older desktop value does not bring it back
  ctx.meta.setGroup("g-new", null, 500);
  const out2 = (await sync(ctx, secret, {
    groups: [{ id: "g-new", name: "stale", color: "", collapsed: false, updatedAt: 450 }],
  })).json as SyncResponse;
  assert.equal(ctx.meta.state.groups["g-new"]?.value, null);
  assert.ok(out2.deleted.groups.some((g) => g.id === "g-new" && g.updatedAt === 500));
});

test("sync: nothing new → no save and no broadcast; future timestamps count as now", async (t) => {
  const ctx = await start(t);
  const { secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  const body = { sessionMeta: { "vm|/s/a.jsonl": { color: "blue", updatedAt: 100 } } };
  await sync(ctx, secret, body);
  const after = ctx.changes();
  await sync(ctx, secret, body);
  assert.equal(ctx.changes(), after);
  const before = Date.now();
  await sync(ctx, secret, { sessionMeta: { "vm|/s/b.jsonl": { color: "red", updatedAt: before + 10 * MAX_CLOCK_SKEW_MS } } });
  const stamped = ctx.meta.state.sessions[sessionKey("w-vm", "/s/b.jsonl")]?.updatedAt ?? 0;
  assert.ok(stamped >= before && stamped <= Date.now(), "clamped to the server time");
});

test("sync: rate limited per client", async (t) => {
  const ctx = await start(t, 2);
  const { secret } = ctx.apiTokens.create("Desk", ctx.adminId);
  assert.equal((await sync(ctx, secret, {})).status, 200);
  assert.equal((await sync(ctx, secret, {})).status, 200);
  assert.equal((await sync(ctx, secret, {})).status, 429);
});

test("cleanSessionValue / clampTime", () => {
  assert.deepEqual(cleanSessionValue({ name: "", pinned: false, order: 0, contextStripped: [], temperature: 0, tools: [], updatedAt: 5, x: null }), {
    temperature: 0,
    tools: [],
  });
  assert.equal(clampTime(-1, 1000), 0);
  assert.equal(clampTime("5", 1000), 0);
  assert.equal(clampTime(500.7, 1000), 500);
  assert.equal(clampTime(1000 + MAX_CLOCK_SKEW_MS + 1, 1000), 1000);
});
