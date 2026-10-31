# 0002 – Pi in RPC mode, remote hosts directly over SSH

Status: accepted
Date: 2026-10-31

## Context

PiBar should talk to Pi locally and on servers. A separate service ("bridge") per host with a WebSocket API was
considered. Pi already has an RPC mode: `pi --mode rpc` speaks JSON lines over stdin/stdout
([Pi docs](https://pi.dev/docs/latest/rpc)).

## Decision

- One `pi --mode rpc` process per open session, locally through the login shell, remotely via `ssh <host> bash -lc …`.
  Implemented in [`spawn_pi`](../../src-tauri/src/hostexec.rs) and [`PiManager`](../../src-tauri/src/pi.rs).
- The app reads the session list and files with plain shell commands over the same path
  ([`run_shell`](../../src-tauri/src/hostexec.rs)).
- SSH uses the system `ssh` with `~/.ssh/config`, ssh-agent and connection sharing (ControlMaster).

## Consequences

- Nothing but Pi needs to be installed on the server.
- If the SSH connection drops, the Pi process ends; the session stays as a file and can be reopened. Long runs across
  connection drops could later be handled by herdr.
- Login must work without a password prompt (`BatchMode=yes`).
- All paths and arguments are quoted with [`sq`](../../src-tauri/src/hostexec.rs) or
  [`shell_path`](../../src-tauri/src/hostexec.rs); tests in the same file.
