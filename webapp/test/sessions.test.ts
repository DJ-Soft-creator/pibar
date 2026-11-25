// Sessions (port of sessions.rs): parsing with the Rust test cases, listing/outlines/delete on the fake host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  deleteSessions,
  firstText,
  isSessionFile,
  listSessions,
  parseList,
  parseOutlines,
  sessionOutlines,
} from "../src/server/host/sessions.js";
import { fakeHost } from "./fakeHost.js";

const userMsg = (id: string, text: string) => ({
  type: "message",
  id,
  parentId: null,
  message: { role: "user", content: [{ type: "text", text }] },
});

test("firstText: escapes, whitespace, cut after ~120 characters (sessions.rs: extracts_text)", () => {
  const raw = String.raw`{"type":"message","message":{"role":"user","content":[{"type":"text","text":"Hallo \"Welt\"\nzweite Zeile"}]}}`;
  assert.equal(firstText(raw), 'Hallo "Welt" zweite Zeile');
  assert.equal(firstText('{"no":"text"}'), "");
  assert.equal(firstText(`{"text":"${"a".repeat(300)}"}`).length, 121);
  // a line cut by the shell in the middle of the text
  assert.equal(firstText('{"text":"abgeschnitt'), "abgeschnitt");
});

test("parseOutlines (sessions.rs: parses_outlines)", () => {
  const out =
    "__PIBAR_OUTLINE__\t/s/a.jsonl\t1730000000\n" +
    `${JSON.stringify(userMsg("u1", "Erste Frage"))}\n` +
    `${JSON.stringify({ ...userMsg("u2", "Zweite"), parentId: "a1" })}\n` +
    "__PIBAR_OUTLINE__\t/s/b.jsonl\t\n";
  const o = parseOutlines(out);
  assert.equal(o.length, 2);
  assert.equal(o[0]?.path, "/s/a.jsonl");
  assert.equal(o[0]?.mtime, 1730000000);
  assert.deepEqual(o[0]?.users, [
    { id: "u1", text: "Erste Frage" },
    { id: "u2", text: "Zweite" },
  ]);
  assert.deepEqual([o[1]?.mtime, o[1]?.users.length], [0, 0]);
});

test("isSessionFile (sessions.rs: only_session_files_can_be_deleted)", () => {
  assert.ok(isSessionFile("/home/u/.pi/agent/sessions/--home-u--/2026-10-31_abc.jsonl"));
  assert.ok(!isSessionFile("/home/u/.pi/agent/sessions/../../.bashrc"));
  assert.ok(!isSessionFile("/home/u/notes.jsonl"));
  assert.ok(!isSessionFile("relative/sessions/x.jsonl"));
  assert.ok(!isSessionFile("/home/u/.pi/agent/sessions/x.md"));
});

test("parseList: header, title, name from session_info, parent, empty sessions skipped, login noise ignored", () => {
  const header = JSON.stringify({ type: "session", id: "s1", cwd: "/work", timestamp: "2026-11-01T10:00:00Z", parentSession: "/p.jsonl" });
  const first = JSON.stringify(userMsg("u1", "Bau   die\nSuche"));
  const info = JSON.stringify({ type: "session_info", name: "Suche" });
  const out = [
    "Welcome to the login shell",
    `/x/sessions/a/1.jsonl\t1730000000\t${header}\t${first}\t${info}`,
    `/x/sessions/a/2.jsonl\t\t${header}\t\t`,
    `/x/sessions/a/3.jsonl\tnope\t{broken\t${first}\t`,
  ].join("\n");
  const list = parseList(out);
  assert.equal(list.length, 2);
  assert.deepEqual(list[0], {
    path: "/x/sessions/a/1.jsonl",
    id: "s1",
    cwd: "/work",
    timestamp: "2026-11-01T10:00:00Z",
    title: "Bau die Suche",
    name: "Suche",
    parent: "/p.jsonl",
    modified: 1730000000,
  });
  assert.deepEqual([list[1]?.id, list[1]?.cwd, list[1]?.name, list[1]?.parent, list[1]?.modified], ["", "", null, null, 0]);
});

test("listSessions on the fake host: newest first, tabs inside messages do not break the columns", async (t) => {
  const f = fakeHost(t);
  const older = f.writeSession("--work--", "2026-11-01_a.jsonl", [
    { type: "session", id: "a", cwd: "/work", timestamp: "2026-11-01T10:00:00Z" },
    userMsg("u1", "Erste\tSession"),
  ]);
  f.writeSession("--work--", "2026-11-02_empty.jsonl", [{ type: "session", id: "e", cwd: "/work" }]);
  await new Promise((r) => setTimeout(r, 1100)); // mtime has a resolution of one second
  f.writeSession("--work--", "2026-11-02_b.jsonl", [
    { type: "session", id: "b", cwd: "/work" },
    userMsg("u1", "Zweite Session"),
    { type: "session_info", name: "Benannt" },
  ]);
  const list = await listSessions(f.exec, f.host);
  assert.deepEqual(
    list.map((s) => [s.id, s.title, s.name]),
    [
      ["b", "Zweite Session", "Benannt"],
      ["a", "Erste Session", null],
    ],
  );
  assert.equal(list[1]?.path, older);
  assert.ok((list[0]?.modified ?? 0) > 1_700_000_000);
});

test("listSessions: no sessions folder → empty list", async (t) => {
  const f = fakeHost(t);
  await f.exec.runShell(f.host, 'rm -rf "$HOME/.pi"');
  assert.deepEqual(await listSessions(f.exec, f.host), []);
});

test("sessionOutlines and deleteSessions on the fake host; paths outside sessions are refused", async (t) => {
  const f = fakeHost(t);
  const a = f.writeSession("--w--", "a.jsonl", [
    { type: "session", id: "a" },
    userMsg("u1", "Eins"),
    { type: "message", id: "x1", message: { role: "assistant", content: [{ type: "text", text: "Antwort" }] } },
    userMsg("u2", "Zwei"),
  ]);
  const outlines = await sessionOutlines(f.exec, f.host, [a, a.replace("a.jsonl", "missing.jsonl")]);
  assert.equal(outlines.length, 1);
  assert.deepEqual(outlines[0]?.users, [
    { id: "u1", text: "Eins" },
    { id: "u2", text: "Zwei" },
  ]);
  await assert.rejects(deleteSessions(f.exec, f.host, [`${f.home}/.bashrc`]), /Not a Pi session file/);
  await assert.rejects(sessionOutlines(f.exec, f.host, ["/etc/passwd"]), /Not a Pi session file/);
  assert.equal(await deleteSessions(f.exec, f.host, []), 0);
  assert.equal(await deleteSessions(f.exec, f.host, [a]), 1);
  assert.equal(existsSync(a), false);
});
