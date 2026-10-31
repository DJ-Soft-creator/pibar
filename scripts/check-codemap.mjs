#!/usr/bin/env node
// Checks the code references in the docs so the codemap and the code do not drift apart.
//
// Reference syntax in Markdown:   [`Symbol`](../path/to/file.rs)
//   - The link must point to an existing file.
//   - If the link text is a symbol in backticks (e.g. `PiManager::open`, `SessionTab.send`),
//     its last part (open, send) must be defined in that file.
// Also, every source file must be mentioned at least once in docs/CODEMAP.md.
//
//   node scripts/check-codemap.mjs           check (exit code 1 on errors)
//   node scripts/check-codemap.mjs --print   also print all references with line numbers

import fs from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const print = process.argv.includes("--print");
const errors = [];
const resolved = [];

const docFiles = ["README.md", "CONTRIBUTING.md", ...walk("docs").filter((f) => f.endsWith(".md"))];
const sourceFiles = [
  ...walk("src").filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")),
  ...walk("src-tauri/src").filter((f) => f.endsWith(".rs")),
  ...walk("dev").filter((f) => f.endsWith(".mjs")),
  ...walk("scripts").filter((f) => f.endsWith(".mjs")),
];

function walk(dir) {
  const abs = path.join(root, dir);
  if (!fs.existsSync(abs)) return [];
  return fs.readdirSync(abs, { withFileTypes: true }).flatMap((e) => {
    const rel = path.join(dir, e.name);
    return e.isDirectory() ? walk(rel) : [rel];
  });
}

/** Line where a symbol is defined (Rust or TypeScript), otherwise 0 */
function findSymbol(file, name) {
  const lines = fs.readFileSync(path.join(root, file), "utf8").split("\n");
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`\\b(fn|function|class|struct|enum|trait|mod|type|interface|const|let|static)\\s+${n}\\b`),
    new RegExp(`^\\s*(pub\\s+)?(async\\s+)?(static\\s+)?${n}\\s*[(<]`), // method
    new RegExp(`^\\s*(readonly\\s+)?${n}\\s*[:=]`), // field / object entry
    new RegExp(`\\bimpl\\b.*\\b${n}\\b`),
  ];
  const i = lines.findIndex((l) => patterns.some((p) => p.test(l)));
  return i + 1;
}

const linkRe = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const mentioned = new Set();

for (const doc of docFiles) {
  const abs = path.join(root, doc);
  if (!fs.existsSync(abs)) continue;
  // code blocks and ``code with double backticks`` are examples, not references
  const text = fs
    .readFileSync(abs, "utf8")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/``.*?``/g, "");
  for (const m of text.matchAll(linkRe)) {
    const [, label, target] = m;
    if (/^(https?:|mailto:|#)/.test(target)) continue;
    const file = path.normalize(path.join(path.dirname(doc), target.split("#")[0]));
    if (!fs.existsSync(path.join(root, file))) {
      errors.push(`${doc}: link to missing file ${target}`);
      continue;
    }
    if (doc === "docs/CODEMAP.md") mentioned.add(file);
    const sym = label.match(/^`([^`]+)`$/)?.[1];
    if (!sym || sym.includes("/") || sym === path.basename(file)) continue;
    const name = sym.split(/::|\./).pop().replace(/\(\)$/, "");
    const line = findSymbol(file, name);
    if (!line) errors.push(`${doc}: Symbol \`${sym}\` not found in ${file}`);
    else resolved.push(`${file}:${line}  ${sym}`);
  }
}

for (const f of sourceFiles) {
  if (!mentioned.has(path.normalize(f))) errors.push(`docs/CODEMAP.md: source file ${f} is missing from the codemap`);
}

if (print) console.log([...new Set(resolved)].sort().join("\n"));
if (errors.length) {
  console.error(`Codemap check: ${errors.length} error(s)\n  ` + errors.join("\n  "));
  process.exit(1);
}
console.log(`Codemap ok: ${resolved.length} symbol references, ${sourceFiles.length} source files covered.`);
