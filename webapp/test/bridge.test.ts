// Client bridge (client/src/bridge.ts) against a real server: invoke() reaches the command router, failures reject
// with the error string like Tauri, 401 calls the handler, listen/emit deliver events.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { configureBridge, dispatchEvent, emit, invoke, listen, setUnauthorizedHandler } from "../client/src/bridge.js";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken } from "../src/server/auth.js";
import { CommandError } from "../src/server/commands.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import { Store } from "../src/server/store.js";
import { fakeHost } from "./fakeHost.js";

async function start(t: TestContext): Promise<{ url: string; token: string }> {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-bridge-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const token = createToken();
  store.addToken(token, admin.id);
  const f = fakeHost(t);
  const registry = createRegistry()
    .register("echo_args", { run: (_ctx, args) => args })
    .register("fails", {
      run: () => {
        throw new CommandError(409, "Session is open elsewhere");
      },
    });
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    commands: { registry, exec: f.exec, resolveHost: () => null, canUseHost },
  });
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, token };
}

function withToken(token: string): typeof fetch {
  return (input, init) =>
    fetch(input, { ...init, headers: { ...(init?.headers as Record<string, string>), Authorization: `Bearer ${token}` } });
}

test("invoke: result, arguments as the body, errors as strings", async (t) => {
  const { url, token } = await start(t);
  configureBridge({ base: url, fetch: withToken(token) });
  assert.deepEqual(await invoke("ping"), { pong: true, username: "admin", role: "admin" });
  assert.deepEqual(await invoke("echo_args", { hostId: "h", paths: ["a"] }), { hostId: "h", paths: ["a"] });
  await assert.rejects(invoke("fails"), (e: unknown) => e === "Session is open elsewhere");
  await assert.rejects(invoke("term_open", { hostId: "h" }), (e: unknown) => e === "Unknown command: term_open");
});

test("invoke: 401 calls the unauthorized handler; unreachable server rejects", async (t) => {
  const { url } = await start(t);
  let called = 0;
  setUnauthorizedHandler(() => called++);
  configureBridge({ base: url, fetch: withToken("bogus") });
  await assert.rejects(invoke("ping"), (e: unknown) => e === "Unauthorized");
  assert.equal(called, 1);
  setUnauthorizedHandler(null);
  configureBridge({ base: "http://127.0.0.1:1", fetch: (...a) => fetch(...a) });
  await assert.rejects(invoke("ping"), (e: unknown) => e === "Server not reachable");
});

test("listen/emit/dispatchEvent and unlisten", async () => {
  const got: unknown[] = [];
  const unlisten = await listen<{ handle: number }>("pi-event", (e) => got.push(e.payload.handle));
  dispatchEvent("pi-event", { handle: 1 });
  await emit("pi-event", { handle: 2 });
  dispatchEvent("other", { handle: 3 });
  unlisten();
  dispatchEvent("pi-event", { handle: 4 });
  assert.deepEqual(got, [1, 2]);
});
