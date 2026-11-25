// Accounts (tasks A5/A6): host lists with migration of the old single host, own settings, cookie login with
// cross-site guard, CSP, logout everywhere, own password, WebSocket only with a login from our own pages.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin } from "../src/server/auth.js";
import { canUseHost, isSameOrigin, parseCookies, SESSION_COOKIE } from "../src/server/helpers.js";
import { Store, type UserRecord } from "../src/server/store.js";
import { createSocketHub } from "../src/server/ws.js";

const ADMIN = { username: "admin", password: "admin-pass-123" };

interface Ctx {
  url: string;
  host: string;
  store: Store;
  dataDir: string;
  req(method: string, path: string, opts?: { body?: unknown; headers?: Record<string, string> }): Promise<Response>;
}

async function start(t: TestContext, dataDir = mkdtempSync(join(tmpdir(), "pibar-account-test-"))): Promise<Ctx> {
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: ADMIN.username, ADMIN_PASSWORD: ADMIN.password }, () => {});
  const app = createApp(store, { clientDir: join(dataDir, "client") });
  const server = createServer(app);
  const hub = createSocketHub(server, store);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  t.after(async () => {
    await hub.close();
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  });
  const host = `127.0.0.1:${(server.address() as AddressInfo).port}`;
  const url = `http://${host}`;
  return {
    url,
    host,
    store,
    dataDir,
    req(method, path, opts = {}) {
      const headers: Record<string, string> = { ...opts.headers };
      if (opts.body !== undefined) headers["Content-Type"] = "application/json";
      return fetch(`${url}${path}`, {
        method,
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    },
  };
}

/** Log in like the browser does: same-origin, keep only the cookie */
async function cookieLogin(ctx: Ctx, username = ADMIN.username, password = ADMIN.password): Promise<string> {
  const res = await ctx.req("POST", "/api/login", { body: { username, password }, headers: { Origin: ctx.url } });
  assert.equal(res.status, 200);
  const setCookie = res.headers.get("set-cookie") ?? "";
  assert.match(setCookie, new RegExp(`^${SESSION_COOKIE}=`));
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  return setCookie.split(";")[0] ?? "";
}

// ------------------------------------------------------------------ A5

test("users file: old single host migrates to hostIds, settings default to {}", async (t) => {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-account-test-"));
  const legacy = [
    { id: "u1", username: "anna", salt: "00", hash: "00", role: "user", host: "h1" },
    { id: "u2", username: "ben", salt: "00", hash: "00", role: "user", host: "" },
  ];
  writeFileSync(join(dataDir, "users.json"), JSON.stringify(legacy));
  const ctx = await start(t, dataDir);
  assert.deepEqual(ctx.store.users.get("u1")?.hostIds, ["h1"]);
  assert.deepEqual(ctx.store.users.get("u2")?.hostIds, []);
  assert.deepEqual(ctx.store.users.get("u1")?.settings, {});
  // written back in the new format
  const saved = JSON.parse(readFileSync(join(dataDir, "users.json"), "utf8")) as Record<string, unknown>[];
  assert.ok(saved.every((u) => Array.isArray(u.hostIds) && !("host" in u)));
});

test("canUseHost: admins everywhere, users only on their hosts", () => {
  const user = { role: "user", hostIds: ["a", "b"] } as UserRecord;
  assert.equal(canUseHost(user, "a"), true);
  assert.equal(canUseHost(user, "c"), false);
  assert.equal(canUseHost({ ...user, role: "admin", hostIds: [] }, "c"), true);
});

test("admin sets several hosts; invalid lists are refused", async (t) => {
  const ctx = await start(t);
  const cookie = await cookieLogin(ctx);
  const h = { Cookie: cookie, Origin: ctx.url };
  const created = await ctx.req("POST", "/api/users", {
    body: { username: "anna", password: "anna-pass-1", hostIds: ["a", "b", "a", " "] },
    headers: h,
  });
  assert.equal(created.status, 201);
  const anna = (await created.json()) as { id: string; hostIds: string[] };
  assert.deepEqual(anna.hostIds, ["a", "b"]);
  const bad = await ctx.req("PATCH", `/api/users/${anna.id}`, { body: { hostIds: "a" }, headers: h });
  assert.equal(bad.status, 400);
  const patched = await ctx.req("PATCH", `/api/users/${anna.id}`, { body: { hostIds: ["c"] }, headers: h });
  assert.deepEqual(((await patched.json()) as { hostIds: string[] }).hostIds, ["c"]);
});

test("own settings: read, replace, size limit, persisted", async (t) => {
  const ctx = await start(t);
  const cookie = await cookieLogin(ctx);
  const h = { Cookie: cookie, Origin: ctx.url };
  const me = (await (await ctx.req("GET", "/api/me", { headers: { Cookie: cookie } })).json()) as {
    user: { username: string; hostIds: string[] };
    settings: unknown;
  };
  assert.equal(me.user.username, "admin");
  assert.deepEqual(me.settings, {});
  const put = await ctx.req("PUT", "/api/me/settings", { body: { settings: { theme: "dark" } }, headers: h });
  assert.equal(put.status, 200);
  assert.deepEqual(new Store(ctx.dataDir).findUserByName("admin")?.settings, { theme: "dark" });
  assert.equal((await ctx.req("PUT", "/api/me/settings", { body: { settings: [] }, headers: h })).status, 400);
  const huge = { settings: { x: "y".repeat(70 * 1024) } };
  assert.equal((await ctx.req("PUT", "/api/me/settings", { body: huge, headers: h })).status, 413);
});

// ------------------------------------------------------------------ A6

test("cookie login works for the API; Bearer still works", async (t) => {
  const ctx = await start(t);
  const cookie = await cookieLogin(ctx);
  assert.equal((await ctx.req("GET", "/api/users", { headers: { Cookie: cookie } })).status, 200);
  const login = await ctx.req("POST", "/api/login", { body: ADMIN });
  const { token } = (await login.json()) as { token: string };
  assert.equal((await ctx.req("GET", "/api/users", { headers: { Authorization: `Bearer ${token}` } })).status, 200);
});

test("cross-site: cookie requests that change something and foreign logins are refused", async (t) => {
  const ctx = await start(t);
  const cookie = await cookieLogin(ctx);
  const evil = "https://evil.example";
  const body = { username: "x", password: "x-pass-123" };
  assert.equal((await ctx.req("POST", "/api/users", { body, headers: { Cookie: cookie, Origin: evil } })).status, 403);
  assert.equal(
    (await ctx.req("POST", "/api/users", { body, headers: { Cookie: cookie, "Sec-Fetch-Site": "cross-site" } })).status,
    403,
  );
  // reading is fine (SameSite=Strict keeps the cookie away from foreign pages anyway)
  assert.equal((await ctx.req("GET", "/api/me", { headers: { Cookie: cookie, Origin: evil } })).status, 200);
  assert.equal((await ctx.req("POST", "/api/login", { body: ADMIN, headers: { Origin: evil } })).status, 403);
  // same origin passes
  assert.equal((await ctx.req("POST", "/api/users", { body, headers: { Cookie: cookie, Origin: ctx.url } })).status, 201);
});

test("CSP and no HSTS header", async (t) => {
  const ctx = await start(t);
  const res = await ctx.req("GET", "/api/health");
  const csp = res.headers.get("content-security-policy") ?? "";
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.equal(res.headers.get("strict-transport-security"), null);
});

test("cookie gets Secure behind an HTTPS proxy", async (t) => {
  const ctx = await start(t);
  const res = await ctx.req("POST", "/api/login", { body: ADMIN, headers: { "X-Forwarded-Proto": "https" } });
  assert.match(res.headers.get("set-cookie") ?? "", /Secure/);
});

test("logout clears the cookie; logout-all ends every session", async (t) => {
  const ctx = await start(t);
  const c1 = await cookieLogin(ctx);
  const c2 = await cookieLogin(ctx);
  const out = await ctx.req("POST", "/api/logout", { headers: { Cookie: c1, Origin: ctx.url } });
  assert.match(out.headers.get("set-cookie") ?? "", new RegExp(`${SESSION_COOKIE}=;`));
  assert.equal((await ctx.req("GET", "/api/me", { headers: { Cookie: c1 } })).status, 401);
  assert.equal((await ctx.req("GET", "/api/me", { headers: { Cookie: c2 } })).status, 200);
  const c3 = await cookieLogin(ctx);
  assert.equal((await ctx.req("POST", "/api/logout-all", { headers: { Cookie: c3, Origin: ctx.url } })).status, 200);
  assert.equal((await ctx.req("GET", "/api/me", { headers: { Cookie: c2 } })).status, 401);
});

test("own password: needs the current one, ends other sessions, keeps this one", async (t) => {
  const ctx = await start(t);
  const other = await cookieLogin(ctx);
  const mine = await cookieLogin(ctx);
  const h = { Cookie: mine, Origin: ctx.url };
  const wrong = await ctx.req("POST", "/api/me/password", {
    body: { currentPassword: "nope", newPassword: "new-pass-123" },
    headers: h,
  });
  assert.equal(wrong.status, 403);
  const short = await ctx.req("POST", "/api/me/password", {
    body: { currentPassword: ADMIN.password, newPassword: "short" },
    headers: h,
  });
  assert.equal(short.status, 400);
  const ok = await ctx.req("POST", "/api/me/password", {
    body: { currentPassword: ADMIN.password, newPassword: "new-pass-123" },
    headers: h,
  });
  assert.equal(ok.status, 200);
  const fresh = (ok.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
  assert.equal((await ctx.req("GET", "/api/me", { headers: { Cookie: other } })).status, 401);
  assert.equal((await ctx.req("GET", "/api/me", { headers: { Cookie: fresh } })).status, 200);
  await cookieLogin(ctx, "admin", "new-pass-123");
});

/** Open a WebSocket; resolves true when it opened, false when the upgrade was refused */
function wsOpens(url: string, headers: Record<string, string>): Promise<boolean> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on("open", () => {
      ws.close();
      resolve(true);
    });
    ws.on("error", () => resolve(false));
  });
}

test("WebSocket needs a login; a cookie upgrade only from our own origin", async (t) => {
  const ctx = await start(t);
  const cookie = await cookieLogin(ctx);
  const ws = `ws://${ctx.host}/ws`;
  assert.equal(await wsOpens(ws, {}), false);
  assert.equal(await wsOpens(ws, { Cookie: cookie, Origin: "https://evil.example" }), false);
  assert.equal(await wsOpens(ws, { Cookie: cookie, Origin: ctx.url }), true);
});

test("helpers: cookie parsing and origin check", () => {
  assert.deepEqual(parseCookies("a=1; b=x%20y; a=2; bad"), { a: "1", b: "x y" });
  const req = (headers: Record<string, string>) => ({ headers }) as never;
  assert.equal(isSameOrigin(req({ host: "app:8787", origin: "http://app:8787" })), true);
  assert.equal(isSameOrigin(req({ host: "app:8787", origin: "http://other:8787" })), false);
  assert.equal(isSameOrigin(req({ host: "app:8787", origin: "null" })), false);
  assert.equal(isSameOrigin(req({ host: "app:8787" })), true);
  assert.equal(isSameOrigin(req({ host: "app:8787", "sec-fetch-site": "cross-site" })), false);
});
