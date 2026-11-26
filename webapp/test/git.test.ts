// Git (port of gitlog.rs plus the webapp's commit): parsing with the Rust test cases, the scripts against a real
// temporary repository in the fake home, and the path guard on the folders.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkCommitPath,
  checkHash,
  createCommit,
  gitCommit,
  gitDiff,
  gitLog,
  parseDetail,
  parseLog,
} from "../src/server/host/git.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

const FS = "\u001f";
const RS = "\u001e";

test("parseLog with unpushed commits (gitlog.rs: parses_log_with_unpushed_commits)", () => {
  const out = `__PIBAR_UNPUSHED__\naaa111\n__PIBAR_LOG__\naaa111${FS}aaa1${FS}Alex${FS}1730000000${FS}HEAD -> main${FS}Neue Funktion${RS}\nbbb222${FS}bbb2${FS}Alex${FS}1720000000${FS}${FS}Fix: Umlaute${RS}`;
  const log = parseLog(out);
  assert.equal(log.length, 2);
  assert.deepEqual([log[0]?.short, log[0]?.unpushed, log[0]?.refs], ["aaa1", true, "HEAD -> main"]);
  assert.deepEqual([log[1]?.subject, log[1]?.unpushed, log[1]?.time], ["Fix: Umlaute", false, 1720000000]);
  assert.throws(() => parseLog("__PIBAR_NOGIT__"), /Not in a Git repository/);
});

test("parseDetail (gitlog.rs: parses_commit_detail)", () => {
  const d = parseDetail(`Titel\n\nText\n${RS}\n\nM\tREADME.md\nA\tdocs/Über.md\nR100\talt.md\tneu.md\n`);
  assert.equal(d.message, "Titel\n\nText");
  assert.deepEqual(
    d.files.map((f) => [f.status, f.path]),
    [
      ["M", "README.md"],
      ["A", "docs/Über.md"],
      ["R", "neu.md"],
    ],
  );
});

test("only hex commit ids, plain commit paths (gitlog.rs: only_hex_commit_ids)", () => {
  checkHash("a1b2c3d");
  assert.throws(() => checkHash("HEAD; rm -rf ~"));
  assert.throws(() => checkHash("abc"));
  checkCommitPath("docs/Über uns.md");
  checkCommitPath("new/");
  for (const bad of ["", "/etc/passwd", "../x", "a/../../b", "a\nb"]) assert.throws(() => checkCommitPath(bad), JSON.stringify(bad));
});

/** The repository of gitlog.rs' scripts_work_on_a_repository, in the fake home */
async function repo(f: FakeHost): Promise<string> {
  const dir = join(f.home, "repo");
  mkdirSync(join(dir, "docs"), { recursive: true });
  await f.exec.runShell(
    f.host,
    "cd ~/repo && git init -q -b main && git config user.email t@example.invalid && git config user.name Tester && " +
      "echo a > docs/Über.md && git add -A && git commit -qm erste && " +
      "echo b >> docs/Über.md && echo c > x.txt && git add -A && git commit -qm zweite",
  );
  return dir;
}

test("scripts on a real repository (gitlog.rs: scripts_work_on_a_repository)", async (t) => {
  const f = fakeHost(t);
  const root = await repo(f);
  const docs = `${root}/docs`;
  const log = await gitLog(f.exec, f.host, root, null, 50, []);
  assert.deepEqual(
    log.map((c) => c.subject),
    ["zweite", "erste"],
  );
  assert.equal(log[0]?.author, "Tester");
  assert.equal(log[0]?.unpushed, false); // no upstream
  assert.equal((await gitLog(f.exec, f.host, docs, "Über.md", 50, [])).length, 2);
  assert.equal((await gitLog(f.exec, f.host, "~/repo", null, 1, [])).length, 1);
  const hash = log[0]?.hash ?? "";
  const d = await gitCommit(f.exec, f.host, docs, hash, []);
  assert.deepEqual(
    [d.message, d.files.map((x) => x.path)],
    ["zweite", ["docs/Über.md", "x.txt"]],
  );
  assert.match(await gitDiff(f.exec, f.host, docs, hash, "docs/Über.md", true, []), /\+b/);
  assert.match(await gitDiff(f.exec, f.host, docs, hash, "Über.md", false, []), /\+b/);
  // a folder that is no repository (the fake home itself)
  await assert.rejects(gitLog(f.exec, f.host, f.home, null, 5, []), /Not in a Git repository/);
});

test("createCommit: only the selected changes, message from stdin, literal paths", async (t) => {
  const f = fakeHost(t);
  const root = await repo(f);
  writeFileSync(join(root, "x.txt"), "changed\n");
  writeFileSync(join(root, "docs", "neu*.md"), "neu\n");
  writeFileSync(join(root, "docs", "other.md"), "not selected\n");
  rmSync(join(root, "docs", "Über.md"));
  const message = `Commit "mit" 'Zeichen' $HOME \`x\`\n\nZweite Zeile`;
  const c = await createCommit(f.exec, f.host, root, ["x.txt", "docs/neu*.md", "docs/Über.md"], message, []);
  assert.match(c.hash, /^[0-9a-f]{40}$/);
  assert.ok(c.hash.startsWith(c.short));
  const d = await gitCommit(f.exec, f.host, root, c.hash, []);
  assert.equal(d.message, message);
  assert.deepEqual(d.files.map((x) => `${x.status} ${x.path}`).sort(), ["A docs/neu*.md", "D docs/Über.md", "M x.txt"]);
  // the file that was not selected is still untracked
  const status = await f.exec.runShell(f.host, "cd ~/repo && git status --porcelain");
  assert.match(status, /\?\? docs\/other\.md/);
  // a commit from a subfolder: paths relative to it
  const sub = await createCommit(f.exec, f.host, `${root}/docs`, ["other.md"], "sub", []);
  assert.deepEqual((await gitCommit(f.exec, f.host, root, sub.hash, [])).files, [{ status: "A", path: "docs/other.md" }]);
  await assert.rejects(createCommit(f.exec, f.host, root, ["x.txt"], "  ", []), /message is empty/);
  await assert.rejects(createCommit(f.exec, f.host, root, [], "m", []), /No files selected/);
  await assert.rejects(createCommit(f.exec, f.host, root, ["../escape"], "m", []), /Path not allowed/);
  await assert.rejects(createCommit(f.exec, f.host, f.home, ["a"], "m", []), /Not in a Git repository/);
});

test("Git folders go through the path guard", async (t) => {
  const f = fakeHost(t);
  await repo(f);
  const out = mkdtempSync(join(tmpdir(), "pibar-outside-git-"));
  t.after(() => rmSync(out, { recursive: true, force: true }));
  await f.exec.runShell(f.host, `cd ${out} && git init -q -b main`);
  await assert.rejects(gitLog(f.exec, f.host, out, null, 5, []), /outside the session folders/);
  await assert.rejects(gitCommit(f.exec, f.host, out, "abcd", []), /outside the session folders/);
  await assert.rejects(gitDiff(f.exec, f.host, out, "abcd", "x", false, []), /outside the session folders/);
  await assert.rejects(createCommit(f.exec, f.host, out, ["x"], "m", []), /outside the session folders/);
  await assert.rejects(gitLog(f.exec, f.host, "~/repo/../..", null, 5, []), /Path not allowed \(\.\.\)/);
});
