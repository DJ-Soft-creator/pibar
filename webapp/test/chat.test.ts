// Server side of the chat area: models and agents (models.rs, agents.rs), runs in the background (bg.rs + the
// follower of pi.rs), file states for going back (snapshot.rs), diagnosis and the temperature extension (diag.rs,
// temp.rs). Parsers with the Rust test cases, scripts against the fake host, commands through the router.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { CommandRegistry, commandRouter } from "../src/server/commands.js";
import { registerBgCommands } from "../src/server/cmd/bg.js";
import { registerDiagCommands } from "../src/server/cmd/diag.js";
import { registerModelCommands } from "../src/server/cmd/models.js";
import { registerSnapshotCommands } from "../src/server/cmd/snapshot.js";
import { agentPromptFile, isAgentPath, listAgents, parseAgent, parseListing, splitFrontmatter } from "../src/server/host/agents.js";
import { bgArgs, bgPaths, bgRunning, bgStop, followScript, hash, piName } from "../src/server/host/bg.js";
import { DIAG_SCRIPT, diagnose, diagScript } from "../src/server/host/diag.js";
import { listModels, parseModels } from "../src/server/host/models.js";
import { PiManager, toolArgs } from "../src/server/host/pi.js";
import {
  checkCommit,
  checkRefPart,
  Layout,
  parsePreview,
  parseProbe,
  parseRestore,
  previewScript,
  restoreLoop,
  restoreScript,
  rewindPreview,
  rewindRestore,
  rewindUndo,
  snapshotTake,
  takeScript,
} from "../src/server/host/snapshot.js";
import { EXTENSION, installScript, tempInstall } from "../src/server/host/temp.js";
import { sq } from "../src/server/host/hostexec.js";
import type { UserRecord } from "../src/server/store.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

// ------------------------------------------------------------------ models.rs

test("parseModels: table without header and broken lines (models.rs: parses_table_and_skips_header)", () => {
  const out =
    "provider        model                 context  max-out  thinking  images\n" +
    "anthropic       claude-sonnet-4-5     200K     64K      yes       yes\n" +
    "amazon-bedrock  amazon.nova-micro-v1  128K     10K      no        no\n" +
    "irgendwas kaputt\n";
  const m = parseModels(out);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { provider: "anthropic", id: "claude-sonnet-4-5", thinking: true, images: true });
  assert.equal(m[1]?.thinking, false);
  assert.equal(m[1]?.images, false);
});

test("listModels on the fake host", async (t) => {
  const f = fakeHost(t);
  const m = await listModels(f.exec, f.host);
  assert.deepEqual(
    m.map((x) => `${x.provider}/${x.id}:${x.thinking}`),
    ["fake/fake-fast:false", "fake/fake-smart:true"],
  );
});

// ------------------------------------------------------------------ agents.rs

const SCOUT = "---\nname: scout\ndescription: Fast recon\ntools: read, grep, find, ls\nmodel: claude-haiku-4-5\n---\nYou are a scout.\n";

test("agents: frontmatter and body (agents.rs: parses_frontmatter_and_body, flow lists, skips)", () => {
  const a = parseAgent(SCOUT, "user", "/home/user/.pi/agent/agents/scout.md");
  assert.ok(a);
  assert.equal(a.name, "scout");
  assert.equal(a.description, "Fast recon");
  assert.deepEqual(a.tools, ["read", "grep", "find", "ls"]);
  assert.equal(a.model, "claude-haiku-4-5");
  assert.equal(splitFrontmatter(SCOUT)?.body, "You are a scout.\n");
  const w = parseAgent("---\nname: \"worker\"\ndescription: 'General'\ntools: [read, bash]\n---\nBody", "project", "/p/.pi/agents/worker.md");
  assert.equal(w?.name, "worker");
  assert.deepEqual(w?.tools, ["read", "bash"]);
  assert.equal(w?.model, "");
  assert.equal(parseAgent("---\nname: x\n---\nBody", "user", "/x.md"), null);
  assert.equal(parseAgent("no frontmatter", "user", "/x.md"), null);
});

test("agents: listing keeps order, project overrides user (agents.rs: listing_keeps_order_and_project_overrides_user)", () => {
  const out =
    `===PIBAR-AGENT user /u/scout.md\n${SCOUT}\n===PIBAR-END\n` +
    "===PIBAR-AGENT project /p/scout.md\n---\nname: scout\ndescription: Project scout\n---\nOther\n===PIBAR-END\n";
  const agents = parseListing(out);
  assert.equal(agents.length, 1);
  assert.equal(agents[0]?.source, "project");
  assert.equal(agents[0]?.description, "Project scout");
});

test("agents on the fake host: list user and project agents, write the prompt file", async (t) => {
  const f = fakeHost(t);
  mkdirSync(join(f.home, ".pi/agent/agents"), { recursive: true });
  writeFileSync(join(f.home, ".pi/agent/agents/scout.md"), SCOUT);
  const proj = join(f.home, "work/app");
  mkdirSync(join(proj, ".pi/agents"), { recursive: true });
  mkdirSync(join(proj, "sub"), { recursive: true });
  writeFileSync(join(proj, ".pi/agents/review.md"), "---\nname: review\ndescription: Reviews\n---\nCheck it.\n");
  const list = await listAgents(f.exec, f.host, join(proj, "sub"));
  assert.deepEqual(
    list.map((a) => `${a.source}:${a.name}`),
    ["user:scout", "project:review"],
  );
  const file = await agentPromptFile(f.exec, f.host, list[0]?.path ?? "");
  assert.match(file, /\/\.pibar\/agent-prompts\/prompt-[0-9a-f]{16}\.md$/);
  assert.equal(readFileSync(file, "utf8"), "You are a scout.\n");
  assert.equal(isAgentPath("/home/user/notes/secret.md"), false);
  assert.equal(isAgentPath("/home/user/.pi/agent/agents/../x.md"), false);
  await assert.rejects(agentPromptFile(f.exec, f.host, "/etc/passwd"), /not an agent file/);
});

// ------------------------------------------------------------------ bg.rs

test("bg: FNV-1a hash like the Rust core, shell-safe paths, follow script (bg.rs tests)", () => {
  assert.equal(hash("/a/b/c.jsonl"), hash("/a/b/c.jsonl"));
  assert.notEqual(hash("/a/b/c.jsonl"), hash("/a/b/d.jsonl"));
  assert.equal(hash("x").length, 16);
  // reference values of 64-bit FNV-1a
  assert.equal(hash(""), "cbf29ce484222325");
  assert.equal(hash("a"), "af63dc4c8601ec8c");
  const { log, pid } = bgPaths("/home/user/.pi/agent/sessions/x.jsonl");
  assert.ok(log.startsWith('"$HOME"/.pibar/'));
  assert.ok(log.endsWith(".log") && pid.endsWith(".pid"));
  assert.match(log, /^[A-Za-z0-9/.$"_-]+$/);
  const script = followScript("/x/y.jsonl");
  assert.ok(script.includes("tail -n +1 -f") && script.includes("kill -0"));
  assert.equal(piName({ piCommand: "node /x/dev/fake-pi.mjs" }), "node");
  assert.equal(piName({ piCommand: "/opt/bin/pi" }), "pi");
  assert.equal(piName({ piCommand: "" }), "pi");
});

test("bg: arguments of a detached run (lib.rs: bg_start)", () => {
  assert.deepEqual(
    bgArgs(
      { session: "/s.jsonl", prompt: "Hi", provider: "fake", modelId: "m", thinking: "high", tools: ["read"], publicMode: true, temperature: 0.7 },
      toolArgs,
    ),
    ["--session", "/s.jsonl", "--public-mode", "--temperature", "0.7", "--provider", "fake", "--model", "m", "--thinking", "high", "--tools", "read", "Hi"],
  );
  assert.deepEqual(bgArgs({ session: "/s.jsonl", prompt: "x", temperature: 5, provider: " " }, toolArgs), ["--session", "/s.jsonl", "x"]);
});

/** A Pi in json mode for runs in the background: prints a short run as JSON lines (the prompt is its last argument) */
function fakeJsonPi(t: TestContext, ms = 600): string {
  const dir = mkdtempSync(join(tmpdir(), "pibar-jsonpi-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "json-pi.mjs");
  writeFileSync(
    file,
    `const args = process.argv.slice(2);
const prompt = args[args.length - 1];
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
out({ type: "agent_start" });
out({ type: "message_start", message: { role: "user", content: [{ type: "text", text: prompt }] } });
await sleep(${ms});
out({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done: " + prompt }] } });
out({ type: "agent_settled" });
`,
  );
  return `node ${file}`;
}

test("bg: start a detached run, follow its log through PiManager, running and stop", async (t) => {
  const f = fakeHost(t);
  f.host.piCommand = fakeJsonPi(t);
  const session = f.writeSession("--w--", "bg.jsonl", [{ type: "session", id: "bg1", cwd: f.home }]);
  const pi = new PiManager(f.exec);
  t.after(() => pi.closeAll());
  const events: { handle: number; ev: { type?: string } }[] = [];
  const exits: number[] = [];
  pi.setListener({ onEvent: (handle, _s, ev) => events.push({ handle, ev: ev as { type?: string } }), onExit: (h) => exits.push(h) });

  const registry = new CommandRegistry();
  registerBgCommands(registry, pi);
  const ctx = { user: {} as UserRecord, store: {} as never, exec: f.exec, host: f.host };
  const start = registry.get("bg_start");
  assert.ok(start);
  const handle = (await start.run(ctx, { hostId: "fake", cwd: f.home, session, prompt: "Hallo" })) as number;
  assert.equal(pi.info(handle)?.follow, true);
  assert.equal(pi.info(handle)?.streaming, true);
  assert.equal(await bgRunning(f.exec, f.host, session), true);
  // a second follower joins the first
  assert.equal(pi.openFollow(f.host, session).handle, handle);
  await assert.rejects(pi.send(handle, { type: "get_state" }), /no live Pi/);
  await until(() => exits.includes(handle));
  const types = events.filter((e) => e.handle === handle).map((e) => e.ev.type);
  assert.deepEqual(types, ["agent_start", "message_start", "message_end", "agent_settled"]);
  assert.equal(await bgRunning(f.exec, f.host, session), false);
  assert.ok(existsSync(join(f.home, ".pibar", `${hash(session)}.log`)));

  // stop: a long run ends and its pid file is gone
  f.host.piCommand = fakeJsonPi(t, 20_000);
  await start.run(ctx, { hostId: "fake", cwd: f.home, session, prompt: "lang" });
  assert.equal(await bgRunning(f.exec, f.host, session), true);
  await bgStop(f.exec, f.host, session);
  assert.equal(await bgRunning(f.exec, f.host, session), false);
  assert.equal(existsSync(join(f.home, ".pibar", `${hash(session)}.pid`)), false);
  await assert.rejects(Promise.resolve().then(() => start.run(ctx, { session: "/etc/passwd", prompt: "x" })), /Not a Pi session file/);
});

// ------------------------------------------------------------------ snapshot.rs

test("snapshot: ids, commits, paths into the repository, probe/preview/restore output (snapshot.rs tests)", () => {
  checkRefPart("01a1b374-5abf-7693-9c4b-6182ed71d9e5");
  checkRefPart("abc_1");
  for (const bad of ["", "-rf", "a/b", "a b", "a; rm -rf ~"]) assert.throws(() => checkRefPart(bad));
  checkCommit("a1b2c3d");
  assert.throws(() => checkCommit("HEAD~1"));
  assert.throws(() => checkCommit("abc; ls"));

  const inSub = new Layout("/work/app", "/work/app", "/home/me", "/work/app/packages/ui");
  assert.equal(inSub.repoPath("src/x.ts"), "packages/ui/src/x.ts");
  assert.equal(inSub.repoPath("./src/x.ts"), "packages/ui/src/x.ts");
  assert.equal(inSub.repoPath("/work/app/README.md"), "README.md");
  assert.equal(inSub.repoPath("~/notes/a.md"), null);
  assert.equal(inSub.repoPath("/etc/passwd"), null);
  assert.equal(inSub.repoPath("../../../etc/passwd"), null);
  assert.equal(inSub.repoPath("/work/app/.git/config"), null);
  assert.equal(inSub.repoPath("  "), null);
  assert.equal(inSub.repoPath("/work/application/x.ts"), null);
  const linked = new Layout("/private/tmp/app", "/tmp/app", "/home/me", "/private/tmp/app/packages/ui");
  assert.equal(linked.repoPath("/tmp/app/packages/ui/src/x.ts"), "packages/ui/src/x.ts");
  assert.equal(linked.repoPath("/tmp/app/README.md"), "README.md");

  const l = parseProbe("/private/tmp/app\t/private/tmp/app/packages/ui\t/home/me\n", "/tmp/app/packages/ui");
  assert.deepEqual([l?.root, l?.alias, l?.cwd], ["/private/tmp/app", "/tmp/app", "/private/tmp/app/packages/ui"]);
  const plain = parseProbe("/work/app\t/work/app\t/home/me\n", "~/app");
  assert.deepEqual([plain?.root, plain?.alias], ["/work/app", "/home/me/app"]);
  assert.equal(parseProbe("__PIBAR_NOGIT__\n", "/work/x"), null);
  assert.equal(parseProbe("", "/work/x"), null);
  assert.equal(parseProbe("kein pfad\n", "/work/x"), null);

  const p = parsePreview("COMMIT\tabc123\nM\tsrc/a.ts\n=\tsrc/b.ts\nD\tsrc/c.ts\nA\tsrc/d.ts\n-\tsrc/e.ts\n");
  assert.equal(p.commit, "abc123");
  assert.deepEqual(
    p.changes.map((c) => `${c.status} ${c.path}`),
    ["M src/a.ts", "D src/c.ts", "A src/d.ts"],
  );
  assert.equal(parsePreview("__PIBAR_NONE__").commit, null);
  const r = parseRestore("COMMIT\tabc123\nBACKUP\tdef456\nR\ta.ts\nX\tb.ts\n!\tc.ts\n");
  assert.deepEqual(r, { backup: "def456", restored: ["a.ts"], deleted: ["b.ts"], failed: ["c.ts"] });
  assert.equal(parseRestore("__PIBAR_NONE__"), null);
});

function gitRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pibar-snap-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const sh = (s: string) => execFileSync("sh", ["-c", s], { cwd: dir, env: { ...process.env, HOME: dir } });
  mkdirSync(join(dir, "src"));
  sh("git init -q -b main && git config user.email t@t && git config user.name T && echo one > src/a.ts && git add -A && git commit -qm start");
  return dir;
}

test("snapshot scripts against a real repository (snapshot.rs: records_and_restores_files)", (t) => {
  const root = gitRepo(t);
  const index = sq(join(root, ".snap-index"));
  const sh = (s: string) => execFileSync("sh", ["-c", s], { env: { ...process.env, HOME: root } }).toString();
  sh(`cd ${sq(root)} && echo two > src/b.ts`);
  const ref1 = "refs/pibar/sess-1/1abc";
  const commit = sh(takeScript(root, index, ref1)).trim();
  checkCommit(commit);
  sh(`cd ${sq(root)} && echo changed > src/a.ts && rm src/b.ts && echo new > src/c.ts`);
  const rels = ["src/a.ts", "src/b.ts", "src/c.ts"];
  const prev = parsePreview(sh(previewScript(root, [ref1], rels)));
  assert.equal(prev.commit, commit);
  assert.deepEqual(
    prev.changes.map((c) => `${c.status} ${c.path}`),
    ["M src/a.ts", "D src/b.ts", "A src/c.ts"],
  );
  const res = parseRestore(sh(restoreScript(root, index, "refs/pibar/undo/sess-1-1", [ref1], rels)));
  assert.ok(res);
  assert.deepEqual([res.restored.length, res.deleted.length, res.failed.length], [2, 1, 0]);
  checkCommit(res.backup);
  const read = (f: string) => (existsSync(join(root, f)) ? readFileSync(join(root, f), "utf8") : null);
  assert.equal(read("src/a.ts"), "one\n");
  assert.equal(read("src/b.ts"), "two\n");
  assert.equal(read("src/c.ts"), null);
  sh(`cd ${sq(root)} || exit 1; commit=${sq(res.backup)}; ${restoreLoop(rels)}`);
  assert.equal(read("src/a.ts"), "changed\n");
  assert.equal(read("src/b.ts"), null);
  assert.equal(read("src/c.ts"), "new\n");
});

test("snapshot commands on the fake host: take, preview, restore, undo; no repository → null", async (t) => {
  const f = fakeHost(t);
  const root = join(f.home, "repo");
  mkdirSync(join(root, "src"), { recursive: true });
  execFileSync("sh", ["-c", "git init -q -b main && git config user.email t@t && git config user.name T && echo one > src/a.ts && git add -A && git commit -qm s"], {
    cwd: root,
    env: { ...process.env, HOME: f.home },
  });
  const taken = await snapshotTake(f.exec, f.host, root, "sess-1", "entry1");
  assert.ok(taken);
  assert.equal(taken.repo, root);
  writeFileSync(join(root, "src/a.ts"), "changed\n");
  const prev = await rewindPreview(f.exec, f.host, root, ["sess-0", "sess-1"], "entry1", ["src/a.ts", "/etc/passwd"]);
  assert.equal(prev.commit, taken.commit);
  assert.deepEqual(prev.changes, [{ path: "src/a.ts", status: "M" }]);
  assert.deepEqual(prev.skipped, ["/etc/passwd"]);
  const res = await rewindRestore(f.exec, f.host, root, ["sess-1"], "entry1", ["src/a.ts"]);
  assert.deepEqual(res?.restored, ["src/a.ts"]);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "one\n");
  const undone = await rewindUndo(f.exec, f.host, root, res?.backup ?? "", ["src/a.ts"]);
  assert.deepEqual(undone.restored, ["src/a.ts"]);
  assert.equal(readFileSync(join(root, "src/a.ts"), "utf8"), "changed\n");
  assert.equal(await rewindRestore(f.exec, f.host, root, ["sess-1"], "nothere", ["src/a.ts"]), null);
  mkdirSync(join(f.home, "plain"));
  assert.equal(await snapshotTake(f.exec, f.host, join(f.home, "plain"), "sess-1", "entry1"), null);
  await assert.rejects(snapshotTake(f.exec, f.host, "relative/dir", "sess-1", "entry1"), /Path not allowed/);
  await assert.rejects(snapshotTake(f.exec, f.host, root, "a;b", "entry1"), /Not an id/);
  await assert.rejects(rewindUndo(f.exec, f.host, root, "HEAD", ["x"]), /Not a commit/);
});

// ------------------------------------------------------------------ diag.rs, temp.rs

test("diag: the script is the one of diag.rs; the report runs on the fake host", async (t) => {
  const rust = readFileSync(join(repo, "src-tauri/src/diag.rs"), "utf8");
  const m = /const SCRIPT: &str = r#"([\s\S]*?)"#;/.exec(rust);
  assert.ok(m);
  assert.equal(DIAG_SCRIPT, m[1]);
  assert.ok(diagScript("a'b", "m").startsWith("PIBAR_PROVIDER='a'\\''b' PIBAR_MODEL='m'; "));
  const f = fakeHost(t);
  const report = await diagnose(f.exec, f.host, "", "");
  assert.match(report, /== PiBar\nhost: Fake \(SSH fake\.invalid\)/);
  assert.match(report, /== Pi/);
  assert.match(report, /skipped \(no model or pi not found\)/);
});

test("temp: the bundled extension equals src-tauri/extensions/pibar-temperature.ts and is installed", async (t) => {
  assert.equal(EXTENSION, readFileSync(join(repo, "src-tauri/extensions/pibar-temperature.ts"), "utf8"));
  assert.ok(EXTENSION.includes('registerCommand("temperature"'));
  assert.ok(installScript().includes('cat > "$HOME/.pi/agent/extensions/pibar-temperature.ts"'));
  const f = fakeHost(t);
  await tempInstall(f.exec, f.host);
  assert.equal(readFileSync(join(f.home, ".pi/agent/extensions/pibar-temperature.ts"), "utf8"), EXTENSION);
});

// ------------------------------------------------------------------ through the router: rights and arguments

test("commands: registered with the Tauri names, need a host the user may use, check their arguments", async (t) => {
  const f: FakeHost = fakeHost(t);
  const registry = new CommandRegistry();
  registerModelCommands(registry);
  registerSnapshotCommands(registry);
  registerDiagCommands(registry);
  const pi = new PiManager(f.exec);
  t.after(() => pi.closeAll());
  registerBgCommands(registry, pi);
  for (const name of ["list_models", "list_agents", "agent_prompt_file", "snapshot_take", "rewind_preview", "rewind_restore", "rewind_undo", "diagnose", "temp_install", "bg_start", "bg_follow", "bg_running", "bg_stop"]) {
    assert.equal(registry.get(name)?.host, true, name);
  }
  const user = { id: "u1", username: "user", role: "user", hostIds: ["fake"] } as unknown as UserRecord;
  const app = express();
  app.use(express.json());
  app.use(
    "/api/cmd",
    commandRouter({
      registry,
      store: {} as never,
      exec: f.exec,
      resolveHost: (id) => (id === "fake" || id === "other" ? { ...f.host, id } : null),
      canUseHost: (u, id) => u.hostIds.includes(id),
      requireAuth: (req, _res, next) => {
        req.authUser = user;
        next();
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  t.after(() => server.close());
  await new Promise((r) => server.once("listening", r));
  const port = (server.address() as { port: number }).port;
  const cmd = async (name: string, body: unknown) => {
    const res = await fetch(`http://127.0.0.1:${port}/api/cmd/${name}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as { result?: unknown; error?: string } };
  };
  const ok = await cmd("list_models", { hostId: "fake" });
  assert.equal(ok.status, 200);
  assert.equal((ok.json.result as unknown[]).length, 2);
  assert.equal((await cmd("list_models", { hostId: "other" })).status, 403);
  assert.equal((await cmd("agent_prompt_file", { hostId: "fake", path: "/home/user/x.md" })).status, 400);
  assert.equal((await cmd("snapshot_take", { hostId: "fake", dir: "x", sessionId: "sess-1", tag: "abcd" })).status, 400);
  assert.equal((await cmd("bg_running", { hostId: "fake", session: "/etc/passwd" })).status, 400);
  const running = await cmd("bg_running", { hostId: "fake", session: `${f.sessionsDir}/--x--/a.jsonl` });
  assert.deepEqual([running.status, running.json.result], [200, false]);
});
