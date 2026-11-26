// Session lock against the desktop app (tasks B9, D1): FNV-1a like bg.rs, the lock the start script writes, stale
// locks, a foreign live owner (a second PiManager with a "desktop" owner plays the desktop app), take-over with
// force, and the error the commands pi_open / pi_attach give the client.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken } from "../src/server/auth.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import {
  claimSession,
  fnv1a,
  lockCheckScript,
  lockPath,
  lockTakeoverScript,
  lockWritePrefix,
  parseLockLine,
  SessionLockedError,
} from "../src/server/host/lock.js";
import { PiManager } from "../src/server/host/pi.js";
import { toTarget, type HostRecord } from "../src/server/hosts.js";
import { Store } from "../src/server/store.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

function session(f: FakeHost, name = "s.jsonl"): string {
  return f.writeSession("--w--", name, [{ type: "session", id: "s1", cwd: "/w" }]);
}

const lockFile = (f: FakeHost, path: string) => join(f.home, ".pibar", `${fnv1a(path)}.lock`);

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

function manager(t: TestContext, f: FakeHost, owner: string) {
  const pi = new PiManager(f.exec, { lockOwner: owner });
  const exits: number[] = [];
  pi.setListener({ onEvent: () => {}, onExit: (h) => exits.push(h) });
  t.after(() => pi.closeAll());
  return { pi, exits };
}

/** Wait until the start script wrote its lock (Pi is running then) */
async function lockWritten(f: FakeHost, path: string) {
  await until(() => existsSync(lockFile(f, path)) && readFileSync(lockFile(f, path), "utf8").trim().split(" ").length === 3);
}

test("fnv1a is bg.rs's hash (FNV-1a 64, 16 hex digits)", () => {
  assert.equal(fnv1a("/a/b/c.jsonl"), "76d5cfaef7a0f99a");
  assert.equal(fnv1a("x").length, 16);
  assert.notEqual(fnv1a("ä"), fnv1a("a"));
  assert.match(lockPath("/a/b/c.jsonl"), /^"\$HOME"\/\.pibar\/76d5cfaef7a0f99a\.lock$/);
});

test("scripts quote the session path and owner", () => {
  const evil = "/tmp/$(touch pwned)'x.jsonl";
  // the path only appears inside the grep pattern, single-quoted (the lock file name is its hash)
  for (const s of [lockCheckScript(evil), lockTakeoverScript(evil)]) {
    assert.ok(s.includes(`-e '/tmp/$(touch pwned)'\\''x.jsonl'`), s);
  }
  assert.ok(!lockWritePrefix("desktop:1", evil).includes("touch pwned"));
  assert.ok(lockWritePrefix("webapp:a b;rm", "/x.jsonl").includes("'webapp:abrm'"));
  assert.deepEqual(parseLockLine("desktop:ab12 4242 1700000000\n"), { owner: "desktop:ab12", kind: "desktop", pid: 4242, since: 1700000000 });
  assert.equal(parseLockLine(""), null);
  assert.equal(parseLockLine("garbage"), null);
});

test("lock: written by the start script with Pi's pid; stale and foreign-process locks are free", async (t) => {
  const f = fakeHost(t);
  const path = session(f);
  // no lock
  assert.equal(parseLockLine(await f.exec.runShell(f.host, lockCheckScript(path))), null);
  // a dead pid
  mkdirSync(join(f.home, ".pibar"), { recursive: true });
  writeFileSync(lockFile(f, path), "desktop:dead 999999 1700000000\n");
  assert.equal(parseLockLine(await f.exec.runShell(f.host, lockCheckScript(path))), null);
  // a live pid of a process that is not this session's Pi (pid reuse)
  writeFileSync(lockFile(f, path), `desktop:reuse ${process.pid} 1700000000\n`);
  assert.equal(parseLockLine(await f.exec.runShell(f.host, lockCheckScript(path))), null);

  const { pi } = manager(t, f, "webapp:test");
  const { handle } = await pi.openChecked(f.host, "~", { sessionPath: path });
  await pi.send(handle, { type: "get_state" });
  await lockWritten(f, path);
  const holder = parseLockLine(await f.exec.runShell(f.host, lockCheckScript(path)));
  assert.equal(holder?.owner, "webapp:test");
  assert.ok(Math.abs((holder?.since ?? 0) - Date.now() / 1000) < 60);
  // own lock: opening again joins, and after a close the same server may start it again
  assert.equal((await pi.openChecked(f.host, "~", { sessionPath: path })).joined, true);
  pi.close(handle);
  const again = await pi.openChecked(f.host, "~", { sessionPath: path });
  assert.equal(again.joined, false);
  // new sessions (no file yet) write no lock
  await pi.openChecked(f.host, "~", {});
});

test("lock: a live foreign owner blocks; force stops it and takes over", async (t) => {
  const f = fakeHost(t);
  const path = session(f);
  const desktop = manager(t, f, "desktop:mac");
  const web = manager(t, f, "webapp:srv");
  const d = await desktop.pi.openChecked(f.host, "~", { sessionPath: path });
  await desktop.pi.send(d.handle, { type: "get_state" });
  await lockWritten(f, path);

  await assert.rejects(web.pi.openChecked(f.host, "~", { sessionPath: path }), (e: unknown) => {
    assert.ok(e instanceof SessionLockedError);
    assert.equal(e.status, 409);
    assert.match(e.message, /^session-locked:desktop:\d+ This session is open in the desktop app/);
    return true;
  });
  // other sessions are not affected
  const other = session(f, "other.jsonl");
  await web.pi.openChecked(f.host, "~", { sessionPath: other });

  const w = await web.pi.openChecked(f.host, "~", { sessionPath: path, force: true });
  await until(() => desktop.exits.includes(d.handle));
  await web.pi.send(w.handle, { type: "get_state" });
  await until(() => readFileSync(lockFile(f, path), "utf8").startsWith("webapp:srv "));
  // now the desktop is the one that is refused
  await assert.rejects(desktop.pi.openChecked(f.host, "~", { sessionPath: path }), /session-locked:webapp:/);
});

test("claimSession: nothing to take over is fine", async (t) => {
  const f = fakeHost(t);
  await claimSession(f.exec, f.host, session(f), "webapp:x", true);
});

test("server: pi_open / pi_attach give the lock error; force: true takes over", async (t) => {
  const f = fakeHost(t);
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-lock-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const token = createToken();
  store.addToken(token, admin.id);
  const host: HostRecord = { ...f.host, id: "h1", defaultDir: "", colorProfile: "" };
  store.saveHost(host);
  const pi = new PiManager(f.exec, { lockOwner: "webapp:srv" });
  t.after(() => pi.closeAll());
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    commands: {
      registry: createRegistry({ pi }),
      exec: f.exec,
      resolveHost: (id) => {
        const h = store.hosts.get(id);
        return h ? toTarget(h) : null;
      },
      canUseHost,
    },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const cmd = async (name: string, args: unknown) => {
    const res = await fetch(`${url}/api/cmd/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(args),
    });
    return { status: res.status, json: (await res.json()) as { result?: unknown; error?: string } };
  };

  const path = session(f);
  const desktop = manager(t, f, "desktop:mac");
  const d = await desktop.pi.openChecked(f.host, "~", { sessionPath: path });
  await desktop.pi.send(d.handle, { type: "get_state" });
  await lockWritten(f, path);

  for (const name of ["pi_open", "pi_attach"]) {
    const r = await cmd(name, { hostId: "h1", cwd: "~", sessionPath: path });
    assert.equal(r.status, 409, name);
    assert.match(r.json.error ?? "", /^session-locked:desktop:\d+ /);
  }
  assert.equal((await cmd("pi_attach", { hostId: "h1", sessionPath: path, force: "yes" })).status, 400);
  const taken = await cmd("pi_attach", { hostId: "h1", cwd: "~", sessionPath: path, force: true });
  assert.equal(taken.status, 200);
  await until(() => desktop.exits.includes(d.handle));
  // joining the webapp's own process needs no force
  const joined = await cmd("pi_attach", { hostId: "h1", cwd: "~", sessionPath: path });
  assert.equal((joined.json.result as { joined: boolean }).joined, true);
});
