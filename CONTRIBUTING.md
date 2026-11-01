# Contributing to PiBar

Thanks for helping. This page covers setup, workflow and the rules CI checks.
For the code structure see the [Codemap](docs/CODEMAP.md), for background the [architecture decisions](docs/adr/README.md).

## Setup

Requirements: Node.js ≥ 20 (see `.nvmrc`), Rust stable (see `rust-toolchain.toml`), on macOS the Xcode Command Line
Tools, on Linux the [Tauri system packages](https://v2.tauri.app/start/prerequisites/).

```bash
npm install
npm run dev:app        # app in development mode (Rust + Vite with hot reload)
```

Without access to Pi: enter `node <path>/dev/fake-pi.mjs` as the Pi command in the settings
([`fake-pi.mjs`](dev/fake-pi.mjs) simulates answers, thinking, tool calls and the model list).

## Checks

One command checks everything CI checks:

```bash
npm run check
```

| Part | Command | Checks |
| --- | --- | --- |
| TypeScript | `tsc --noEmit` | types (strict) |
| Lint | `npm run lint` | ESLint with typescript-eslint |
| Format | `npm run format:check` / `npm run format` | Prettier and rustfmt (line length 120) |
| Tests | `npm test`, `cargo test` | Vitest for `src/shared`, Rust unit tests |
| Rust lint | `cargo clippy -- -D warnings` | no warnings |
| Codemap | `npm run check:codemap` | code references in the docs are valid |
| Version | `npm run check:version` | same version in `package.json`, lock file, Tauri, Cargo and both READMEs |

## Workflow

1. **Branch** off `main`: `feat/short-name`, `fix/short-name`, `docs/short-name`.
2. **Small changes**: one topic per pull request; several small ones beat one big one.
3. **Commits** in [Conventional Commits](https://www.conventionalcommits.org/) style: `feat: …`, `fix: …`,
   `docs: …`, `refactor: …`, `test: …`, `chore: …`.
4. **Pull request** with the template; `npm run check` must be green.
5. **Docs in the same PR**: new file, new module or changed flow → update the [Codemap](docs/CODEMAP.md).
   Fundamental decision → new [ADR](docs/adr/README.md).
6. **The README always matches the version.** A release bumps the version in `package.json`, `package-lock.json`,
   `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` and the "Version x.y.z" line of `README.md` and `README.de.md`,
   and the READMEs describe what that version does. `npm run check:version` enforces the numbers.

## Code rules

- **Language**: code, identifiers, comments and docs in English.
- **User-facing text** always goes through the translation layer: [`t`](src/shared/i18n.ts) in the UI (English text is
  the key, the German translation goes into the dictionary in the same file), [`tr`](src-tauri/src/i18n.rs) in Rust.
  Static HTML uses `data-i18n`, `data-i18n-title` and `data-i18n-placeholder`. A test fails if a key is missing.
- **Every file starts with a comment** that states its responsibility in one or two sentences.
- **One module, one responsibility.** If a file grows beyond ~400 lines, split it.
- **Pure logic** (no DOM, no Tauri) goes into [`format.ts`](src/shared/format.ts) or its own module in `src/shared/`,
  with tests. In Rust: separate logic from I/O (example: [`models::parse`](src-tauri/src/models.rs)).
- **Shell commands** only through [`run_shell`](src-tauri/src/hostexec.rs) or [`spawn_pi`](src-tauri/src/hostexec.rs),
  and every input quoted with [`sq`](src-tauri/src/hostexec.rs) / [`shell_path`](src-tauri/src/hostexec.rs).
- **No secrets and no personal data** in the repository: no server addresses, user names, keys, sessions or
  screenshots. The [`.gitignore`](.gitignore) catches the usual suspects; check `git status` anyway.
- **New settings** in Rust always with `#[serde(default)]`, so older `config.json` files keep loading.

## Working with AI assistants

The project is prepared for coding agents (Claude Code, Pi, Codex, Cursor …) without tying itself to one vendor:

- **The entry point for agents is the [Codemap](docs/CODEMAP.md).** It lists each file's responsibility and key
  symbols and has a "Where do I change what?" table. The references are checked in CI and therefore reliable;
  `npm run check:codemap -- --print` prints them with line numbers.
- **`npm run check` is the acceptance criterion.** An agent should run it after every change and only report done
  when it is green.
- **Vendor-specific instruction files** (`AGENTS.md`, `CLAUDE.md`, `.cursor/` …) are deliberately **not** committed
  (see `.gitignore`). If you use them locally, point to this file and the Codemap instead of copying content. A good
  local file is three lines long:

  ```markdown
  Read docs/CODEMAP.md and CONTRIBUTING.md first.
  After every change: npm run check (must be green).
  New file or changed flow: update docs/CODEMAP.md in the same step.
  ```

- **Code written by agents** is reviewed like any other code: review in the PR, tests for new logic.
