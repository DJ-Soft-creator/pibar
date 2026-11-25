// Running shell scripts and Pi on a host – the Node port of src-tauri/src/hostexec.rs.
// The webapp only knows SSH hosts: every script runs as `ssh <host> bash -lc '<PATH preamble><script>'`.
// The runner (how a script becomes a process) is exchangeable: SshRunner in production, LocalRunner in tests
// (runs the same script with bash on this machine against a fake $HOME, see test/fakeHost.ts).
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

/** What the webapp needs to reach a host (subset of HostCfg in src/shared/api.ts, kind is always ssh) */
export interface HostTarget {
  id: string;
  name: string;
  /** SSH target: host name or alias from the ssh config */
  sshTarget: string;
  sshUser: string;
  sshPort: number | null;
  /** Command that starts Pi (default: "pi") */
  piCommand: string;
}

/** Turns a script for a host into a running process */
export interface ShellRunner {
  spawnShell(host: HostTarget, script: string): ChildProcessWithoutNullStreams;
}

/** Shell quoting with single quotes (hostexec.rs: sq) */
export function sq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** Quote a path for the shell while keeping "~" expandable (hostexec.rs: shell_path) */
export function shellPath(p: string): string {
  const t = p.trim();
  if (t === "" || t === "~") return '"$HOME"';
  if (t.startsWith("~/")) return `"$HOME"/${sq(t.slice(2))}`;
  return sq(t);
}

/**
 * Add the usual install locations of npm/Node/Pi to PATH – non-interactive SSH shells do not load .bashrc/.zshrc.
 * Same text as PATH_PREAMBLE in hostexec.rs.
 */
export const PATH_PREAMBLE =
  'export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi; ';

/** Where the container finds its SSH key, known_hosts and an optional ssh config (see webapp/README.md) */
export interface SshFiles {
  /** Directory with id_ed25519 / id_rsa, known_hosts and optionally config; null = the user's own ~/.ssh */
  dir: string | null;
}

/** ssh arguments for a host (hostexec.rs: ssh_args without tty – the webapp has no terminal) */
export function sshArgs(h: HostTarget, files: SshFiles = { dir: null }): string[] {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=10",
    "-o",
    "ServerAliveInterval=30",
    "-T",
    "-o",
    "ControlMaster=auto",
    "-o",
    "ControlPath=/tmp/pibar-%C",
    "-o",
    "ControlPersist=600",
  ];
  if (files.dir !== null) {
    const config = join(files.dir, "config");
    args.push("-F", existsSync(config) ? config : "/dev/null");
    for (const key of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
      const file = join(files.dir, key);
      if (existsSync(file)) args.push("-i", file);
    }
    args.push(
      "-o",
      "IdentitiesOnly=yes",
      "-o",
      `UserKnownHostsFile=${join(files.dir, "known_hosts")}`,
      // never accept unknown host keys silently: known_hosts is prepared by the admin (ssh-keyscan)
      "-o",
      "StrictHostKeyChecking=yes",
    );
  }
  if (h.sshPort !== null) args.push("-p", String(h.sshPort));
  const user = h.sshUser.trim();
  const target = h.sshTarget.trim();
  // "--" ends the options: a target such as "-oProxyCommand=…" can never become an ssh option
  args.push("--", user ? `${user}@${target}` : target);
  return args;
}

/** Runs scripts over SSH (production) */
export class SshRunner implements ShellRunner {
  constructor(private readonly files: SshFiles = { dir: null }) {}

  spawnShell(host: HostTarget, script: string): ChildProcessWithoutNullStreams {
    if (!host.sshTarget.trim()) throw new Error(`Host "${host.name}" has no SSH target`);
    // login shell on the host so PATH (npm, nvm) is right
    return spawn("ssh", [...sshArgs(host, this.files), `bash -lc ${sq(PATH_PREAMBLE + script)}`], {
      stdio: ["pipe", "pipe", "pipe"],
    });
  }
}

/**
 * Runs scripts with bash on this machine (tests and local development): $HOME points to `home`,
 * so `~/.pi/agent/sessions` and `~/.pibar` live in a temporary folder.
 */
export class LocalRunner implements ShellRunner {
  constructor(private readonly home: string) {}

  spawnShell(_host: HostTarget, script: string): ChildProcessWithoutNullStreams {
    return spawn("bash", ["-c", PATH_PREAMBLE + script], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: this.home, LANG: "C.UTF-8" },
    });
  }
}

export interface RunOptions {
  stdin?: string | Buffer;
  /** Kill the process after this many ms (default 60 s) */
  timeoutMs?: number;
}

/** Runs scripts and Pi on hosts through a ShellRunner (hostexec.rs: run_shell, spawn_pi) */
export class HostExec {
  constructor(readonly runner: ShellRunner) {}

  /** Run a script and return its stdout; rejects with stderr (or the exit code) when it fails */
  runShell(host: HostTarget, script: string, opts: RunOptions = {}): Promise<string> {
    return this.runShellBuffer(host, script, opts).then((b) => b.toString("utf8"));
  }

  /** Like runShell, but stdout as raw bytes (downloads, images) */
  runShellBuffer(host: HostTarget, script: string, opts: RunOptions = {}): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = this.runner.spawnShell(host, script);
      } catch (e) {
        reject(e instanceof Error ? e : new Error(String(e)));
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, opts.timeoutMs ?? 60_000);
      child.stdout.on("data", (d: Buffer) => out.push(d));
      child.stderr.on("data", (d: Buffer) => err.push(d));
      child.on("error", (e) => {
        clearTimeout(timer);
        reject(spawnError(e));
      });
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error("Timeout on the host"));
          return;
        }
        if (code !== 0) {
          const msg = Buffer.concat(err).toString("utf8").trim();
          reject(new Error(msg || `Exit code ${code ?? signal ?? "?"}`));
          return;
        }
        resolve(Buffer.concat(out));
      });
      child.stdin.on("error", () => {
        /* the script may exit before reading stdin */
      });
      if (opts.stdin !== undefined) child.stdin.end(opts.stdin);
      else child.stdin.end();
    });
  }

  /** Start Pi in RPC mode in the given folder (hostexec.rs: spawn_pi) */
  spawnPi(host: HostTarget, cwd: string, extraArgs: string[] = []): ChildProcessWithoutNullStreams {
    return this.runner.spawnShell(host, piScript(host, cwd, "rpc", extraArgs));
  }
}

/** Command that starts Pi on the host */
export function piProgram(host: Pick<HostTarget, "piCommand">): string {
  return host.piCommand.trim() || "pi";
}

/** Script that starts Pi in a mode in a folder: `cd <cwd> && exec pi --mode <mode> <args>` */
export function piScript(host: HostTarget, cwd: string, mode: "rpc" | "json", extraArgs: string[]): string {
  const args = extraArgs.map(sq).join(" ");
  return `cd ${shellPath(cwd)} && exec ${piProgram(host)} --mode ${mode} ${args}`.trimEnd();
}

function spawnError(e: Error & { code?: string }): Error {
  if (e.code === "ENOENT") return new Error("Program 'ssh' not found");
  return new Error(`Start failed: ${e.message}`);
}
