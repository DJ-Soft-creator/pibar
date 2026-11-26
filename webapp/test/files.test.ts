// Files (port of files.rs): parsing with the Rust test cases, the scripts on the fake host, and the host-side path
// guard (../, absolute paths outside, symlinks out of the allowed folders, protected credential folders).
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkDeletePath,
  checkPathShape,
  createDir,
  createFile,
  decodeUpload,
  deletableUnder,
  deletePath,
  GIT,
  imageType,
  listDirs,
  listFiles,
  maxUploadBytes,
  parseBranch,
  parseDirs,
  parseHead,
  parseListing,
  readFile,
  readHead,
  readImage,
  uploadFile,
  uploadScript,
  writeFile,
} from "../src/server/host/files.js";
import { OUTSIDE, SessionRoots } from "../src/server/host/pathGuard.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

// ------------------------------------------------------------------ parsing (files.rs tests)

test("parseListing (files.rs: parses_listing)", () => {
  const l = parseListing("~/notes", "/home/u/notes\na.md\nsub/b.md\nempty/\nsub/\n");
  assert.equal(l.root, "/home/u/notes");
  assert.deepEqual(l.files, ["a.md", "sub/b.md", "empty/", "sub/"]);
  assert.equal(l.missing, false);
});

test("Git status (files.rs: parses_git_status)", () => {
  const out =
    "/repo/docs\na.md\n__PIBAR_GIT__\n\ndocs/\n## main...origin/main [ahead 2, behind 1]\n M docs/a.md\n?? docs/new/\n M src/x.rs\nR  docs/old.md -> docs/b.md\n";
  const l = parseListing("~/repo/docs", out);
  assert.deepEqual(l.files, ["a.md"]);
  const g = l.git[0];
  assert.ok(g);
  assert.equal(g.dir, "");
  assert.deepEqual([g.branch, g.upstream, g.ahead, g.behind], ["main", "origin/main", 2, 1]);
  assert.deepEqual(
    g.changes.map((c) => [c.code, c.path]),
    [
      [" M", "a.md"],
      ["??", "new/"],
      ["R ", "b.md"],
    ],
  );
});

test("parseBranch (files.rs: parses_branch_lines)", () => {
  assert.deepEqual(parseBranch("## main"), ["main", null, 0, 0]);
  assert.deepEqual(parseBranch("## No commits yet on main"), ["main", null, 0, 0]);
  assert.deepEqual(parseBranch("## dev...origin/dev [behind 3]"), ["dev", "origin/dev", 0, 3]);
});

test("no Git part means none; missing folder (files.rs: no_git_part_means_none, detects_missing_folder)", () => {
  assert.equal(parseListing("~/x", "/x\na.md\n").git.length, 0);
  const l = parseListing("~/gone", "__PIBAR_MISSING__\n");
  assert.ok(l.missing);
  assert.deepEqual([l.files, l.root], [[], ""]);
});

test("repositories in subfolders (files.rs: finds_repositories_in_subfolders)", () => {
  const out =
    "/home/u\nnotes/a.md\n__PIBAR_GIT__\nprojects/app\n\n## dev...origin/dev [ahead 1]\n M README.md\n__PIBAR_GIT__\nnotes\n\n## main\n";
  const l = parseListing("~", out);
  assert.deepEqual(l.files, ["notes/a.md"]);
  assert.equal(l.git.length, 2);
  assert.deepEqual([l.git[0]?.dir, l.git[0]?.ahead], ["projects/app", 1]);
  assert.equal(l.git[0]?.changes[0]?.path, "projects/app/README.md");
  assert.equal(l.git[1]?.branch, "main");
});

test("Git script keeps umlauts (files.rs: git_script_keeps_umlauts)", () => {
  assert.equal(GIT.split("core.quotePath=false").length - 1, 2);
  const l = parseListing("~/repo", '/repo\n__PIBAR_GIT__\n\n\n## main\n M "Über uns.md"\n?? neu/Ärger.md\n');
  assert.deepEqual(
    l.git[0]?.changes.map((c) => c.path),
    ["Über uns.md", "neu/Ärger.md"],
  );
});

test("parseHead (files.rs: parses_head_version)", () => {
  assert.deepEqual(parseHead("__PIBAR_HEAD__\n# Title\n\ntext\n"), { inGit: true, text: "# Title\n\ntext\n" });
  assert.deepEqual(parseHead("__PIBAR_NEW__\n"), { inGit: true, text: null });
  assert.deepEqual(parseHead("__PIBAR_NOGIT__\n"), { inGit: false, text: null });
});

test("parseDirs (files.rs: parses_dir_listing)", () => {
  const d = parseDirs("/home/u/proj\n/home/u\nsrc\nDocs\nassets\n");
  assert.ok(d);
  assert.equal(d.path, "/home/u/proj");
  assert.equal(d.home, "/home/u");
  assert.deepEqual(d.dirs, ["assets", "Docs", "src"]);
  assert.equal(parseDirs(""), null);
});

test("path shapes (files.rs: paths_must_be_absolute_and_plain, delete_paths_never_point_at_a_root)", () => {
  for (const ok of ["/home/u/notes/a.md", "~/notes/Plan.MD", "/a b/ä.ts", "/r/report.html"]) checkPathShape(ok);
  for (const bad of ["notes/a.md", "/home/u/notes/../.ssh/x", "~/../etc/passwd", "/home/u/a.md\nrm -rf ~"]) {
    assert.throws(() => checkPathShape(bad), /Path not allowed/, bad);
  }
  for (const ok of ["/home/u/notes/a.md", "~/notes/sub", "/home/u/notes/sub/"]) checkDeletePath(ok);
  for (const bad of ["", "/", "~", "~/", "/home/u/./notes", "notes/a.md", "/a/../b", "/a\nb"]) {
    assert.throws(() => checkDeletePath(bad), /Path not allowed/, JSON.stringify(bad));
  }
});

test("deletableUnder (files.rs: only_paths_strictly_inside_a_session_folder_are_deletable)", () => {
  const roots = ["/home/u/notes", "~/work/"];
  assert.ok(deletableUnder("/home/u/notes/a.md", roots));
  assert.ok(deletableUnder("/home/u/notes/sub/", roots));
  assert.ok(deletableUnder("~/work/a.md", roots));
  assert.ok(!deletableUnder("/home/u/notes", roots));
  assert.ok(!deletableUnder("/home/u/notes/", roots));
  assert.ok(!deletableUnder("/home/u/notes2/a.md", roots));
  assert.ok(!deletableUnder("/home/u/a.md", roots));
  assert.ok(!deletableUnder("/home/u/notes/a.md", []));
});

test("upload script and payload (files.rs: upload_guards_existing_files, upload_payload_is_checked)", () => {
  const s = uploadScript("/a b/x.pdf", false);
  assert.ok(s.startsWith("if [ -e '/a b/x.pdf' ]; then echo __PIBAR_EXISTS__; exit 0; fi; "));
  assert.ok(s.endsWith("cat > '/a b/x.pdf'.pibar-tmp && mv '/a b/x.pdf'.pibar-tmp '/a b/x.pdf'"));
  assert.ok(uploadScript("/x.pdf", true).startsWith("cat > "));
  assert.deepEqual(decodeUpload("aGk=", 10), Buffer.from("hi"));
  assert.throws(() => decodeUpload("!!!", 10), /Invalid upload data/);
  assert.throws(() => decodeUpload(Buffer.alloc(11).toString("base64"), 10), /too large/);
  assert.equal(decodeUpload(Buffer.alloc(10).toString("base64"), 10).length, 10);
});

test("MAX_UPLOAD_MB: default 25, own value, nonsense falls back", () => {
  assert.equal(maxUploadBytes(undefined), 25_000_000);
  assert.equal(maxUploadBytes("40"), 40_000_000);
  assert.equal(maxUploadBytes("abc"), 25_000_000);
  assert.equal(maxUploadBytes("-1"), 25_000_000);
});

test("imageType (files.rs: images_are_read_only_and_typed)", () => {
  assert.equal(imageType("/home/u/Bilder/Foto.JPG"), "image/jpeg");
  assert.equal(imageType("~/a.png"), "image/png");
  assert.throws(() => imageType("/home/u/../x.png"));
  assert.throws(() => imageType("/home/u/a.svg"), /Not an image/);
});

// ------------------------------------------------------------------ on the fake host

/** A project folder in the fake home with a few files */
function project(f: FakeHost): string {
  const dir = join(f.home, "proj");
  mkdirSync(join(dir, "docs", "deep"), { recursive: true });
  mkdirSync(join(dir, "node_modules", "x"), { recursive: true });
  mkdirSync(join(dir, "empty"), { recursive: true });
  writeFileSync(join(dir, "README.md"), "# Hallo\n");
  writeFileSync(join(dir, "main.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "docs", "Über.md"), "ä\n");
  writeFileSync(join(dir, "docs", "deep", "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
  writeFileSync(join(dir, "node_modules", "x", "skip.md"), "no\n");
  return dir;
}

/** A folder outside the fake home (stands for /etc, another user's home …) */
function outside(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "pibar-outside-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "secret.txt"), "top secret\n");
  return dir;
}

test("listFiles: files, folders, docs filter, missing folder, Git status", async (t) => {
  const f = fakeHost(t);
  const dir = project(f);
  const [l, missing] = await listFiles(f.exec, f.host, ["~/proj", "~/gone"], false, false, []);
  assert.ok(l && missing);
  assert.equal(l.root, dir);
  // files first, then folders (sorted bytewise, LANG=C.UTF-8); node_modules and hidden folders skipped
  assert.deepEqual(l.files, ["README.md", "docs/deep/pic.png", "docs/Über.md", "main.ts", "docs/", "docs/deep/", "empty/"]);
  assert.ok(missing.missing);
  const [docs] = await listFiles(f.exec, f.host, [dir], false, true, []);
  assert.ok(docs && !docs.files.includes("main.ts") && docs.files.includes("README.md") && docs.files.includes("docs/deep/pic.png"));

  await f.exec.runShell(
    f.host,
    "cd ~/proj && git init -q -b main && git config user.email t@example.invalid && git config user.name Tester && git add README.md && git commit -qm start && echo x >> README.md",
  );
  const [g] = await listFiles(f.exec, f.host, ["~/proj"], true, false, []);
  const repo = g?.git[0];
  assert.ok(repo);
  assert.equal(repo.branch, "main");
  assert.ok(repo.changes.some((c) => c.path === "README.md" && c.code === " M"));
  assert.ok(repo.changes.some((c) => c.path === "docs/Über.md" && c.code === "??"));
});

test("read, write, create, image, HEAD version on the fake host", async (t) => {
  const f = fakeHost(t);
  const dir = project(f);
  assert.equal(await readFile(f.exec, f.host, `${dir}/README.md`, []), "# Hallo\n");
  assert.equal(await readFile(f.exec, f.host, "~/proj/docs/Über.md", []), "ä\n");
  await assert.rejects(readFile(f.exec, f.host, `${dir}/docs/deep/pic.png`, []), /Binary file/);
  // content that looks like a marker stays content
  writeFileSync(join(dir, "m.txt"), "__PIBAR_BINARY__");
  assert.equal(await readFile(f.exec, f.host, `${dir}/m.txt`, []), "__PIBAR_BINARY__");

  await writeFile(f.exec, f.host, `${dir}/README.md`, "neu 'quoted' $HOME\n", []);
  assert.equal(readFileSync(join(dir, "README.md"), "utf8"), "neu 'quoted' $HOME\n");

  await createFile(f.exec, f.host, `${dir}/new/sub/n.md`, []);
  assert.ok(existsSync(join(dir, "new", "sub", "n.md")));
  await assert.rejects(createFile(f.exec, f.host, `${dir}/new/sub/n.md`, []));

  const img = await readImage(f.exec, f.host, `${dir}/docs/deep/pic.png`, []);
  assert.equal(img.mimeType, "image/png");
  assert.deepEqual(Buffer.from(img.data, "base64"), readFileSync(join(dir, "docs", "deep", "pic.png")));

  assert.deepEqual(await readHead(f.exec, f.host, `${dir}/README.md`, []), { inGit: false, text: null });
  await f.exec.runShell(
    f.host,
    "cd ~/proj && git init -q -b main && git config user.email t@example.invalid && git config user.name Tester && git add README.md && git commit -qm start",
  );
  assert.deepEqual(await readHead(f.exec, f.host, `${dir}/README.md`, []), { inGit: true, text: "neu 'quoted' $HOME\n" });
  assert.deepEqual(await readHead(f.exec, f.host, `${dir}/main.ts`, []), { inGit: true, text: null });
});

test("upload: binary bytes, existing file kept, overwrite, size limit", async (t) => {
  const f = fakeHost(t);
  const dir = project(f);
  const path = `${dir}/Dokument ä.pdf`;
  const bytes = Buffer.from([0, 159, 146, 100]);
  assert.equal(await uploadFile(f.exec, f.host, path, bytes.toString("base64"), false, 100, []), true);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(await uploadFile(f.exec, f.host, path, Buffer.from("new").toString("base64"), false, 100, []), false);
  assert.deepEqual(readFileSync(path), bytes);
  assert.equal(await uploadFile(f.exec, f.host, path, Buffer.from("new").toString("base64"), true, 100, []), true);
  assert.equal(readFileSync(path, "utf8"), "new");
  await assert.rejects(uploadFile(f.exec, f.host, `${dir}/big.bin`, Buffer.alloc(101).toString("base64"), false, 100, []), /too large/);
  await assert.rejects(uploadFile(f.exec, f.host, `${dir}/`, "aGk=", false, 100, []), /Not a file path/);
});

test("listDirs and createDir", async (t) => {
  const f = fakeHost(t);
  const dir = project(f);
  mkdirSync(join(dir, ".hidden"));
  const d = await listDirs(f.exec, f.host, "~/proj", false);
  assert.equal(d.path, dir);
  assert.equal(d.home, f.home);
  assert.deepEqual(d.dirs, ["docs", "empty", "node_modules"]);
  assert.ok((await listDirs(f.exec, f.host, "~/proj", true)).dirs.includes(".hidden"));
  assert.equal((await listDirs(f.exec, f.host, "~", false)).path, f.home);
  await assert.rejects(listDirs(f.exec, f.host, "~/../", false), /Path not allowed/);
  await createDir(f.exec, f.host, "~/proj/a/b c", []);
  assert.ok(existsSync(join(dir, "a", "b c")));
});

test("delete: file, folder, symlink loses only the link, roots and paths outside stay", async (t) => {
  const f = fakeHost(t);
  const dir = project(f);
  const out = outside(t);
  const roots = [dir];
  await deletePath(f.exec, f.host, `${dir}/main.ts`, roots, []);
  assert.ok(!existsSync(join(dir, "main.ts")));
  await deletePath(f.exec, f.host, `${dir}/docs/`, roots, []);
  assert.ok(!existsSync(join(dir, "docs")));
  await assert.rejects(deletePath(f.exec, f.host, `${dir}/docs`, roots, []), /does not exist/);
  // a link to a folder outside: the link goes, the folder stays
  symlinkSync(out, join(dir, "link-out"));
  await deletePath(f.exec, f.host, `${dir}/link-out`, roots, []);
  assert.ok(!existsSync(join(dir, "link-out")) && existsSync(join(out, "secret.txt")));
  // the root itself, a path outside the tree's roots, and a path through a link out of the allowed folders
  await assert.rejects(deletePath(f.exec, f.host, dir, roots, []), /Only files and folders inside/);
  await assert.rejects(deletePath(f.exec, f.host, `${out}/secret.txt`, roots, []), /Only files and folders inside/);
  symlinkSync(out, join(dir, "via"));
  await assert.rejects(deletePath(f.exec, f.host, `${dir}/via/secret.txt`, roots, []), new RegExp(OUTSIDE.replace(/[()]/g, "\\$&")));
  assert.ok(existsSync(join(out, "secret.txt")));
  // a link to the home folder: deleting "<root>/up/proj" would delete the root itself
  symlinkSync(f.home, join(dir, "up"));
  await assert.rejects(deletePath(f.exec, f.host, `${dir}/up/proj`, roots, []), /root folder/);
  assert.ok(existsSync(dir));
});

test("path guard: ../, absolute paths outside, symlinks out, protected folders", async (t) => {
  const f = fakeHost(t);
  const dir = project(f);
  const out = outside(t);
  const refused = new RegExp(OUTSIDE.replace(/[()]/g, "\\$&"));
  // "../" never reaches the host
  await assert.rejects(readFile(f.exec, f.host, `${dir}/../../${out}/secret.txt`, []), /Path not allowed \(\.\.\)/);
  await assert.rejects(readFile(f.exec, f.host, "~/../x", []), /Path not allowed/);
  // absolute paths outside the home folder
  await assert.rejects(readFile(f.exec, f.host, `${out}/secret.txt`, []), refused);
  await assert.rejects(readImage(f.exec, f.host, `${out}/x.png`, []), refused);
  await assert.rejects(writeFile(f.exec, f.host, `${out}/new.txt`, "x", []), refused);
  await assert.rejects(createFile(f.exec, f.host, `${out}/new.txt`, []), refused);
  await assert.rejects(createDir(f.exec, f.host, `${out}/newdir`, []), refused);
  await assert.rejects(uploadFile(f.exec, f.host, `${out}/u.bin`, "aGk=", true, 100, []), refused);
  await assert.rejects(readHead(f.exec, f.host, `${out}/secret.txt`, []), refused);
  assert.ok(!existsSync(join(out, "new.txt")) && !existsSync(join(out, "newdir")) && !existsSync(join(out, "u.bin")));
  const [listing] = await listFiles(f.exec, f.host, [out], false, false, []);
  assert.match(listing?.error ?? "", refused);
  // symlinks inside the home folder that point outside: file, folder, dangling link for a new file
  symlinkSync(join(out, "secret.txt"), join(dir, "secret-link.txt"));
  symlinkSync(out, join(dir, "outdir"));
  symlinkSync(join(out, "planted.txt"), join(dir, "dangling.txt"));
  await assert.rejects(readFile(f.exec, f.host, `${dir}/secret-link.txt`, []), refused);
  await assert.rejects(readFile(f.exec, f.host, `${dir}/outdir/secret.txt`, []), refused);
  await assert.rejects(writeFile(f.exec, f.host, `${dir}/outdir/x.txt`, "x", []), refused);
  await assert.rejects(createFile(f.exec, f.host, `${dir}/dangling.txt`, []), refused);
  assert.ok(!existsSync(join(out, "planted.txt")) && !existsSync(join(out, "x.txt")));
  const [viaLink] = await listFiles(f.exec, f.host, [`${dir}/outdir`], false, false, []);
  assert.match(viaLink?.error ?? "", refused);
  // a link that stays inside is fine
  symlinkSync(join(dir, "README.md"), join(dir, "readme-link.md"));
  assert.equal(await readFile(f.exec, f.host, `${dir}/readme-link.md`, []), "# Hallo\n");
  // credential folders of the home folder, also through a link
  mkdirSync(join(f.home, ".ssh"));
  writeFileSync(join(f.home, ".ssh", "id_ed25519"), "KEY\n");
  mkdirSync(join(f.home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(f.home, ".pi", "agent", "auth.json"), "{}\n");
  await assert.rejects(readFile(f.exec, f.host, "~/.ssh/id_ed25519", []), /protected folder/);
  await assert.rejects(readFile(f.exec, f.host, "~/.pi/agent/auth.json", []), /protected folder/);
  await assert.rejects(writeFile(f.exec, f.host, "~/.ssh/authorized_keys", "x", []), /protected folder/);
  symlinkSync(join(f.home, ".ssh"), join(dir, "keys"));
  await assert.rejects(readFile(f.exec, f.host, `${dir}/keys/id_ed25519`, []), /protected folder/);
  // a folder outside the home folder becomes allowed as a root (a session works there)
  assert.equal(await readFile(f.exec, f.host, `${out}/secret.txt`, [out]), "top secret\n");
  assert.equal(await readFile(f.exec, f.host, `${dir}/outdir/secret.txt`, [out]), "top secret\n");
  // "/" never counts as a root
  await assert.rejects(readFile(f.exec, f.host, `${out}/secret.txt`, ["/"]), refused);
});

test("SessionRoots: session folders allow paths outside home; a refused path retries with a fresh list", async (t) => {
  const f = fakeHost(t);
  const out = outside(t);
  const roots = new SessionRoots(f.exec, { ttlMs: 60_000, retryAfterMs: 0 });
  const read = () => roots.run(f.host, [], (r) => readFile(f.exec, f.host, `${out}/secret.txt`, r));
  await assert.rejects(read(), /outside the session folders/);
  // a session starts in that folder: the next refused try asks the host again
  f.writeSession("--x--", "2026-11-01_a.jsonl", [
    { type: "session", id: "s1", cwd: out, timestamp: "2026-11-01T10:00:00Z" },
    { type: "message", id: "u1", parentId: null, message: { role: "user", content: [{ type: "text", text: "hi" }] } },
  ]);
  assert.equal(await read(), "top secret\n");
  // without the retry (young cache) a refused path stays refused until the cache expires
  const strict = new SessionRoots(f.exec, { ttlMs: 60_000, retryAfterMs: 60_000 });
  assert.ok((await strict.roots(f.host)).roots.includes(out));
  // extra roots (the host's default folder) count as well
  const other = outside(t);
  assert.equal(await strict.run(f.host, [other], (r) => readFile(f.exec, f.host, `${other}/secret.txt`, r)), "top secret\n");
});
