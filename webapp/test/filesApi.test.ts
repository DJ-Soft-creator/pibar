// File and Git commands through the HTTP API: registration with the Tauri names, host rights, a 20 MB upload
// through the command router (own body limit), MAX_UPLOAD_MB, and the streaming download route.
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createApp } from "../src/server/app.js";
import { bootstrapAdmin, createToken, createUser } from "../src/server/auth.js";
import { createRegistry } from "../src/server/cmd/index.js";
import { canUseHost } from "../src/server/helpers.js";
import { disposition } from "../src/server/routes/files.js";
import { Store } from "../src/server/store.js";
import { fakeHost, type FakeHost } from "./fakeHost.js";

interface Ctx {
  url: string;
  f: FakeHost;
  adminToken: string;
  /** User without rights on the fake host */
  strangerToken: string;
  call(name: string, args?: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }>;
  get(path: string, token?: string): Promise<Response>;
}

async function start(t: TestContext, env: Record<string, string> = {}): Promise<Ctx> {
  const saved = { ...process.env };
  Object.assign(process.env, env);
  t.after(() => {
    process.env = saved;
  });
  const dataDir = mkdtempSync(join(tmpdir(), "pibar-files-api-"));
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  const store = new Store(dataDir);
  await bootstrapAdmin(store, { ADMIN_USERNAME: "admin", ADMIN_PASSWORD: "admin-pass-123" }, () => {});
  const admin = store.findUserByName("admin");
  assert.ok(admin);
  const adminToken = createToken();
  store.addToken(adminToken, admin.id);
  const stranger = await createUser("user", "user-pass-123", "user", ["other"]);
  store.saveUser(stranger);
  const strangerToken = createToken();
  store.addToken(strangerToken, stranger.id);
  const f = fakeHost(t);
  const app = createApp(store, {
    clientDir: join(dataDir, "client"),
    commands: { registry: createRegistry(), exec: f.exec, resolveHost: (id) => (id === "fake" ? f.host : null), canUseHost },
  });
  const server = createServer(app);
  server.listen(0);
  await once(server, "listening");
  t.after(() => server.close());
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url,
    f,
    adminToken,
    strangerToken,
    async call(name, args = {}, token = adminToken) {
      const res = await fetch(`${url}/api/cmd/${name}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(args),
      });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    },
    get(path, token = adminToken) {
      return fetch(`${url}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
    },
  };
}

test("file and Git commands are registered with the Tauri names", () => {
  const names = createRegistry().names();
  for (const n of [
    "list_files",
    "read_file",
    "read_image",
    "read_file_head",
    "write_file",
    "create_file",
    "upload_file",
    "download_file",
    "list_dirs",
    "create_dir",
    "delete_path",
    "git_log",
    "git_commit",
    "git_diff",
    "git_create_commit",
  ]) {
    assert.ok(names.includes(n), n);
  }
});

test("commands: host rights, list/read/write/delete through the router, paths outside refused", async (t) => {
  const c = await start(t);
  const dir = join(c.f.home, "proj");
  mkdirSync(dir);
  writeFileSync(join(dir, "a.md"), "# A\n");
  const denied = await c.call("list_files", { hostId: "fake", folders: [dir] }, c.strangerToken);
  assert.equal(denied.status, 403);
  const listed = await c.call("list_files", { hostId: "fake", folders: [dir, "~/gone"], git: true, docsOnly: true });
  assert.equal(listed.status, 200);
  const [l, gone] = listed.body.result as { root: string; files: string[]; missing: boolean }[];
  assert.deepEqual([l?.root, l?.files, gone?.missing], [dir, ["a.md"], true]);
  assert.equal((await c.call("read_file", { hostId: "fake", path: `${dir}/a.md` })).body.result, "# A\n");
  assert.equal((await c.call("write_file", { hostId: "fake", path: `${dir}/a.md`, content: "neu" })).status, 200);
  assert.equal(readFileSync(join(dir, "a.md"), "utf8"), "neu");
  const out = await c.call("read_file", { hostId: "fake", path: "/etc/hostname" });
  assert.equal(out.status, 500);
  assert.match(String(out.body.error), /outside the session folders/);
  const bad = await c.call("read_file", { hostId: "fake", path: `${dir}/../../x` });
  assert.match(String(bad.body.error), /Path not allowed/);
  const rootDel = await c.call("delete_path", { hostId: "fake", path: dir, roots: [dir] });
  assert.match(String(rootDel.body.error), /Only files and folders inside/);
  assert.equal((await c.call("delete_path", { hostId: "fake", path: `${dir}/a.md`, roots: [dir] })).status, 200);
  const dirs = await c.call("list_dirs", { hostId: "fake", path: "~" });
  assert.deepEqual((dirs.body.result as { dirs: string[] }).dirs, ["proj"]);
});

test("upload_file: 20 MB through the command router, MAX_UPLOAD_MB default 25", async (t) => {
  const c = await start(t);
  const big = Buffer.alloc(20_000_000, 7);
  big[0] = 0;
  big[big.length - 1] = 255;
  const path = join(c.f.home, "big.bin");
  const res = await c.call("upload_file", { hostId: "fake", path, data: big.toString("base64") });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.equal(res.body.result, true);
  assert.ok(readFileSync(path).equals(big));
  // other commands keep the global 10 MB body limit
  const other = await fetch(`${c.url}/api/cmd/write_file`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${c.adminToken}` },
    body: JSON.stringify({ hostId: "fake", path: join(c.f.home, "w.txt"), content: "x".repeat(11_000_000) }),
  });
  // (the app's error handler answers body-parser's 413 as a plain error)
  assert.ok(!other.ok);
});

test("upload_file: MAX_UPLOAD_MB=1 refuses bigger files, anonymous bodies stay at the global limit", async (t) => {
  const c = await start(t, { MAX_UPLOAD_MB: "1" });
  const path = join(c.f.home, "x.bin");
  const res = await c.call("upload_file", { hostId: "fake", path, data: Buffer.alloc(1_500_000).toString("base64") });
  assert.equal(res.status, 500);
  assert.match(String(res.body.error), /too large to upload \(max\. 1 MB\)/);
  const ok = await c.call("upload_file", { hostId: "fake", path, data: Buffer.alloc(900_000).toString("base64") });
  assert.equal(ok.body.result, true);
  const anon = await fetch(`${c.url}/api/cmd/upload_file`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ data: "a".repeat(100) }),
  });
  assert.equal(anon.status, 401);
});

test("download: streams bytes with headers, login, rights and the path guard", async (t) => {
  const c = await start(t);
  const dir = join(c.f.home, "docs");
  mkdirSync(dir);
  const bytes = Buffer.from([0, 1, 2, 250, 255, 10, 13, 0]);
  writeFileSync(join(dir, "Bericht ä.pdf"), bytes);
  writeFileSync(join(dir, "page.html"), "<script>alert(1)</script>");
  const q = (path: string, extra = "") => `/api/files/download?hostId=fake&path=${encodeURIComponent(path)}${extra}`;

  const res = await c.get(q(`${dir}/Bericht ä.pdf`));
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("content-type"), "application/pdf");
  assert.equal(res.headers.get("content-length"), String(bytes.length));
  assert.match(res.headers.get("content-disposition") ?? "", /^attachment; filename="Bericht _\.pdf"; filename\*=UTF-8''Bericht%20%C3%A4\.pdf$/);
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(bytes));
  // a PDF may open in the browser, HTML never (it would run in our origin)
  assert.match((await c.get(q(`${dir}/Bericht ä.pdf`, "&inline=1"))).headers.get("content-disposition") ?? "", /^inline;/);
  const html = await c.get(q(`${dir}/page.html`, "&inline=1"));
  assert.match(html.headers.get("content-disposition") ?? "", /^attachment;/);
  await html.arrayBuffer();

  assert.equal((await c.get(q(`${dir}/Bericht ä.pdf`), "")).status, 401);
  assert.equal((await c.get(q(`${dir}/Bericht ä.pdf`), c.strangerToken)).status, 403);
  assert.equal((await c.get("/api/files/download?hostId=nope&path=/x")).status, 404);
  assert.equal((await c.get(q(`${dir}/../../etc/passwd`))).status, 400);
  assert.equal((await c.get(q("/etc/passwd"))).status, 403);
  const outside = mkdtempSync(join(tmpdir(), "pibar-dl-outside-"));
  t.after(() => rmSync(outside, { recursive: true, force: true }));
  writeFileSync(join(outside, "s.txt"), "secret");
  symlinkSync(join(outside, "s.txt"), join(dir, "link.txt"));
  const viaLink = await c.get(q(`${dir}/link.txt`));
  assert.equal(viaLink.status, 403);
  assert.match(((await viaLink.json()) as { error: string }).error, /outside the session folders/);
  assert.equal((await c.get(q(`${dir}/missing.pdf`))).status, 404);
  assert.equal((await c.get(q(dir))).status, 404);

  // download_file checks the file and answers the URL of this route
  const cmd = await c.call("download_file", { hostId: "fake", path: `${dir}/Bericht ä.pdf` });
  assert.equal(cmd.body.result, q(`${dir}/Bericht ä.pdf`).replace(/%20/g, "+"));
  const missing = await c.call("download_file", { hostId: "fake", path: `${dir}/missing.pdf` });
  assert.match(String(missing.body.error), /Not a file/);
});

test("download of a larger file streams completely", async (t) => {
  const c = await start(t);
  const big = Buffer.alloc(5_000_000);
  for (let i = 0; i < big.length; i++) big[i] = i % 251;
  writeFileSync(join(c.f.home, "big.bin"), big);
  const res = await c.get(`/api/files/download?hostId=fake&path=${encodeURIComponent(join(c.f.home, "big.bin"))}`);
  assert.equal(res.headers.get("content-type"), "application/octet-stream");
  assert.ok(Buffer.from(await res.arrayBuffer()).equals(big));
});

test("Content-Disposition keeps odd names safe", () => {
  assert.equal(disposition("attachment", 'a"b\\c.txt'), "attachment; filename=\"a_b_c.txt\"; filename*=UTF-8''a%22b%5Cc.txt");
  assert.equal(disposition("inline", "x (1).pdf"), "inline; filename=\"x (1).pdf\"; filename*=UTF-8''x%20%281%29.pdf");
});

test("git commands through the router", async (t) => {
  const c = await start(t);
  await c.f.exec.runShell(
    c.f.host,
    "mkdir -p ~/r && cd ~/r && git init -q -b main && git config user.email t@example.invalid && git config user.name T && echo a > a.md && git add -A && git commit -qm one && echo b > b.md",
  );
  const dir = join(c.f.home, "r");
  const made = await c.call("git_create_commit", { hostId: "fake", dir, paths: ["b.md"], message: "two" });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const log = (await c.call("git_log", { hostId: "fake", dir, file: null, limit: 10 })).body.result as { subject: string; hash: string }[];
  assert.deepEqual(
    log.map((x) => x.subject),
    ["two", "one"],
  );
  const detail = await c.call("git_commit", { hostId: "fake", dir, hash: log[0]?.hash });
  assert.deepEqual((detail.body.result as { files: unknown[] }).files, [{ status: "A", path: "b.md" }]);
  const diff = await c.call("git_diff", { hostId: "fake", dir, hash: log[0]?.hash, path: "b.md", top: true });
  assert.match(String(diff.body.result), /\+b/);
  assert.equal((await c.call("git_log", { hostId: "fake", dir }, c.strangerToken)).status, 403);
});
