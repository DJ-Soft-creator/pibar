#!/usr/bin/env node
// Checks that the version is the same everywhere: package.json (source of truth), package-lock.json,
// src-tauri/tauri.conf.json, src-tauri/Cargo.toml and the "Version x.y.z" line in README.md and README.de.md.
// Project rule: the README always matches the version.
//
//   node scripts/check-version.mjs   (exit code 1 on a mismatch)

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");

const version = JSON.parse(read("package.json")).version;
const found = {
  "package-lock.json": JSON.parse(read("package-lock.json")).version,
  "src-tauri/tauri.conf.json": JSON.parse(read("src-tauri/tauri.conf.json")).version,
  "src-tauri/Cargo.toml": read("src-tauri/Cargo.toml").match(/^version\s*=\s*"([^"]+)"/m)?.[1],
  "README.md": read("README.md").match(/Version (\d+\.\d+\.\d+)/)?.[1],
  "README.de.md": read("README.de.md").match(/Version (\d+\.\d+\.\d+)/)?.[1],
};

const wrong = Object.entries(found).filter(([, v]) => v !== version);
if (wrong.length) {
  console.error(`Version check: package.json says ${version}, but`);
  for (const [file, v] of wrong) console.error(`  ${file}: ${v ?? "no version found"}`);
  process.exit(1);
}
console.log(`Version ok: ${version} in package.json, lock file, Tauri, Cargo and both READMEs.`);
