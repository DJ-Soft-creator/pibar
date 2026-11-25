// Backend tests: node:test via tsx. Each test gets its own tmp DATA_DIR and server on port 0.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin } from "../src/server/auth.js";
import { createLoginRateLimiter } from "../src/server/rateLimit.js";
import { Store, TOKEN_TTL_MS } from "../src/server/store.js";
import type { ConfigPayload } from "../src/server/types.js";

const ADMIN = { username: "admin", password: "admin-pass-123" };

const samplePayload: ConfigPayload = {
  sessions: [
    { id: "host1|/home/u/.pi/a.jsonl", name: "a", color: "blue", pinned: true },
    { id: "host1|/home/u/.pi/b.jsonl", name: "b", color: "", group: "g1", pinned: false },
  ],
  projects: [{ id: "p1", name: "PiBar", hostId: "host1", dir: "/home/u/PiBar" }],
  groups: [{ id: "g1", name: "Work", color: "teal", collapsed: false }],
  meta: { generatedAt: "2025-01-01T00:00:00.000Z" },
};

interface Ctx {
  url: string;
  store: Store;
  dataDir: string;
  server: Server;
  wss: WebSocketServer;
  adminToken: string;
}

async function start(
  t: TestContext,
  env: { ADMIN_USERNAME?: string; ADMIN_PASSWORD?: string } = {
    ADMIN_USERNAME: ADMIN.username,
    ADMIN_PASSWORD: ADMIN.password,
  },
): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-webapp-test-"));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, env, () => {});
  let wssRef: WebSocketServer | null = null;
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    onConfigUpdated: (receivedAt) => {
      const msg = JSON.stringify({ type: "config/updated", receivedAt });
      wssRef?.clients.forEach((c) => {
        if (c.readyState === WebSocket.OPEN) c.send(msg);
      });
    },
  });
  const server = createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });
  wssRef = wss;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}`;
  t.after(async () => {
    for (const c of wss.clients) c.terminate();
    await new Promise((r) => wss.close(r));
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
    rmSync(dataDir, { recursive: true, force: true });
  });
  const res = await fetch(`${url}/api/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(ADMIN),
  });
  const adminToken = res.status === 200 ? ((await res.json()) as { token: string }).token : "";
  return { url, store, dataDir, server, wss, adminToken };
}

async function api(
  ctx: Ctx,
  method: string,
  path: string,
  body?: unknown,
  token?: string,
): Promise<{ status: number; json: unknown }> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token !== undefined) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${ctx.url}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

// ------------------------------------------------------------------ auth

test("bootstrap admin from env + login success/failure", async (t) => {
  const ctx = await start(t);
  assert.equal(ctx.store.users.size, 1);
  const ok = await api(ctx, "POST", "/api/login", ADMIN);
  assert.equal(ok.status, 200);
  const okBody = ok.json as { token: string; username: string; role: string };
  assert.equal(okBody.username, "admin");
  assert.equal(okBody.role, "admin");
  assert.ok(okBody.token.length > 0);

  assert.equal((await api(ctx, "POST", "/api/login", { username: "admin", password: "wrong" })).status, 401);
  assert.equal((await api(ctx, "POST", "/api/login", { username: "nobody", password: "x" })).status, 401);
  assert.equal((await api(ctx, "POST", "/api/login", { username: "admin" })).status, 400);
});

test("bootstrap without env generates a working random password", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-webapp-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  const logs: string[] = [];
  const result = await bootstrapAdmin(store, {}, (m) => logs.push(m));
  assert.ok(result);
  assert.equal(result.generated, true);
  assert.equal(result.username, "admin");
  assert.ok(result.password.length >= 12);
  assert.equal(logs.length, 1);
  assert.ok(logs[0]?.includes(result.password));
  // second start: no new bootstrap
  assert.equal(await bootstrapAdmin(new Store(dataDir), {}, () => {}), null);
});

test("logout invalidates the token", async (t) => {
  const ctx = await start(t);
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, ctx.adminToken)).status, 200);
  const out = await api(ctx, "POST", "/api/logout", undefined, ctx.adminToken);
  assert.deepEqual(out.json, { status: "ok" });
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, ctx.adminToken)).status, 401);
});

test("login rate limit: 429 after 10 attempts per minute per IP", async (t) => {
  const ctx = await start(t); // bootstrap login used 1 of 10 attempts
  for (let i = 0; i < 9; i++) {
    assert.equal((await api(ctx, "POST", "/api/login", { username: "admin", password: "wrong" })).status, 401);
  }
  // 11th attempt: even correct credentials are blocked with 429 {error}
  const blocked = await api(ctx, "POST", "/api/login", ADMIN);
  assert.equal(blocked.status, 429);
  assert.equal(typeof (blocked.json as { error: unknown }).error, "string");
  // other endpoints are unaffected
  assert.equal((await api(ctx, "GET", "/api/config/status")).status, 200);
});

test("rate limiter sliding window (unit, injected clock)", () => {
  let now = 0;
  const limiter = createLoginRateLimiter({ limit: 2, windowMs: 1000, now: () => now });
  assert.equal(limiter.allow("ip"), true);
  now = 500;
  assert.equal(limiter.allow("ip"), true);
  assert.equal(limiter.allow("ip"), false);
  assert.equal(limiter.allow("other-ip"), true); // per-key isolation
  now = 1000; // first hit left the window
  assert.equal(limiter.allow("ip"), true);
  now = 1500; // second hit left the window
  assert.equal(limiter.allow("ip"), true);
  assert.equal(limiter.allow("ip"), false);
});

// -------------------------------------------------------- user management

test("user CRUD, role enforcement and self-delete protection", async (t) => {
  const ctx = await start(t);
  // unauthenticated
  assert.equal((await api(ctx, "GET", "/api/users")).status, 401);
  assert.equal((await api(ctx, "POST", "/api/users", { username: "x", password: "y" })).status, 401);
  assert.equal((await api(ctx, "GET", "/api/users", undefined, "bogus-token")).status, 401);

  // create a normal user
  const created = await api(ctx, "POST", "/api/users", { username: "alice", password: "alice-pass" }, ctx.adminToken);
  assert.equal(created.status, 201);
  const alice = created.json as { id: string; username: string; role: string; host: string };
  assert.equal(alice.role, "user");
  assert.equal(alice.host, "");
  assert.ok(!("hash" in alice) && !("salt" in alice));

  // duplicate username -> 409
  assert.equal((await api(ctx, "POST", "/api/users", { username: "alice", password: "x" }, ctx.adminToken)).status, 409);

  // list never exposes hashes/tokens
  const list = await api(ctx, "GET", "/api/users", undefined, ctx.adminToken);
  assert.equal(list.status, 200);
  for (const u of list.json as Array<Record<string, unknown>>) {
    assert.deepEqual(Object.keys(u).sort(), ["host", "id", "role", "username"]);
  }

  // role user gets 403 on admin routes
  const aliceLogin = await api(ctx, "POST", "/api/login", { username: "alice", password: "alice-pass" });
  assert.equal(aliceLogin.status, 200);
  const aliceToken = (aliceLogin.json as { token: string }).token;
  assert.equal((await api(ctx, "GET", "/api/users", undefined, aliceToken)).status, 403);
  assert.equal((await api(ctx, "POST", "/api/users", { username: "bob", password: "x" }, aliceToken)).status, 403);
  assert.equal((await api(ctx, "PATCH", `/api/users/${alice.id}`, { host: "h" }, aliceToken)).status, 403);
  assert.equal((await api(ctx, "DELETE", `/api/users/${alice.id}`, undefined, aliceToken)).status, 403);
  // but /api/sessions is fine for role user
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, aliceToken)).status, 200);

  // PATCH host, role, password
  const patched = await api(ctx, "PATCH", `/api/users/${alice.id}`, { host: "host2", role: "admin", password: "new-pass" }, ctx.adminToken);
  assert.equal(patched.status, 200);
  assert.deepEqual(patched.json, { id: alice.id, username: "alice", role: "admin", host: "host2" });
  assert.equal((await api(ctx, "POST", "/api/login", { username: "alice", password: "alice-pass" })).status, 401);
  assert.equal((await api(ctx, "POST", "/api/login", { username: "alice", password: "new-pass" })).status, 200);
  assert.equal((await api(ctx, "PATCH", `/api/users/${alice.id}`, { role: "root" }, ctx.adminToken)).status, 400);
  assert.equal((await api(ctx, "PATCH", "/api/users/does-not-exist", { host: "h" }, ctx.adminToken)).status, 404);

  // cannot delete yourself
  const adminId = [...ctx.store.users.values()].find((u) => u.username === "admin")?.id;
  const selfDel = await api(ctx, "DELETE", `/api/users/${adminId}`, undefined, ctx.adminToken);
  assert.equal(selfDel.status, 400);

  // delete alice -> her tokens die too
  assert.equal((await api(ctx, "DELETE", `/api/users/${alice.id}`, undefined, ctx.adminToken)).status, 200);
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, aliceToken)).status, 401);
  assert.equal((await api(ctx, "DELETE", `/api/users/${alice.id}`, undefined, ctx.adminToken)).status, 404);
});

test("last admin cannot be demoted or deleted (409)", async (t) => {
  const ctx = await start(t);
  const admin = [...ctx.store.users.values()].find((u) => u.username === "admin");
  assert.ok(admin);

  // sole admin: demotion refused
  const demote = await api(ctx, "PATCH", `/api/users/${admin.id}`, { role: "user" }, ctx.adminToken);
  assert.equal(demote.status, 409);
  assert.equal(typeof (demote.json as { error: unknown }).error, "string");
  assert.equal(ctx.store.users.get(admin.id)?.role, "admin");

  // sole admin: deletion refused
  const del = await api(ctx, "DELETE", `/api/users/${admin.id}`, undefined, ctx.adminToken);
  assert.equal(del.status, 409);
  assert.equal(typeof (del.json as { error: unknown }).error, "string");
  assert.equal(ctx.store.users.size, 1);

  // with a second admin, demotion is allowed
  const created = await api(ctx, "POST", "/api/users", { username: "admin2", password: "admin2-pass", role: "admin" }, ctx.adminToken);
  assert.equal(created.status, 201);
  const admin2 = created.json as { id: string };
  assert.equal((await api(ctx, "PATCH", `/api/users/${admin.id}`, { role: "user" }, ctx.adminToken)).status, 200);

  // now admin2 is the last admin -> guarded again
  const login2 = await api(ctx, "POST", "/api/login", { username: "admin2", password: "admin2-pass" });
  assert.equal(login2.status, 200);
  const token2 = (login2.json as { token: string }).token;
  assert.equal((await api(ctx, "PATCH", `/api/users/${admin2.id}`, { role: "user" }, token2)).status, 409);
  assert.equal((await api(ctx, "DELETE", `/api/users/${admin2.id}`, undefined, token2)).status, 409);
  // deleting the (now non-admin) original admin still works
  assert.equal((await api(ctx, "DELETE", `/api/users/${admin.id}`, undefined, token2)).status, 200);
});

test("password reset revokes all tokens of that user", async (t) => {
  const ctx = await start(t);
  const created = await api(ctx, "POST", "/api/users", { username: "carol", password: "carol-pass" }, ctx.adminToken);
  assert.equal(created.status, 201);
  const carol = created.json as { id: string };
  const l1 = await api(ctx, "POST", "/api/login", { username: "carol", password: "carol-pass" });
  const l2 = await api(ctx, "POST", "/api/login", { username: "carol", password: "carol-pass" });
  const t1 = (l1.json as { token: string }).token;
  const t2 = (l2.json as { token: string }).token;
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, t1)).status, 200);

  const patch = await api(ctx, "PATCH", `/api/users/${carol.id}`, { password: "new-carol-pass" }, ctx.adminToken);
  assert.equal(patch.status, 200);
  // both of carol's tokens are dead, the admin's token is untouched
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, t1)).status, 401);
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, t2)).status, 401);
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, ctx.adminToken)).status, 200);
  assert.equal((await api(ctx, "POST", "/api/login", { username: "carol", password: "new-carol-pass" })).status, 200);

  // a host-only PATCH must NOT revoke tokens
  const l3 = await api(ctx, "POST", "/api/login", { username: "carol", password: "new-carol-pass" });
  const t3 = (l3.json as { token: string }).token;
  assert.equal((await api(ctx, "PATCH", `/api/users/${carol.id}`, { host: "h9" }, ctx.adminToken)).status, 200);
  assert.equal((await api(ctx, "GET", "/api/sessions", undefined, t3)).status, 200);
});

// ------------------------------------------------------------ config sync

test("CORS: only Tauri origins get cross-origin access", async (t) => {
  const ctx = await start(t);
  for (const origin of ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]) {
    const res = await fetch(`${ctx.url}/api/config`, { headers: { Origin: origin } });
    assert.equal(res.headers.get("access-control-allow-origin"), origin);
  }
  const evil = await fetch(`${ctx.url}/api/config`, { headers: { Origin: "https://evil.example" } });
  assert.equal(evil.headers.get("access-control-allow-origin"), null);
  // preflight from a Tauri origin allows POST + Content-Type (PiBar's sendToWebapp)
  const pre = await fetch(`${ctx.url}/api/config`, {
    method: "OPTIONS",
    headers: {
      Origin: "tauri://localhost",
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "content-type",
    },
  });
  assert.equal(pre.headers.get("access-control-allow-origin"), "tauri://localhost");
  assert.match(pre.headers.get("access-control-allow-methods") ?? "", /POST/);
});

test("config POST/GET roundtrip, status and shape validation (no auth)", async (t) => {
  const ctx = await start(t);
  const empty = await api(ctx, "GET", "/api/config");
  assert.equal(empty.status, 404);
  assert.deepEqual(empty.json, { error: "No config received yet" });

  const status0 = await api(ctx, "GET", "/api/config/status");
  assert.deepEqual(status0.json, {
    hasConfig: false,
    receivedAt: null,
    counts: { sessions: 0, projects: 0, groups: 0 },
  });

  const post = await api(ctx, "POST", "/api/config", samplePayload);
  assert.equal(post.status, 200);
  assert.deepEqual(post.json, { status: "ok" });

  const got = await api(ctx, "GET", "/api/config");
  assert.equal(got.status, 200);
  assert.deepEqual(got.json, samplePayload);

  const status1 = (await api(ctx, "GET", "/api/config/status")).json as {
    hasConfig: boolean;
    receivedAt: string | null;
    counts: { sessions: number; projects: number; groups: number };
  };
  assert.equal(status1.hasConfig, true);
  assert.ok(status1.receivedAt);
  assert.deepEqual(status1.counts, { sessions: 2, projects: 1, groups: 1 });

  // invalid payloads -> 400, stored config untouched
  const bad: unknown[] = [
    {},
    { sessions: [], projects: [], groups: [] }, // no meta
    { ...samplePayload, sessions: [{ id: 5, name: "x", color: "", pinned: false }] },
    { ...samplePayload, sessions: [{ id: "x", name: "x", color: "", pinned: "yes" }] },
    { ...samplePayload, projects: [{ id: "p", name: "n", hostId: "h" }] },
    { ...samplePayload, groups: [{ id: "g", name: "n", color: "", collapsed: 1 }] },
    { ...samplePayload, sessions: "nope" },
  ];
  for (const payload of bad) {
    assert.equal((await api(ctx, "POST", "/api/config", payload)).status, 400, JSON.stringify(payload));
  }
  assert.deepEqual((await api(ctx, "GET", "/api/config")).json, samplePayload);
});

test("GET /api/sessions requires auth and mirrors the config", async (t) => {
  const ctx = await start(t);
  assert.equal((await api(ctx, "GET", "/api/sessions")).status, 401);
  assert.deepEqual((await api(ctx, "GET", "/api/sessions", undefined, ctx.adminToken)).json, []);
  await api(ctx, "POST", "/api/config", samplePayload);
  assert.deepEqual(
    (await api(ctx, "GET", "/api/sessions", undefined, ctx.adminToken)).json,
    samplePayload.sessions,
  );
});

// ------------------------------------------------------------ persistence

test("corrupt JSON error names the file", (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-webapp-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  writeFileSync(join(dataDir, "users.json"), "{definitely not json");
  assert.throws(() => new Store(dataDir), /users\.json/);
});

test("secret files are mode 0600, config stays 0644", async (t) => {
  const ctx = await start(t);
  await api(ctx, "POST", "/api/config", samplePayload);
  const mode = (f: string): number => statSync(join(ctx.dataDir, f)).mode & 0o777;
  assert.equal(mode("users.json"), 0o600);
  assert.equal(mode("tokens.json"), 0o600);
  assert.equal(mode("config.json"), 0o644);
});

test("token TTL: expired tokens pruned on load/save, legacy format migrated", async (t) => {
  const ctx = await start(t);
  const admin = [...ctx.store.users.values()].find((u) => u.username === "admin");
  assert.ok(admin);
  const now = Date.now();
  writeFileSync(
    join(ctx.dataDir, "tokens.json"),
    JSON.stringify({
      "fresh-token": { userId: admin.id, createdAt: now },
      "expired-token": { userId: admin.id, createdAt: now - TOKEN_TTL_MS - 1000 },
      "legacy-token": admin.id, // old format: token -> userId
    }),
  );
  const reloaded = new Store(ctx.dataDir);
  assert.equal(reloaded.tokens.has("fresh-token"), true);
  assert.equal(reloaded.tokens.has("expired-token"), false);
  assert.equal(reloaded.userForToken("legacy-token")?.username, "admin");
  // saving prunes expired entries from disk as well
  reloaded.addToken("another-token", admin.id);
  const onDisk = JSON.parse(readFileSync(join(ctx.dataDir, "tokens.json"), "utf8")) as Record<string, unknown>;
  assert.ok(!("expired-token" in onDisk));
  assert.ok("fresh-token" in onDisk);
  assert.ok("another-token" in onDisk);
});

test("persistence: users, tokens and config survive a reload", async (t) => {
  const ctx = await start(t);
  await api(ctx, "POST", "/api/users", { username: "bob", password: "bob-pass", host: "host9" }, ctx.adminToken);
  await api(ctx, "POST", "/api/config", samplePayload);

  // simulate restart: brand-new Store over the same directory
  const reloaded = new Store(ctx.dataDir);
  assert.equal(reloaded.users.size, 2);
  const bob = reloaded.findUserByName("bob");
  assert.ok(bob);
  assert.equal(bob.host, "host9");
  assert.deepEqual(reloaded.config?.payload, samplePayload);
  // old token still valid after reload
  assert.equal(reloaded.userForToken(ctx.adminToken)?.username, "admin");
  // and through a fresh app instance
  const app2 = createApp(reloaded, { clientDir: join(ctx.dataDir, "client") });
  const server2 = createServer(app2);
  await new Promise<void>((r) => server2.listen(0, "127.0.0.1", r));
  t.after(async () => {
    server2.closeAllConnections();
    await new Promise((r) => server2.close(r));
  });
  const port2 = (server2.address() as AddressInfo).port;
  const res = await fetch(`http://127.0.0.1:${port2}/api/sessions`, {
    headers: { Authorization: `Bearer ${ctx.adminToken}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), samplePayload.sessions);
});

// -------------------------------------------------------------- websocket

test("WebSocket /ws receives config/updated and ignores unknown messages", async (t) => {
  const ctx = await start(t);
  const ws = new WebSocket(`${ctx.url.replace("http://", "ws://")}/ws`);
  t.after(() => ws.terminate());
  await once(ws, "open");

  // garbage + unknown types must not break the server
  ws.send("this is not json");
  ws.send(JSON.stringify({ type: "chat", text: "later task" }));

  const messagePromise = once(ws, "message");
  const post = await api(ctx, "POST", "/api/config", samplePayload);
  assert.equal(post.status, 200);
  const [data] = await messagePromise;
  const msg = JSON.parse(String(data)) as { type: string; receivedAt: string };
  assert.equal(msg.type, "config/updated");
  assert.equal(msg.receivedAt, ctx.store.config?.receivedAt);

  // server still healthy
  assert.equal((await api(ctx, "GET", "/api/config")).status, 200);
});
