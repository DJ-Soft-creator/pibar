# 0007 – Mobile webapp as its own Pi client over SSH

Status: accepted
Date: 2026-11-26

## Context

PiBar should be usable from a phone: the same Pi sessions as on the desktop, everything except the terminal. A first
version of `webapp/` only mirrored the desktop's config (names, colours, groups) that the desktop pushed to it without
authentication; it could not open a session, and it depended on the Mac being on. It is reached from the phone over
a VPN and Nginx Proxy Manager (HTTPS), runs in Docker on an internal host, and is used by more than one person.

## Decision

- **The webapp talks to the Pi hosts itself, over SSH**, like the desktop's Rust core (ADR 0002). The Rust modules of
  `src-tauri/src/` are ported 1:1 to `webapp/src/server/host/` with the same shell scripts. The sessions are the JSONL
  files on the hosts, so desktop and webapp see the same sessions without any sync.
- **Same command names as Tauri.** The server offers `POST /api/cmd/<name>` with the arguments of `src-tauri/src/lib.rs`.
  In the client every `@tauri-apps/api/*` import resolves to a bridge (`webapp/client/src/bridge.ts`) that calls the
  server, so `src/shared/api.ts` and the rest of `src/shared/` run unchanged. The mobile UI is new (`webapp/client/`);
  `src/main/` stays the desktop layout and serves as the behaviour reference.
- **Pi processes belong to the server**, not to a browser tab: a locked phone does not stop an answer. Events get
  sequence numbers and a ring buffer; a client that reconnects asks for what it missed. A session already open in the
  webapp is joined, never started twice; a lock file on the host (`~/.pibar/<hash>.lock`) keeps desktop and webapp from
  running the same session at the same time.
- **Shared organisation, synced with the desktop**: session metadata, groups and projects live in the webapp
  (`meta.json`) with `updatedAt` per entry and tombstones; the desktop syncs both ways with an API token (last writer
  wins). Hosts, users and their host rights, presets, quick actions and colour profiles are managed in the webapp.
- **Security**: login with an HttpOnly SameSite=Strict cookie, cross-site guard for cookie requests and WebSocket
  upgrades, CSP without inline scripts, host rights checked per command, path guards as in the Rust core, SSH key and
  `known_hosts` mounted read-only (`StrictHostKeyChecking=yes`), API keys of the voice services never leave the server.
- **Left out**: terminal, quick bar, global hotkeys, double tap, screenshots/OCR – they need the desktop.

## Consequences

- Two implementations of the host access exist (Rust and TypeScript). Changes to a shell script in `src-tauri/src/`
  must be made in `webapp/src/server/host/` as well; the ported Rust tests run in both.
- The Docker image is built from the repository root because the client bundles `src/shared/`.
- New desktop features with a Tauri command reach the webapp once the server registers that command.
