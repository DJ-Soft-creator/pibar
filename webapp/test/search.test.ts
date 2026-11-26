// Search, export and touches of sessions (port of sessions.rs, task B4): the Rust test cases, the real scripts on the
// fake host, and the commands search_sessions / read_session_file / session_touches through the router (host rights).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken, createUser } from "../src/server/auth.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import { toTarget, type HostRecord } from "../src/server/hosts.js";
import {
  DL_TOO_LARGE,
  parseDownload,
  parseHits,
  readSessionFile,
  searchQuery,
  searchScript,
  searchSessions,
  sessionTouches,
  SNIPPET_CHARS,
  snippetFor,
  snippetWindow,
  touchedByMessage,
} from "../src/server/host/sessions.js";
import { Store } from "../src/server/store.js";
import { fakeHost } from "./fakeHost.js";

const userMsg = (id: string, text: string) => ({
  type: "message",
  id,
  message: { role: "user", content: [{ type: "text", text }] },
});

test("touchedByMessage: files per own message (sessions.rs: files_per_own_message)", () => {
  const lines = [
    { type: "message", id: "u1", message: { role: "user", content: [{ type: "text", text: "Mach was" }] } },
    {
      type: "message",
      id: "a1",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "c1", name: "edit", arguments: { path: "/work/a.ts" } },
          { type: "toolCall", id: "c2", name: "write", arguments: { file_path: "b.ts" } },
          { type: "toolCall", id: "c3", name: "bash", arguments: { command: "rm x" } },
          { type: "toolCall", id: "c4", name: "edit", arguments: { path: "/work/a.ts" } },
        ],
      },
    },
    { type: "message", id: "u2", message: { role: "user", content: "weiter" } },
    { type: "message", id: "t1", message: { role: "toolResult", content: [{ type: "text", text: 'sag "type":"toolCall"' }] } },
  ];
  const per = touchedByMessage(lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  assert.equal(per.length, 2);
  assert.deepEqual(per[0], { id: "u1", paths: ["/work/a.ts", "b.ts"] });
  assert.deepEqual(per[1], { id: "u2", paths: [] });
  // a tool call before the first own message has no bucket; broken lines are skipped
  assert.deepEqual(touchedByMessage(`{broken\n${JSON.stringify(lines[1])}\n`), []);
});

test("snippetFor: text around the match, tool arguments (sessions.rs: finds_the_text_around_the_match)", () => {
  const raw = JSON.stringify(userMsg("u", "Bitte die Suche über alle Sessions bauen"));
  assert.deepEqual(snippetFor(raw, "suche"), ["user", "Bitte die Suche über alle Sessions bauen"]);
  const tool = JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", name: "bash", arguments: { command: "grep -r TODO src" } }] },
  });
  assert.deepEqual(snippetFor(tool, "todo"), ["assistant", "grep -r TODO src"]);
});

test("snippetFor: a cut-off line still gives a snippet (sessions.rs: a_cut_off_line_still_gives_a_snippet)", () => {
  const raw = String.raw`{"type":"message","message":{"role":"toolResult","content":[{"type":"text","text":"zwei Zeilen\nmit dem Treffer";`;
  const [role, snippet] = snippetFor(raw, "treffer");
  assert.equal(role, "toolResult");
  assert.ok(snippet.includes("mit dem Treffer"), snippet);
  assert.ok(!snippet.includes("\\n"), snippet);
});

test("snippetWindow: long texts are shortened (sessions.rs: long_texts_are_shortened)", () => {
  const text = `${"a ".repeat(200)} Treffer ${"b ".repeat(200)}`;
  const win = snippetWindow(text, "treffer") ?? "";
  assert.ok(win.length < SNIPPET_CHARS + 40, String(win.length));
  assert.ok(win.startsWith("…") && win.endsWith("…"));
  assert.equal(snippetWindow(text, "nichts"), null);
});

test("parseHits: one hit per file, foreign paths dropped (sessions.rs: parses_one_hit_per_file)", () => {
  const line = JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text: "die Suche" }] } });
  const header = JSON.stringify({ type: "session", id: "s1", cwd: "/work/pibar" });
  const first = JSON.stringify(userMsg("u", "Bau eine Suche"));
  const hit = (path: string) => `${path}\t${header}\t${first}\t${line}`;
  const out = [
    "willkommen im login-shell",
    hit("/s/u/.pi/agent/sessions/a/1.jsonl"),
    hit("/s/u/.pi/agent/sessions/a/2.jsonl"),
    hit("/s/u/.pi/agent/sessions/a/1.jsonl"),
  ].join("\n");
  const hits = parseHits(out, "suche");
  assert.equal(hits.length, 2);
  assert.deepEqual(hits[0], {
    path: "/s/u/.pi/agent/sessions/a/1.jsonl",
    cwd: "/work/pibar",
    title: "Bau eine Suche",
    role: "assistant",
    snippet: "die Suche",
  });
  assert.deepEqual(parseHits("/etc/passwd\t\t\troot", "root"), []);
});

test("parseHits: a match behind a cut is still a hit (sessions.rs: a_match_behind_a_cut_is_still_a_hit)", () => {
  const raw = String.raw`{"type":"message","message":{"role":"assistant","content":[{"type":"text","text":"Anfang ohne den Treffer";`;
  const hits = parseHits(`/s/u/.pi/agent/sessions/a/1.jsonl\t\t\t${raw}\n`, "treffer");
  assert.equal(hits.length, 1);
  assert.ok(hits[0]?.snippet.includes("Anfang ohne"), hits[0]?.snippet);
});

test("searchScript quotes the query (sessions.rs: search_script_quotes_the_query)", () => {
  const script = searchScript("it's $(rm -rf ~)");
  assert.ok(script.includes(`'it'\\''s $(rm -rf ~)'`));
  assert.ok(script.includes("grep -i -H -m1 -F --"));
  assert.equal(searchQuery("  a \n  b  "), "a b");
  assert.equal([...searchQuery("x".repeat(300))].length, 200);
});

test("searchSessions on the fake host (sessions.rs: search_script_reads_the_files)", async (t) => {
  const f = fakeHost(t);
  f.writeSession("--work--", "a.jsonl", [
    { type: "session", id: "s1", cwd: "/work/pibar" },
    userMsg("u1", "Bau eine Suche"),
    { type: "message", id: "a1", message: { role: "assistant", content: [{ type: "text", text: "Die Suche steht" }] } },
  ]);
  f.writeSession("--work--", "b.jsonl", [{ type: "session", id: "s2" }]);
  const hits = await searchSessions(f.exec, f.host, "Suche");
  assert.equal(hits.length, 1);
  assert.equal(hits[0]?.cwd, "/work/pibar");
  assert.equal(hits[0]?.title, "Bau eine Suche");
  // the first matching line is the own message here, not the answer
  assert.deepEqual([hits[0]?.role, hits[0]?.snippet], ["user", "Bau eine Suche"]);
  // one letter is not searched, a query with quotes and $() is only text
  assert.deepEqual(await searchSessions(f.exec, f.host, " S "), []);
  assert.deepEqual(await searchSessions(f.exec, f.host, `it's $(touch ${f.home}/pwned)`), []);
  assert.equal(existsSync(join(f.home, "pwned")), false);
  // no sessions folder at all
  await f.exec.runShell(f.host, 'rm -rf "$HOME/.pi"');
  assert.deepEqual(await searchSessions(f.exec, f.host, "Suche"), []);
});

test("readSessionFile: whole file, only session files (sessions.rs: export_only_reads_session_files)", async (t) => {
  const f = fakeHost(t);
  const path = f.writeSession("--w--", "it's ä.jsonl", [{ type: "session", id: "s1" }, userMsg("u1", "Grüße \t und\nZeilen")]);
  const text = await readSessionFile(f.exec, f.host, path);
  assert.equal(text.split("\n").filter(Boolean).length, 2);
  assert.equal((JSON.parse(text.split("\n")[1] ?? "") as { id: string }).id, "u1");
  await assert.rejects(readSessionFile(f.exec, f.host, "/home/u/notes.jsonl"), /Not a Pi session file/);
  await assert.rejects(readSessionFile(f.exec, f.host, `${f.sessionsDir}/../../.bashrc`), /Not a Pi session file/);
  await assert.rejects(readSessionFile(f.exec, f.host, `${f.sessionsDir}/--w--/missing.jsonl`));
  // not UTF-8
  const bad = join(f.sessionsDir, "--w--", "bad.jsonl");
  writeFileSync(bad, Buffer.from([0xff, 0xfe, 0x00]));
  await assert.rejects(readSessionFile(f.exec, f.host, bad), /not valid UTF-8/);
});

test("parseDownload: payload checked (files.rs: download_payload_is_checked)", () => {
  assert.equal(parseDownload("aGk=\n").toString(), "hi");
  assert.equal(parseDownload("").length, 0);
  assert.throws(() => parseDownload(DL_TOO_LARGE), /too large/);
  assert.throws(() => parseDownload("!!!"), /Invalid download data/);
});

test("sessionTouches on the fake host", async (t) => {
  const f = fakeHost(t);
  const path = f.writeSession("--w--", "a.jsonl", [
    { type: "session", id: "s1", cwd: "/w" },
    userMsg("u1", "Ändere a"),
    {
      type: "message",
      id: "a1",
      message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "edit", arguments: { path: "src/a.ts" } }] },
    },
    userMsg("u2", "Nichts"),
  ]);
  assert.deepEqual(await sessionTouches(f.exec, f.host, path), [
    { id: "u1", paths: ["src/a.ts"] },
    { id: "u2", paths: [] },
  ]);
  await assert.rejects(sessionTouches(f.exec, f.host, "/etc/passwd"), /Not a Pi session file/);
});

async function start(t: TestContext) {
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-search-test-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const user = await createUser("user", "user-pass-123", "user");
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
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = async (name: string, body: unknown, token = adminToken) => {
    const res = await fetch(`${url}/api/cmd/${name}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { result?: unknown; error?: string } };
  };
  const host: HostRecord = { id: "h1", name: "Fake", sshTarget: "host.example", sshUser: "", sshPort: null, piCommand: "", defaultDir: "", colorProfile: "" };
  store.saveHost(host);
  return { store, f, call, host, userToken, userId: user.id };
}

test("commands search_sessions, read_session_file, session_touches: host rights and arguments", async (t) => {
  const c = await start(t);
  const path = c.f.writeSession("--w--", "a.jsonl", [{ type: "session", id: "s1", cwd: "/w" }, userMsg("u1", "Finde mich")]);
  const hits = await c.call("search_sessions", { hostId: c.host.id, query: "finde" });
  assert.equal(hits.status, 200);
  assert.deepEqual((hits.json.result as { path: string }[]).map((h) => h.path), [path]);
  const file = await c.call("read_session_file", { hostId: c.host.id, path });
  assert.match(String(file.json.result), /Finde mich/);
  const touches = await c.call("session_touches", { hostId: c.host.id, path });
  assert.deepEqual(touches.json.result, [{ id: "u1", paths: [] }]);
  // a user without the host gets 403 on every one of them
  for (const [name, args] of [
    ["search_sessions", { query: "finde" }],
    ["read_session_file", { path }],
    ["session_touches", { path }],
  ] as const) {
    assert.equal((await c.call(name, { hostId: c.host.id, ...args }, c.userToken)).status, 403, name);
  }
  assert.equal((await c.call("read_session_file", { hostId: c.host.id, path: "/etc/passwd" })).status, 500);
  assert.equal((await c.call("search_sessions", { hostId: c.host.id })).status, 400);
});
