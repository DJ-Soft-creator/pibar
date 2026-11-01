//! Diagnosis for chat errors such as "Connection error": runs on the host with the same shell and environment as
//! Pi and reports Pi/Node versions, relevant environment variables (secrets hidden), Pi's model configuration and
//! whether the model servers are reachable. Started from the error box in the chat or the host settings.

use crate::config::HostCfg;
use crate::hostexec::{self, sq};

/// Report script. PIBAR_PROVIDER / PIBAR_MODEL = model of the failing session (may be empty).
const SCRIPT: &str = r#"
d="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
echo "== Pi"
echo "pi: $(command -v pi || echo 'not found')"
command -v pi >/dev/null 2>&1 && pi --version 2>&1 | head -n 2
echo "node: $(command -v node || echo 'not found') $(node --version 2>/dev/null)"
echo "curl: $(command -v curl || echo 'not found')"
echo "model of the session: ${PIBAR_PROVIDER:-?}/${PIBAR_MODEL:-?}"
echo
echo "== Environment (secrets hidden)"
echo "SHELL=$SHELL"
echo "PATH=$PATH"
env | grep -iE '^([A-Z0-9_]*(API_KEY|_TOKEN|SECRET|BASE_URL|ENDPOINT|PROXY)[A-Z0-9_]*|OLLAMA_HOST|NODE_EXTRA_CA_CERTS|NODE_TLS_REJECT_UNAUTHORIZED)=' \
  | sed -E 's/^([A-Za-z0-9_]*(KEY|TOKEN|SECRET)[A-Za-z0-9_]*)=.*/\1=(set)/; s#://[^/@]*@#://***@#' | sort
echo
echo "== Pi configuration ($d)"
ls "$d" 2>&1 | tr '\n' ' '; echo
if command -v node >/dev/null 2>&1; then
  node -e '
    const fs = require("fs"), p = require("path"), d = process.argv[1];
    const read = (f) => { try { return JSON.parse(fs.readFileSync(p.join(d, f), "utf8")); } catch (e) { return e.code === "ENOENT" ? null : { error: String(e.message) }; } };
    const s = read("settings.json");
    if (s) console.log("settings.json: defaultProvider=" + (s.defaultProvider ?? "-") + " defaultModel=" + (s.defaultModel ?? "-"));
    const a = read("auth.json");
    if (a) console.log("auth.json: credentials for " + (Object.keys(a).join(", ") || "nothing"));
    const m = read("models.json");
    if (m && m.error) console.log("models.json: INVALID – " + m.error);
    else if (m) for (const [name, pr] of Object.entries(m.providers ?? {}))
      console.log("models.json: provider " + name + " baseUrl=" + (pr.baseUrl ?? "-") + " api=" + (pr.api ?? "-") +
        " apiKey=" + (pr.apiKey ? (/^[A-Z0-9_]+$/.test(pr.apiKey) ? "env " + pr.apiKey + (process.env[pr.apiKey] ? " (set)" : " (NOT SET)") : "(literal)") : "-") +
        " models=" + ((pr.models ?? []).map((x) => x.id).join(", ") || "-"));
  ' "$d"
fi
echo
echo "== Server addresses in Pi's configuration and extensions"
# providers can also come from extensions (e.g. a custom provider with its own config or cache file)
found=$( (find "$d" -maxdepth 6 \( -name sessions -o -name node_modules -o -name '.git' -o -name '*.bak*' \) -prune -o -type f \( -name '*.json' -o -name '*.ts' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.yaml' -o -name '*.yml' -o -name '*.toml' -o -name '*.env' \) -size -2000k -print 2>/dev/null \
  | while IFS= read -r f; do
      rel=${f#"$d"/}
      grep -oE 'https?://[A-Za-z0-9._~:@%-]+(:[0-9]+)?(/[A-Za-z0-9._~/%-]*)?' "$f" 2>/dev/null | sed "s#^#$rel: #"
      # addresses without scheme, e.g. "192.168.1.20:1234" or "macmini.local:1234"
      grep -oE '"[A-Za-z0-9.-]+(\.local|\.lan|\.home|\.fritz\.box|\.[0-9]+):[0-9]{2,5}"' "$f" 2>/dev/null | tr -d '"' | sed "s#^#$rel: http://#"
    done) \
  | grep -vE 'json-schema|schemas?\.|github\.com|npmjs|example\.(com|org)|w3\.org|mozilla\.org|localhost/?$' | sort -u | head -n 40)
echo "${found:-none found}"
echo
echo "== Reachability (from this app, same rights as Pi)"
urls=$( (echo "$found" | sed -E 's/^[^ ]+: //' | sed -E 's#^(https?://[^/]+)(/v[0-9]+)?.*#\1\2#'
  node -e '
    try { const m = JSON.parse(require("fs").readFileSync(process.argv[1] + "/models.json", "utf8"));
      for (const pr of Object.values(m.providers ?? {})) if (pr.baseUrl) console.log(pr.baseUrl); } catch {}' "$d" 2>/dev/null
  env | grep -E '_BASE_URL=' | cut -d= -f2-
  case "$PIBAR_PROVIDER" in
    anthropic) echo https://api.anthropic.com ;;
    openai) echo https://api.openai.com/v1 ;;
    google) echo https://generativelanguage.googleapis.com ;;
    openrouter) echo https://openrouter.ai/api/v1 ;;
    groq) echo https://api.groq.com/openai/v1 ;;
    mistral) echo https://api.mistral.ai/v1 ;;
    xai) echo https://api.x.ai/v1 ;;
  esac) | grep -oE 'https?://[^" ]+' | sort -u)
if [ -z "$urls" ]; then echo "no server addresses found"; fi
# line by line: zsh (the default shell on macOS) does not split $urls into words
echo "$urls" | while IFS= read -r u; do
  [ -n "$u" ] || continue
  r=$(curl -sS -m 8 -o /dev/null -w 'HTTP %{http_code} in %{time_total}s' "$u" 2>&1 | tr '\n' ' ')
  echo "curl $u -> $r"
  # Pi talks through Node (fetch/undici), which resolves names, IPv6 and proxies differently than curl
  if command -v node >/dev/null 2>&1; then
    node -e '
      const u = process.argv[1];
      fetch(u, { signal: AbortSignal.timeout(8000) })
        .then((r) => console.log("node " + u + " -> HTTP " + r.status))
        .catch((e) => { const c = e.cause || {}; console.log("node " + u + " -> " + e.name + ": " + e.message +
          (c.code || c.message ? " | cause: " + [c.code, c.message, c.address, c.port].filter(Boolean).join(" ") : "")); });
    ' "$u" 2>&1 | tail -n 2
  fi
done
echo
echo "== Name resolution"
echo "$urls" | while IFS= read -r u; do
  [ -n "$u" ] || continue
  h=$(echo "$u" | sed -E 's#^https?://([^/:]+).*#\1#')
  case "$h" in *[a-zA-Z]*) node -e 'require("dns").lookup(process.argv[1], { all: true }, (e, a) => console.log(process.argv[1] + " -> " + (e ? e.code + " " + e.message : a.map((x) => x.address + " (IPv" + x.family + ")").join(", "))))' "$h" 2>&1 | tail -n 1 ;; esac
done
echo
echo "== Test request through Pi (model of the session, 60 s limit)"
if [ -n "$PIBAR_PROVIDER" ] && [ -n "$PIBAR_MODEL" ] && command -v pi >/dev/null 2>&1; then
  # perl alarm = timeout without coreutils (macOS); --no-session: nothing is saved
  perl -e 'alarm 60; exec @ARGV' pi --no-session --provider "$PIBAR_PROVIDER" --model "$PIBAR_MODEL" -p "Reply with the single word OK." 2>&1 \
    | tail -n 25
else
  echo "skipped (no model or pi not found)"
fi
"#;

/// Run the diagnosis on the host. For local hosts the report also says how much of the shell environment PiBar loaded.
pub fn run(host: &HostCfg, provider: &str, model: &str) -> String {
    let mut out = String::new();
    if host.kind != "ssh" {
        let env = hostexec::user_env();
        out.push_str(&format!(
            "== PiBar\nhost: {} (local)\nshell environment loaded: {} variables\n\n",
            host.name,
            env.len()
        ));
    } else {
        out.push_str(&format!("== PiBar\nhost: {} (SSH {})\n\n", host.name, host.ssh_target));
    }
    let script = format!("PIBAR_PROVIDER={} PIBAR_MODEL={}; {SCRIPT}", sq(provider), sq(model));
    match hostexec::run_shell(host, &script, None) {
        Ok(s) => out.push_str(&s),
        Err(e) => out.push_str(&format!("Diagnosis failed: {e}\n")),
    }
    out
}
