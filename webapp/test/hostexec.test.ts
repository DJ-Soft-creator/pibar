// HostExec: quoting (same cases as the Rust tests in src-tauri/src/hostexec.rs), ssh arguments, scripts and Pi
// against the fake host.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { piScript, shellPath, sq, sshArgs, type HostTarget } from "../src/server/host/hostexec.js";
import { fakeHost } from "./fakeHost.js";

const host: HostTarget = { id: "h", name: "H", sshTarget: "server", sshUser: "", sshPort: null, piCommand: "" };

test("sq quotes single quotes", () => {
  assert.equal(sq("a b"), "'a b'");
  assert.equal(sq("it's"), "'it'\\''s'");
});

test("shellPath keeps ~ expandable", () => {
  assert.equal(shellPath("~"), '"$HOME"');
  assert.equal(shellPath(""), '"$HOME"');
  assert.equal(shellPath("~/my dir"), "\"$HOME\"/'my dir'");
  assert.equal(shellPath("/opt/x"), "'/opt/x'");
});

test("injection stays quoted", () => {
  assert.equal(shellPath("/tmp/$(rm -rf ~)"), "'/tmp/$(rm -rf ~)'");
});

test("sshArgs: user, port, target after --", () => {
  const args = sshArgs({ ...host, sshUser: "pi", sshPort: 2222 });
  assert.ok(args.includes("BatchMode=yes"));
  assert.deepEqual(args.slice(-4), ["-p", "2222", "--", "pi@server"]);
  assert.ok(!args.includes("-F"), "without an ssh dir the user's own ssh config applies");
});

test("sshArgs: target that looks like an option cannot become one", () => {
  const args = sshArgs({ ...host, sshTarget: "-oProxyCommand=touch /tmp/x" });
  assert.equal(args.at(-2), "--");
});

test("sshArgs: ssh dir gives key, known_hosts, strict checking, no user config", (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pibar-ssh-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "id_ed25519"), "key");
  const args = sshArgs(host, { dir });
  assert.deepEqual(args.slice(args.indexOf("-F"), args.indexOf("-F") + 2), ["-F", "/dev/null"]);
  assert.ok(args.includes(join(dir, "id_ed25519")));
  assert.ok(args.includes(`UserKnownHostsFile=${join(dir, "known_hosts")}`));
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  writeFileSync(join(dir, "config"), "Host x\n");
  assert.ok(sshArgs(host, { dir }).includes(join(dir, "config")));
});

test("piScript: cd, exec, quoted args", () => {
  assert.equal(
    piScript({ ...host, piCommand: "" }, "~/my dir", "rpc", ["--session", "/a b.jsonl"]),
    "cd \"$HOME\"/'my dir' && exec pi --mode rpc '--session' '/a b.jsonl'",
  );
});

test("runShell: runs on the fake host with its $HOME, stdin and errors", async (t) => {
  const f = fakeHost(t);
  f.writeSession("--home--", "a.jsonl", [{ type: "session", id: "s1" }]);
  const out = await f.exec.runShell(f.host, 'ls "$HOME"/.pi/agent/sessions/*/*.jsonl');
  assert.match(out, /a\.jsonl/);
  assert.equal(await f.exec.runShell(f.host, "cat", { stdin: "hello" }), "hello");
  await assert.rejects(f.exec.runShell(f.host, "echo broken >&2; exit 3"), /broken/);
  await assert.rejects(f.exec.runShell(f.host, "exit 4"), /Exit code 4/);
  await assert.rejects(f.exec.runShell(f.host, "sleep 5", { timeoutMs: 100 }), /Timeout/);
});

test("spawnPi: fake Pi answers an RPC command", async (t) => {
  const f = fakeHost(t);
  const child = f.exec.spawnPi(f.host, "~");
  t.after(() => {
    child.kill();
  });
  const lines = createInterface({ input: child.stdout });
  child.stdin.write(JSON.stringify({ type: "get_state", id: "1" }) + "\n");
  for await (const line of lines) {
    const msg = JSON.parse(line) as { type?: string; id?: string; success?: boolean };
    if (msg.type === "response" && msg.id === "1") {
      assert.equal(msg.success, true);
      break;
    }
  }
});
