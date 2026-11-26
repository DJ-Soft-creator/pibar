// Runs in the background (port of src-tauri/src/bg.rs): Pi is started detached on the host (`setsid`/`nohup`), so
// the run keeps going when the webapp restarts or the connection drops. The webapp follows it through a log file
// (`pi --mode json`) and later reads the answer from the session file, which Pi writes anyway.
//
// Two files per session on the host, both below `~/.pibar` and named after a hash of the session file:
// `<hash>.log` (Pi's JSON output) and `<hash>.pid` (Pi's process id). The same files as the desktop, so a run started
// on the desktop can be followed and stopped here and the other way round.
import { piProgram, shellPath, sq, type HostExec, type HostTarget } from "./hostexec.js";

/** Stable name for a session's two files: FNV-1a (64 bit) over the UTF-8 bytes of the session path (bg.rs: hash) */
export function hash(s: string): string {
  let h = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const b of Buffer.from(s, "utf8")) {
    h ^= BigInt(b);
    h = (h * prime) & mask;
  }
  return h.toString(16).padStart(16, "0");
}

/** Program name of Pi on this host without a path: a pid is only ours if its command line carries it (pid reuse) */
export function piName(h: Pick<HostTarget, "piCommand">): string {
  const first = piProgram(h).split(/\s+/)[0] || "pi";
  return first.split("/").pop() || "pi";
}

/** Log and pid file of a session's run on the host (shell snippets, they expand "$HOME") */
export function bgPaths(session: string): { log: string; pid: string } {
  const h = hash(session);
  return { log: `"$HOME"/.pibar/${h}.log`, pid: `"$HOME"/.pibar/${h}.pid` };
}

/** Script that starts Pi detached and returns once Pi wrote its pid (bg.rs: start) */
export function startScript(host: HostTarget, cwd: string, session: string, args: string[]): string {
  const { log, pid } = bgPaths(session);
  // The inner shell writes its own pid and then becomes Pi (`exec`), so the pid file stays right.
  const inner = `echo $$ > ${pid}; exec ${piProgram(host)} --mode json ${args.map(sq).join(" ")}`;
  // setsid is missing on macOS: nohup alone keeps the process alive there
  return (
    `mkdir -p "$HOME"/.pibar && cd ${shellPath(cwd)} && rm -f ${pid} && ` +
    `if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c ${sq(inner)} > ${log} 2>&1 < /dev/null & ` +
    `else nohup sh -c ${sq(inner)} > ${log} 2>&1 < /dev/null & fi; ` +
    `i=0; while [ ! -s ${pid} ] && [ $i -lt 60 ]; do sleep 0.1; i=$((i+1)); done; ` +
    `[ -s ${pid} ]`
  );
}

export function runningScript(host: HostTarget, session: string): string {
  const { pid } = bgPaths(session);
  return (
    `p=$(cat ${pid} 2>/dev/null); ` +
    `if [ -n "$p" ] && kill -0 "$p" 2>/dev/null && ps -p "$p" -o args= 2>/dev/null | grep -qF -e ${sq(piName(host))}; ` +
    `then echo yes; else echo no; fi`
  );
}

export function stopScript(host: HostTarget, session: string): string {
  const { pid } = bgPaths(session);
  return (
    `p=$(cat ${pid} 2>/dev/null); ` +
    `if [ -n "$p" ] && ps -p "$p" -o args= 2>/dev/null | grep -qF -e ${sq(piName(host))}; then kill -TERM "$p" 2>/dev/null; fi; ` +
    `rm -f ${pid}; true`
  );
}

/** Print the log of the session's run and follow it until the process is gone (the follower, pi.rs: open_follow) */
export function followScript(session: string): string {
  const { log, pid } = bgPaths(session);
  return (
    `p=$(cat ${pid} 2>/dev/null); [ -n "$p" ] || exit 1; ` +
    `tail -n +1 -f ${log} & t=$!; ` +
    `while kill -0 "$p" 2>/dev/null; do sleep 0.5; done; sleep 0.4; kill $t 2>/dev/null; rm -f ${pid}; true`
  );
}

/** Pi's command line arguments of a detached run (lib.rs: bg_start) */
export interface BgStartOptions {
  session: string;
  prompt: string;
  provider?: string | null;
  modelId?: string | null;
  thinking?: string | null;
  tools?: string[] | null;
  publicMode?: boolean;
  temperature?: number | null;
}

export function bgArgs(o: BgStartOptions, toolArgs: (t: string[] | null) => string[]): string[] {
  const args = ["--session", o.session];
  // the flag of Pi's mode-guard extension: reduce the context already in the detached run
  if (o.publicMode) args.push("--public-mode");
  // the flag of PiBar's temperature extension: the sampling temperature of the detached run
  const temp = o.temperature;
  if (typeof temp === "number" && Number.isFinite(temp) && temp >= 0 && temp <= 2) args.push("--temperature", String(temp));
  if (o.provider?.trim()) args.push("--provider", o.provider);
  if (o.modelId?.trim()) args.push("--model", o.modelId);
  if (o.thinking?.trim()) args.push("--thinking", o.thinking);
  args.push(...toolArgs(o.tools ?? null));
  args.push(o.prompt);
  return args;
}

export async function bgStart(exec: HostExec, host: HostTarget, cwd: string, session: string, args: string[]) {
  try {
    await exec.runShell(host, startScript(host, cwd, session, args), { timeoutMs: 30_000 });
  } catch (e) {
    throw new Error(`Pi could not be started in the background: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function bgRunning(exec: HostExec, host: HostTarget, session: string): Promise<boolean> {
  return (await exec.runShell(host, runningScript(host, session))).trim() === "yes";
}

export async function bgStop(exec: HostExec, host: HostTarget, session: string): Promise<void> {
  await exec.runShell(host, stopScript(host, session));
}
