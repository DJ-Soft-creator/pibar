// Command router: login, unknown commands, admin gate, host access, argument errors and host errors.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken, createUser } from "../src/server/auth.js";
import { argString, CommandError } from "../src/server/commands.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import { sq } from "../src/server/host/hostexec.js";
import { Store } from "../src/server/store.js";
import { fakeHost } from "./fakeHost.js";

interface Ctx {
  call(name: string, args?: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  adminToken: string;
  userToken: string;
}

async function start(t: TestContext): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-cmd-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const user = await createUser("anna", "anna-pass-123", "user", "fake");
  store.saveUser(user);
  const adminToken = createToken();
  store.addToken(adminToken, admin.id);
  const userToken = createToken();
  store.addToken(userToken, user.id);

  const f = fakeHost(t);
  const other = { ...f.host, id: "other", name: "Other" };
  const registry = createRegistry()
    .register("host_echo", {
      host: true,
      run: (ctx, args) => ctx.exec.runShell(ctx.host, `printf %s ${sq(argString(args, "text"))}`),
    })
    .register("host_fail", { host: true, run: (ctx) => ctx.exec.runShell(ctx.host, "echo nope >&2; exit 1") })
    .register("admin_only", { admin: true, run: () => "secret" })
    .register("teapot", {
      run: () => {
        throw new CommandError(418, "I'm a teapot");
      },
    });
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    commands: {
      registry,
      exec: f.exec,
      resolveHost: (id) => (id === "fake" ? f.host : id === "other" ? other : null),
      canUseHost,
    },
  });
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    adminToken,
    userToken,
    async call(name, args = {}, token = adminToken) {
      const res = await fetch(`${url}/api/cmd/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(args),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
  };
}

test("ping needs a login and returns the user", async (t) => {
  const c = await start(t);
  assert.equal((await c.call("ping", {}, "")).status, 401);
  const r = await c.call("ping");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.result, { pong: true, username: "admin", role: "admin" });
});

test("unknown and malformed command names give 404", async (t) => {
  const c = await start(t);
  assert.equal((await c.call("nope")).status, 404);
  assert.equal((await c.call("Ping")).status, 404);
});

test("arguments must be an object", async (t) => {
  const c = await start(t);
  assert.equal((await c.call("ping", [1, 2])).status, 400);
});

test("admin-only commands are forbidden for users", async (t) => {
  const c = await start(t);
  assert.equal((await c.call("admin_only", {}, c.userToken)).status, 403);
  assert.equal((await c.call("admin_only")).body.result, "secret");
});

test("host commands: hostId required, access checked, unknown host 404", async (t) => {
  const c = await start(t);
  assert.equal((await c.call("host_echo", { text: "x" })).status, 400);
  assert.equal((await c.call("host_echo", { hostId: "other", text: "x" }, c.userToken)).status, 403);
  assert.equal((await c.call("host_echo", { hostId: "missing", text: "x" })).status, 404);
  const r = await c.call("host_echo", { hostId: "fake", text: "it's ok" }, c.userToken);
  assert.equal(r.status, 200);
  assert.equal(r.body.result, "it's ok");
  // admins may use every host
  assert.equal((await c.call("host_echo", { hostId: "other", text: "y" })).body.result, "y");
});

test("argument errors are 400, CommandError keeps its status, host errors carry stderr", async (t) => {
  const c = await start(t);
  const bad = await c.call("host_echo", { hostId: "fake", text: 5 });
  assert.equal(bad.status, 400);
  assert.match(String(bad.body.error), /text must be a string/);
  assert.equal((await c.call("teapot")).status, 418);
  const fail = await c.call("host_fail", { hostId: "fake" });
  assert.equal(fail.status, 500);
  assert.equal(fail.body.error, "nope");
});
