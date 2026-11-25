// Hosts (task B2): validation, migration of the old format, admin CRUD, users see only their hosts, deleting
// removes the host from user lists, host commands reach the host through resolveHost (test_host, list_sessions).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken, createUser } from "../src/server/auth.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import { parseAddress, parseHostRecord, toTarget, validateHostInput, type HostRecord } from "../src/server/hosts.js";
import { Store } from "../src/server/store.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

test("parseAddress: user, target, port", () => {
  assert.deepEqual(parseAddress("pi@box:2222"), { sshUser: "pi", sshTarget: "box", sshPort: 2222 });
  assert.deepEqual(parseAddress("box"), { sshUser: "", sshTarget: "box", sshPort: null });
  assert.deepEqual(parseAddress("box:99999"), { sshUser: "", sshTarget: "box:99999", sshPort: null });
});

test("parseHostRecord: current format, old ssh/local format migrated, broken entries refused", () => {
  const cur = { id: "h", name: "H", sshTarget: "box", sshUser: "pi", sshPort: 22, piCommand: "", defaultDir: "~", colorProfile: "" };
  assert.deepEqual(parseHostRecord(cur), { host: cur, migrated: false });
  const old = parseHostRecord({ id: "o", name: "Alt", kind: "ssh", address: "u@srv:2200", source: "pibar" });
  assert.equal(old?.migrated, true);
  assert.deepEqual([old?.host.sshUser, old?.host.sshTarget, old?.host.sshPort], ["u", "srv", 2200]);
  assert.equal(parseHostRecord({ id: "l", name: "Lokal", kind: "local", address: "", source: "manual" })?.host.sshTarget, "");
  assert.equal(parseHostRecord({ id: "x" }), null);
  assert.equal(parseHostRecord({ ...cur, sshPort: "22" }), null);
});

test("validateHostInput: required fields, strict SSH fields, partial updates", () => {
  assert.equal(validateHostInput({ sshTarget: "box" }, false), "name required");
  assert.equal(validateHostInput({ name: "H" }, false), "sshTarget required");
  for (const sshTarget of ["-oProxyCommand=x", "box; rm -rf /", "a b"]) {
    assert.match(String(validateHostInput({ name: "H", sshTarget }, false)), /sshTarget must be/);
  }
  assert.match(String(validateHostInput({ name: "H", sshTarget: "box", sshUser: "a;b" }, false)), /sshUser/);
  assert.match(String(validateHostInput({ name: "H", sshTarget: "box", sshPort: 0 }, false)), /sshPort/);
  assert.deepEqual(validateHostInput({ name: " H ", sshTarget: "box.lan", sshPort: 22 }, false), {
    name: "H",
    sshTarget: "box.lan",
    sshUser: "",
    sshPort: 22,
    piCommand: "",
    defaultDir: "",
    colorProfile: "",
  });
  assert.deepEqual(validateHostInput({ sshPort: null }, true), { sshPort: null });
  assert.deepEqual(validateHostInput({ sshTarget: "[fe80::1%eth0]" }, true), { sshTarget: "[fe80::1%eth0]" });
});

test("hosts.json of the old format is migrated and written back", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pibar-hosts-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "hosts.json"), JSON.stringify([{ id: "o", name: "Alt", kind: "ssh", address: "u@srv", source: "pibar" }]));
  const store = new Store(dir);
  assert.equal(store.hosts.get("o")?.sshTarget, "srv");
  const saved = JSON.parse(readFileSync(join(dir, "hosts.json"), "utf8")) as Record<string, unknown>[];
  assert.ok(saved[0] && !("source" in saved[0]) && saved[0].sshUser === "u");
});

interface Ctx {
  store: Store;
  f: FakeHost;
  adminToken: string;
  userToken: string;
  userId: string;
  call(method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; json: unknown }>;
}

async function start(t: TestContext): Promise<Ctx> {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-hosts-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const user = await createUser("anna", "anna-pass-123", "user");
  store.saveUser(user);
  const adminToken = createToken();
  store.addToken(adminToken, admin.id);
  const userToken = createToken();
  store.addToken(userToken, user.id);
  const f = fakeHost(t);
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    commands: {
      registry: createRegistry(),
      exec: f.exec,
      // like server.ts, but every host runs on the fake host with its own Pi command
      resolveHost: (id) => {
        const h = store.hosts.get(id);
        return h ? { ...toTarget(h), piCommand: h.piCommand || f.host.piCommand } : null;
      },
      canUseHost,
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    store,
    f,
    adminToken,
    userToken,
    userId: user.id,
    async call(method, path, body, token = adminToken) {
      const res = await fetch(`${url}${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: res.status, json: await res.json() };
    },
  };
}

test("hosts CRUD: admin only, duplicate names, users see only their hosts, delete cascades", async (t) => {
  const c = await start(t);
  const body = { name: "Pi-VM", sshTarget: "pi-vm", sshUser: "root" };
  assert.equal((await c.call("POST", "/api/hosts", body, c.userToken)).status, 403);
  const created = await c.call("POST", "/api/hosts", body);
  assert.equal(created.status, 201);
  const host = created.json as HostRecord;
  assert.equal(host.sshUser, "root");
  assert.equal((await c.call("POST", "/api/hosts", { ...body, name: "pi-vm" })).status, 409);
  assert.equal((await c.call("POST", "/api/hosts", { ...body, sshTarget: "-x" })).status, 400);

  const patched = await c.call("PATCH", `/api/hosts/${host.id}`, { sshPort: 2222, defaultDir: "~/work" });
  assert.equal(patched.status, 200);
  assert.deepEqual([(patched.json as HostRecord).sshPort, (patched.json as HostRecord).name], [2222, "Pi-VM"]);
  assert.equal((await c.call("PATCH", `/api/hosts/${host.id}`, { sshPort: 2222 }, c.userToken)).status, 403);

  // users see nothing until the host is assigned
  assert.deepEqual((await c.call("GET", "/api/hosts", undefined, c.userToken)).json, []);
  await c.call("PATCH", `/api/users/${c.userId}`, { hostIds: [host.id] });
  assert.deepEqual(((await c.call("GET", "/api/hosts", undefined, c.userToken)).json as HostRecord[]).map((h) => h.id), [host.id]);

  assert.equal((await c.call("DELETE", `/api/hosts/${host.id}`)).status, 200);
  assert.deepEqual(c.store.users.get(c.userId)?.hostIds, []);
  assert.equal((await c.call("DELETE", `/api/hosts/${host.id}`)).status, 404);
});

test("host commands: test_host and list_sessions reach the host; users only on their hosts", async (t) => {
  const c = await start(t);
  const host = (await c.call("POST", "/api/hosts", { name: "Fake", sshTarget: "fake", piCommand: "echo pi 9.9.9 #" }))
    .json as HostRecord;
  const tested = await c.call("POST", "/api/cmd/test_host", { hostId: host.id });
  assert.deepEqual(tested, { status: 200, json: { result: "pi 9.9.9" } });

  c.f.writeSession("--w--", "a.jsonl", [
    { type: "session", id: "s1", cwd: "/w" },
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Hallo" }] } },
  ]);
  assert.equal((await c.call("POST", "/api/cmd/list_sessions", { hostId: host.id }, c.userToken)).status, 403);
  await c.call("PATCH", `/api/users/${c.userId}`, { hostIds: [host.id] });
  const list = await c.call("POST", "/api/cmd/list_sessions", { hostId: host.id }, c.userToken);
  assert.equal(list.status, 200);
  const sessions = (list.json as { result: { id: string; title: string }[] }).result;
  assert.deepEqual(sessions.map((s) => [s.id, s.title]), [["s1", "Hallo"]]);
  assert.equal((await c.call("POST", "/api/cmd/list_sessions", { hostId: "nope" })).status, 404);
});
