// Organisation of the session list (meta.ts) and shared settings (appConfig.ts): merge rules, host mapping, legacy
// import, persistence, commands with host rights, secrets never leave the server.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppConfigStore, keepSecrets, validateSettings, withoutSecrets } from "../src/server/appConfig.js";
import { CommandRegistry } from "../src/server/commands.js";
import { registerMetaCommands } from "../src/server/cmd/meta.js";
import type { HostRecord } from "../src/server/hosts.js";
import type { UserRecord } from "../src/server/store.js";
import { emptyState, importLegacyConfig, mapDesktopHost, mergeState, MetaStore, sessionKey, UserMetaStores } from "../src/server/meta.js";

const tmp = (t: { after(fn: () => void): void }) => {
  const d = mkdtempSync(join(tmpdir(), "pibar-meta-test-"));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

const host = (id: string, name: string, sshTarget: string, sshUser = "", sshPort: number | null = null): HostRecord => ({
  id,
  name,
  sshTarget,
  sshUser,
  sshPort,
  piCommand: "",
  defaultDir: "",
  colorProfile: "",
});

test("mergeState: newer wins, ties keep the base, tombstones travel", () => {
  const base = emptyState();
  base.sessions.a = { value: { color: "red" }, updatedAt: 10 };
  base.groups.g = { value: { id: "g", name: "G", color: "", collapsed: false }, updatedAt: 10 };
  const inc = emptyState();
  inc.sessions.a = { value: { color: "blue" }, updatedAt: 10 };
  inc.sessions.b = { value: null, updatedAt: 5 };
  inc.groups.g = { value: null, updatedAt: 11 };
  assert.equal(mergeState(base, inc), true);
  assert.deepEqual(base.sessions.a?.value, { color: "red" });
  assert.equal(base.sessions.b?.value, null);
  assert.equal(base.groups.g?.value, null);
  assert.equal(mergeState(base, inc), false);
});

test("mapDesktopHost: by name, then by SSH address", () => {
  const hosts = [host("w1", "Pi-VM", "pi-vm.lan", "root"), host("w2", "Mini", "mini.lan", "pi", 2222)];
  assert.equal(mapDesktopHost({ name: "pi-vm", address: "" }, hosts), "w1");
  assert.equal(mapDesktopHost({ name: "Other", address: "pi@mini.lan:2222" }, hosts), "w2");
  assert.equal(mapDesktopHost({ name: "Other", address: "mini.lan" }, hosts), "w2");
  assert.equal(mapDesktopHost({ name: "Local", address: "" }, hosts), null);
});

test("MetaStore: view filters by host, group delete clears sessions, persisted", (t) => {
  const dir = tmp(t);
  const m = new MetaStore(dir);
  let changes = 0;
  m.onChange(() => changes++);
  m.setSession(sessionKey("h1", "/s/a.jsonl"), { color: "red", group: "g1" });
  m.setSession(sessionKey("h2", "/s/b.jsonl"), { pinned: true });
  m.setGroup("g1", { id: "g1", name: "Work", color: "teal", collapsed: false });
  m.setProject("p1", { id: "p1", name: "PiBar", hostId: "h2", dir: "~/PiBar", collapsed: false });
  const v = m.view((h) => h === "h1");
  assert.deepEqual(Object.keys(v.sessionMeta), ["h1|/s/a.jsonl"]);
  assert.equal(v.groups.length, 1);
  assert.equal(v.projects.length, 0);
  m.setGroup("g1", null);
  assert.deepEqual(m.state.sessions["h1|/s/a.jsonl"]?.value, { color: "red" });
  m.setSession(sessionKey("h1", "/s/a.jsonl"), {});
  assert.equal(new MetaStore(dir).state.sessions["h1|/s/a.jsonl"]?.value, null);
  assert.equal(changes, 6);
});

test("importLegacyConfig: desktop ids mapped, unknown hosts skipped", (t) => {
  const m = new MetaStore(tmp(t));
  importLegacyConfig(
    m,
    {
      sessions: [
        { id: "d1|/s/a.jsonl", name: "A", color: "blue", pinned: true },
        { id: "d9|/s/x.jsonl", name: "X", color: "", pinned: false },
      ],
      groups: [{ id: "g", name: "G", color: "red", collapsed: true }],
      projects: [{ id: "p", name: "P", hostId: "d1", dir: "~/p" }],
      hosts: [
        { id: "d1", name: "pi-vm", address: "root@pi-vm.lan" },
        { id: "d9", name: "Laptop", address: "" },
      ],
    },
    "2026-11-01T00:00:00Z",
    [host("w1", "Pi-VM", "pi-vm.lan", "root")],
  );
  assert.deepEqual(m.state.sessions["w1|/s/a.jsonl"]?.value, { name: "A", color: "blue", pinned: true });
  assert.equal(Object.keys(m.state.sessions).length, 1);
  assert.equal(m.state.projects.p?.value?.hostId, "w1");
  assert.ok(m.exists);
});

test("app config: validation, secrets hidden and kept, file mode 0600", (t) => {
  const dir = tmp(t);
  assert.match(String(validateSettings({ presets: "x" })), /presets/);
  const s = new AppConfigStore(dir);
  s.save({ ...s.settings, voice: { stt: { provider: "api", apiKey: "sk-secret" } }, presets: [{ id: "p", name: "Fast" }] });
  const pub = s.publicConfig();
  assert.deepEqual(pub.voice, { stt: { provider: "api", apiKey: "", apiKeySet: true } });
  // the admin saves what he got: the key stays
  s.save({ ...pub, presets: [] });
  assert.equal((s.settings.voice.stt as { apiKey: string }).apiKey, "sk-secret");
  assert.equal(statSync(join(dir, "app-config.json")).mode & 0o777, 0o600);
  assert.equal(new AppConfigStore(dir).settings.presets.length, 0);
  assert.deepEqual(withoutSecrets([{ apiKey: "" }]), [{ apiKey: "", apiKeySet: false }]);
  assert.deepEqual(keepSecrets({ apiKey: "new", apiKeySet: true }, { apiKey: "old" }), { apiKey: "new" });
});

test("meta commands: host rights on session keys and projects; every user has an own organisation", async (t) => {
  const dir = tmp(t);
  const metas = new UserMetaStores(dir);
  const reg = new CommandRegistry();
  registerMetaCommands(reg, metas, new AppConfigStore(dir));
  const user = { id: "u1", role: "user", hostIds: ["h1"] } as unknown as UserRecord;
  const other = { id: "u2", role: "user", hostIds: ["h1"] } as unknown as UserRecord;
  const ctx = { user } as never;
  const run = (name: string, args: Record<string, unknown>) => reg.get(name)?.run(ctx, args);
  await run("meta_set_session", { key: "h1|/s/a.jsonl", meta: { color: "red" } });
  assert.throws(() => run("meta_set_session", { key: "h2|/s/b.jsonl", meta: {} }), /No access/);
  assert.throws(() => run("meta_save_project", { project: { id: "p", name: "P", hostId: "h2", dir: "~" } }), /No access/);
  await run("meta_save_group", { group: { id: "g", name: "G" } });
  const view = (await run("meta_get", {})) as { sessionMeta: object; groups: unknown[] };
  assert.deepEqual(Object.keys(view.sessionMeta), ["h1|/s/a.jsonl"]);
  assert.equal(view.groups.length, 1);
  const otherView = (await reg.get("meta_get")?.run({ user: other } as never, {})) as { sessionMeta: object; groups: unknown[] };
  assert.deepEqual(otherView, { sessionMeta: {}, groups: [], projects: [] });
  const cfg = (await run("app_config_get", {})) as { presets: unknown[] };
  assert.deepEqual(cfg.presets, []);
});
