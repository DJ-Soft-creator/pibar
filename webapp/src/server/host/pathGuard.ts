// Where the file and Git commands may reach on a host. The desktop only checks the shape of a path (files.rs:
// check_path_shape); the webapp is used by several people, so every path is also resolved ON THE HOST (symlinks
// followed, "~" expanded) and must lie inside the allowed folders: the host user's home folder and the working
// folders of the host's sessions (plus the host's default folder) when those lie outside it. Credential folders
// inside the home folder (~/.ssh, ~/.gnupg, Pi's auth.json …) are always refused. The check runs as a shell prefix
// in the same script as the command, so it costs no extra round trip.
import { listSessions } from "./sessions.js";
import { shellPath, type HostExec, type HostTarget } from "./hostexec.js";

/** Start of the error when a path lies outside the allowed folders (the command retries once with fresh roots) */
export const OUTSIDE = "Path not allowed (outside the session folders)";

/** Paths below the home folder that never go through the file commands, as `case` patterns relative to $HOME */
const PROTECTED = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".password-store",
  ".netrc",
  ".git-credentials",
  ".config/gh",
  ".config/gcloud",
  ".local/share/keyrings",
  ".pi/agent/auth.json",
];

const PROTECTED_CASE = PROTECTED.flatMap((p) => [p, `${p}/*`]).join("|");

/**
 * Shell functions of the guard (bash, like every host script). pibar_real prints the canonical absolute path of a
 * path: symlinks resolved (at most 40), folders through `cd -P`, a missing tail kept as written (so new files and
 * folders can be checked before they exist). pibar_guard refuses (stderr + exit 3) unless the path lies inside $HOME
 * or one of PIBAR_ROOTS; with "parent" only the folder the entry lies in is resolved, because deleting or replacing
 * a symlink touches the link, never its target.
 */
export const GUARD_FNS = `pibar_real() {
  local p=$1 t n=0 d b r
  while [ -h "$p" ]; do
    n=$((n + 1)); [ "$n" -gt 40 ] && return 1
    t=$(readlink -- "$p") || return 1
    case $t in /*) p=$t ;; *) p=$(dirname -- "$p")/$t ;; esac
  done
  if [ -d "$p" ]; then (cd -P -- "$p" 2>/dev/null && pwd -P) || return 1; return 0; fi
  d=$(dirname -- "$p"); b=$(basename -- "$p")
  if [ "$d" = "$p" ]; then printf '%s\\n' "$p"; return 0; fi
  r=$(pibar_real "$d") || return 1
  [ "$r" = / ] && r=
  printf '%s/%s\\n' "$r" "$b"
}
pibar_guard() {
  local p=$1 r h root rel
  if [ "$2" = parent ]; then
    r=$(pibar_real "$(dirname -- "$p")") || r=
    if [ -n "$r" ]; then [ "$r" = / ] && r=; r=$r/$(basename -- "$p"); fi
  else
    r=$(pibar_real "$p") || r=
  fi
  if [ -z "$r" ]; then echo "Path not allowed (cannot be resolved): $p" >&2; exit 3; fi
  h=$(cd -P -- "$HOME" 2>/dev/null && pwd -P)
  if [ -n "$h" ] && [ "$h" != / ]; then
    case $r in "$h"/*)
      rel=\${r#"$h"/}
      case $rel in ${PROTECTED_CASE}) echo "Path not allowed (protected folder): $p" >&2; exit 3 ;; esac ;;
    esac
  fi
  for root in "$h" "\${PIBAR_ROOTS[@]}"; do
    [ -n "$root" ] || continue
    root=$(pibar_real "$root") || continue
    [ "$root" = / ] && continue
    [ "$r" = "$root" ] && return 0
    case $r in "$root"/*) return 0 ;; esac
  done
  echo "${OUTSIDE}: $p" >&2; exit 3
}
`;

/** One path to check: `parent` = only its folder is resolved (delete, see GUARD_FNS) */
export interface GuardCheck {
  path: string;
  parent?: boolean;
}

/** Script prefix that checks the paths and stops the script (exit 3) at the first one not allowed */
export function guardPrefix(roots: string[], checks: GuardCheck[]): string {
  const list = roots.filter((r) => r.trim() && r.trim() !== "/").map(shellPath);
  const calls = checks.map((c) => `pibar_guard ${shellPath(c.path)}${c.parent ? " parent" : ""}\n`).join("");
  return `PIBAR_ROOTS=(${list.join(" ")})\n${GUARD_FNS}${calls}`;
}

/** Keep the session folders of a host this long before asking the host again */
const ROOTS_TTL_MS = 60_000;
/** A refused path triggers a fresh list only if the cached one is older than this (a session just started) */
const RETRY_AFTER_MS = 5_000;

/**
 * The working folders of a host's sessions, cached per host. Shared by the file commands, the Git commands and the
 * download route of one server (one cache per HostExec, so the tests' fake hosts never see each other's folders).
 */
export class SessionRoots {
  private readonly cache = new Map<string, { roots: string[]; at: number }>();

  constructor(
    private readonly exec: HostExec,
    private readonly timing = { ttlMs: ROOTS_TTL_MS, retryAfterMs: RETRY_AFTER_MS },
  ) {}

  /** Working folders of the host's sessions (from list_sessions); `fresh` asks the host again */
  async roots(host: HostTarget, fresh = false): Promise<{ roots: string[]; age: number }> {
    const hit = this.cache.get(host.id);
    const now = Date.now();
    if (hit && !fresh && now - hit.at < this.timing.ttlMs) return { roots: hit.roots, age: now - hit.at };
    let roots: string[] = [];
    try {
      const sessions = await listSessions(this.exec, host);
      roots = [...new Set(sessions.map((s) => s.cwd).filter((c) => c.trim() !== ""))];
    } catch {
      // the home folder still works without the session list
      roots = hit?.roots ?? [];
    }
    this.cache.set(host.id, { roots, at: now });
    return { roots, age: 0 };
  }

  /**
   * Run a guarded script: `build` gets the root list and returns the script (with guardPrefix in front). A path the
   * guard refuses as outside is tried once more with a fresh session list, since a new session may have started
   * in that folder since the last look.
   */
  async run<T>(host: HostTarget, extra: string[], build: (roots: string[]) => Promise<T>): Promise<T> {
    const first = await this.roots(host);
    try {
      return await build([...first.roots, ...extra]);
    } catch (e) {
      if (!(e instanceof Error) || !e.message.includes(OUTSIDE) || first.age < this.timing.retryAfterMs) throw e;
      const again = await this.roots(host, true);
      return build([...again.roots, ...extra]);
    }
  }
}

const shared = new WeakMap<HostExec, SessionRoots>();

/** The SessionRoots of a HostExec (one per server) */
export function sessionRoots(exec: HostExec): SessionRoots {
  let r = shared.get(exec);
  if (!r) {
    r = new SessionRoots(exec);
    shared.set(exec, r);
  }
  return r;
}
