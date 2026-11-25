// Pi processes (tasks B9/B10): PiManager against the fake Pi, joining a running session, replay after a reconnect,
// idle sweep, and the whole way through the server: pi_attach, WebSocket subscribe, prompt, live events, access.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken, createUser } from "../src/server/auth.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import { PiManager, toolArgs } from "../src/server/host/pi.js";
import { toTarget, type HostRecord } from "../src/server/hosts.js";
import { Store } from "../src/server/store.js";
import { createSocketHub } from "../src/server/ws.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

type Ev = { type?: string; [k: string]: unknown };

function session(f: FakeHost): string {
  return f.writeSession("--w--", "s.jsonl", [
    { type: "session", id: "s1", cwd: "/w" },
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Hallo" }] } },
  ]);
}

function manager(t: TestContext, f: FakeHost): { pi: PiManager; events: { handle: number; seq: number; ev: Ev }[]; exits: number[] } {
  const pi = new PiManager(f.exec);
  const events: { handle: number; seq: number; ev: Ev }[] = [];
  const exits: number[] = [];
  pi.setListener({
    onEvent: (handle, seq, ev) => events.push({ handle, seq, ev: ev as Ev }),
    onExit: (handle) => exits.push(handle),
  });
  t.after(() => pi.closeAll());
  return { pi, events, exits };
}

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

test("toolArgs (pi.rs: tool_args)", () => {
  assert.deepEqual(toolArgs(null), []);
  assert.deepEqual(toolArgs([]), ["--no-tools"]);
  assert.deepEqual(toolArgs(["read", " bash ", "x;rm"]), ["--tools", "read,bash"]);
});

test("PiManager: RPC answer, streamed answer with sequence numbers, streaming flag", async (t) => {
  const f = fakeHost(t);
  const { pi, events } = manager(t, f);
  const { handle, joined } = pi.open(f.host, "~", { sessionPath: session(f) });
  assert.equal(joined, false);
  const state = await pi.send(handle, { type: "get_state" });
  assert.equal(state.success, true);
  const msgs = (await pi.send(handle, { type: "get_messages" })) as { data?: { messages?: unknown[] } };
  assert.equal(msgs.data?.messages?.length, 1);
  await pi.send(handle, { type: "prompt", message: "Wie geht's?" });
  await until(() => events.some((e) => e.ev.type === "agent_start"));
  assert.equal(pi.info(handle)?.streaming, true);
  await until(() => events.some((e) => e.ev.type === "agent_settled"));
  assert.equal(pi.info(handle)?.streaming, false);
  assert.ok(events.some((e) => (e.ev.assistantMessageEvent as Ev | undefined)?.type === "text_delta"));
  assert.deepEqual(
    events.map((e) => e.seq),
    events.map((_, i) => i + 1),
  );
});

test("PiManager: the same session is joined, not started twice; replay after a gap", async (t) => {
  const f = fakeHost(t);
  const { pi, events } = manager(t, f);
  const path = session(f);
  const a = pi.open(f.host, "~", { sessionPath: path });
  const b = pi.open(f.host, "~", { sessionPath: path });
  assert.deepEqual([b.handle, b.joined], [a.handle, true]);
  await pi.send(a.handle, { type: "prompt", message: "x" });
  await until(() => events.some((e) => e.ev.type === "agent_settled"));
  const all = pi.replay(a.handle, 0);
  assert.equal(all.complete, true);
  assert.equal(all.events.length, events.length);
  const tail = pi.replay(a.handle, 3);
  assert.deepEqual(
    tail.events.map((e) => e.seq),
    events.slice(3).map((e) => e.seq),
  );
  assert.equal(pi.replay(999, 0).complete, false);
});

test("PiManager: close ends the process and wakes waiting commands; sweep closes idle unwatched processes", async (t) => {
  const f = fakeHost(t);
  const { pi, exits } = manager(t, f);
  const a = pi.open(f.host, "~").handle;
  const b = pi.open(f.host, "~").handle;
  await pi.send(a, { type: "get_state" });
  pi.close(a);
  await until(() => exits.includes(a));
  await assert.rejects(pi.send(a, { type: "get_state" }), /not found/);
  pi.sweep((h) => h === b, 0, Date.now() + 1000);
  assert.ok(pi.info(b), "watched processes stay");
  pi.sweep(() => false, 0, Date.now() + 1000);
  assert.equal(pi.info(b), null);
});

// ------------------------------------------------------------------ through the server

interface Srv {
  url: string;
  pi: PiManager;
  host: HostRecord;
  adminToken: string;
  annaToken: string;
  sessionPath: string;
  cmd(name: string, args: unknown, token?: string): Promise<{ status: number; json: Record<string, unknown> }>;
  socket(token?: string): Promise<{ ws: WebSocket; msgs: Record<string, unknown>[] }>;
}

async function serve(t: TestContext): Promise<Srv> {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-pi-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const anna = await createUser("anna", "anna-pass-123", "user", []);
  store.saveUser(anna);
  const adminToken = createToken();
  store.addToken(adminToken, admin.id);
  const annaToken = createToken();
  store.addToken(annaToken, anna.id);
  const f = fakeHost(t);
  const host: HostRecord = {
    id: "h1",
    name: "Fake",
    sshTarget: "fake",
    sshUser: "",
    sshPort: null,
    piCommand: f.host.piCommand,
    defaultDir: "",
    colorProfile: "",
  };
  store.saveHost(host);
  const pi = new PiManager(f.exec);
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
  const hub = createSocketHub(server, store, pi);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    await hub.close();
    server.closeAllConnections();
    server.close();
  });
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    pi,
    host,
    adminToken,
    annaToken,
    sessionPath: session(f),
    async cmd(name, args, token = adminToken) {
      const res = await fetch(`${url}/api/cmd/${name}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify(args),
      });
      return { status: res.status, json: (await res.json()) as Record<string, unknown> };
    },
    async socket(token = adminToken) {
      const ws = new WebSocket(`${url.replace("http", "ws")}/ws`, { headers: { Authorization: `Bearer ${token}` } });
      const msgs: Record<string, unknown>[] = [];
      ws.on("message", (d) => msgs.push(JSON.parse(String(d)) as Record<string, unknown>));
      await once(ws, "open");
      t.after(() => ws.terminate());
      return { ws, msgs };
    },
  };
}

const piEvents = (msgs: Record<string, unknown>[]) =>
  msgs.filter((m) => m.event === "pi-event").map((m) => (m.payload as { event: Ev }).event);

test("server: pi_attach, subscribe, prompt, live events; a second attach joins; replay after reconnect", async (t) => {
  const s = await serve(t);
  const attached = await s.cmd("pi_attach", { hostId: s.host.id, cwd: "~", sessionPath: s.sessionPath });
  assert.equal(attached.status, 200);
  const { handle, joined } = attached.json.result as { handle: number; joined: boolean };
  assert.equal(joined, false);

  const one = await s.socket();
  one.ws.send(JSON.stringify({ type: "subscribe", handle, since: 0 }));
  await until(() => one.msgs.some((m) => m.type === "pi/subscribed"));

  const sent = await s.cmd("pi_send", { handle, cmd: { type: "prompt", message: "Hi" } });
  assert.equal(sent.status, 200);
  await until(() => piEvents(one.msgs).some((e) => e.type === "agent_settled"));

  const again = await s.cmd("pi_attach", { hostId: s.host.id, cwd: "~", sessionPath: s.sessionPath });
  assert.deepEqual((again.json.result as { handle: number; joined: boolean }).joined, true);

  // reconnect after seq 2: everything after it comes again, in order
  const two = await s.socket();
  two.ws.send(JSON.stringify({ type: "subscribe", handle, since: 2 }));
  await until(() => piEvents(two.msgs).some((e) => e.type === "agent_settled"));
  const seqs = two.msgs.filter((m) => m.event === "pi-event").map((m) => m.seq as number);
  assert.equal(seqs[0], 3);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b));
  assert.equal(seqs.length, piEvents(one.msgs).length - 2);
});

test("server: users without the host get neither the process nor its events", async (t) => {
  const s = await serve(t);
  const { handle } = (await s.cmd("pi_attach", { hostId: s.host.id, cwd: "~" })).json.result as { handle: number };
  assert.equal((await s.cmd("pi_attach", { hostId: s.host.id, cwd: "~" }, s.annaToken)).status, 403);
  assert.equal((await s.cmd("pi_send", { handle, cmd: { type: "get_state" } }, s.annaToken)).status, 404);
  assert.equal((await s.cmd("pi_close", { handle }, s.annaToken)).status, 404);
  const anna = await s.socket(s.annaToken);
  anna.ws.send(JSON.stringify({ type: "subscribe", handle, since: 0 }));
  await until(() => anna.msgs.some((m) => m.type === "pi/denied"));
  assert.equal((await s.cmd("pi_send", { handle, cmd: { type: "nope" } })).status, 200);
  assert.equal((await s.cmd("pi_send", { handle, cmd: "x" })).status, 400);
  assert.equal((await s.cmd("pi_attach", { hostId: s.host.id, sessionPath: "/etc/passwd" })).status, 400);
  assert.equal((await s.cmd("pi_close", { handle })).status, 200);
  assert.equal(s.pi.info(handle), null);
});
