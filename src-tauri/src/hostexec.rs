//! Run commands on a host: locally through the login shell, remotely through SSH.
//! Both paths use the same shell script so sessions and files work the same everywhere.
//! Local commands get the environment of the user's interactive shell (see [`user_env`]).

use crate::config::HostCfg;
use crate::disclaim;
use crate::i18n::tr;
use std::io::Write;
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

const ENV_MARK: &str = "__PIBAR_ENV__";

/// Variables that belong to the shell that printed them, not to the user's setup
const ENV_SKIP: &[&str] =
    &["_", "PWD", "OLDPWD", "SHLVL", "PS1", "PS2", "PROMPT", "RPROMPT", "TERM", "COLUMNS", "LINES"];

/// Parse the output of `printf MARK; env -0`: everything before the marker is shell chatter (greetings, prompts)
pub fn parse_env(out: &[u8]) -> Vec<(String, String)> {
    let text = String::from_utf8_lossy(out);
    let Some(start) = text.find(ENV_MARK) else { return vec![] };
    text[start + ENV_MARK.len()..]
        .split('\0')
        .filter_map(|kv| {
            let kv = kv.trim_start_matches('\n');
            let (k, v) = kv.split_once('=')?;
            let ok = !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
            (ok && !ENV_SKIP.contains(&k)).then(|| (k.to_string(), v.to_string()))
        })
        .collect()
}

/// Environment of the user's interactive login shell, read once (at most 10 s).
/// An app started from the Finder only gets a minimal environment; variables from ~/.zshrc such as API keys, base
/// URLs of model servers, proxies or PATH entries would be missing for Pi. Terminals and VS Code solve it the same way.
pub fn user_env() -> &'static [(String, String)] {
    static ENV: OnceLock<Vec<(String, String)>> = OnceLock::new();
    ENV.get_or_init(|| {
        if cfg!(windows) {
            return vec![];
        }
        let Ok(child) = Command::new(login_shell())
            .args(["-ilc", &format!("printf '{ENV_MARK}'; env -0")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
        else {
            return vec![];
        };
        let pid = child.id();
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(child.wait_with_output());
        });
        match rx.recv_timeout(Duration::from_secs(10)) {
            Ok(Ok(out)) => parse_env(&out.stdout),
            _ => {
                // shell hangs (e.g. waits for input): give up and keep the app's own environment
                let _ = Command::new("kill").arg(pid.to_string()).status();
                vec![]
            }
        }
    })
}

/// Shell quoting with single quotes.
pub fn sq(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Quote a path for the shell while keeping "~" expandable.
pub fn shell_path(p: &str) -> String {
    let p = p.trim();
    if p.is_empty() || p == "~" {
        "\"$HOME\"".into()
    } else if let Some(rest) = p.strip_prefix("~/") {
        format!("\"$HOME\"/{}", sq(rest))
    } else {
        sq(p)
    }
}

/// Shell of the user. Apps started from the Finder may lack $SHELL: then zsh (macOS default) or sh.
fn login_shell() -> String {
    std::env::var("SHELL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| if cfg!(target_os = "macos") { "/bin/zsh" } else { "/bin/sh" }.into())
}

fn ssh_command(h: &HostCfg) -> Command {
    let mut c = disclaim::command("ssh");
    c.args([
        "-T",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=30",
        "-o",
        "ControlMaster=auto",
        "-o",
        "ControlPath=/tmp/pibar-%C",
        "-o",
        "ControlPersist=600",
    ]);
    if let Some(port) = h.ssh_port {
        c.args(["-p", &port.to_string()]);
    }
    let target = if h.ssh_user.trim().is_empty() {
        h.ssh_target.trim().to_string()
    } else {
        format!("{}@{}", h.ssh_user.trim(), h.ssh_target.trim())
    };
    c.arg(target);
    c
}

/// Add the usual install locations of npm/Node/Pi to PATH.
/// Non-interactive shells (SSH, apps started from the Finder) do not load .bashrc/.zshrc.
const PATH_PREAMBLE: &str = r#"export PATH="$HOME/.npm-global/bin:$HOME/.local/bin:$HOME/.bun/bin:$HOME/.volta/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"; if ! command -v node >/dev/null 2>&1 && [ -s "$HOME/.nvm/nvm.sh" ]; then . "$HOME/.nvm/nvm.sh" >/dev/null 2>&1; fi; "#;

/// Build the process for a shell script on the host.
pub fn shell_command(h: &HostCfg, script: &str) -> Command {
    let script = format!("{PATH_PREAMBLE}{script}");
    let script = script.as_str();
    if h.kind == "ssh" {
        let mut c = ssh_command(h);
        // login shell on the host so PATH (npm, nvm) is right
        c.arg(format!("bash -lc {}", sq(script)));
        c
    } else {
        let mut c = disclaim::command(&login_shell());
        c.envs(user_env().iter().map(|(k, v)| (k.as_str(), v.as_str())));
        c.arg("-lc").arg(script);
        c
    }
}

/// Run a script and return its stdout.
pub fn run_shell(h: &HostCfg, script: &str, stdin: Option<&[u8]>) -> Result<String, String> {
    let mut cmd = shell_command(h, script);
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.stdin(if stdin.is_some() { Stdio::piped() } else { Stdio::null() });
    let mut child = cmd.spawn().map_err(|e| spawn_error(h, e))?;
    if let Some(data) = stdin {
        if let Some(mut si) = child.stdin.take() {
            si.write_all(data).map_err(|e| e.to_string())?;
        }
    }
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
        return Err(if err.is_empty() {
            tr(format!("Exit code {}", out.status), format!("Exit-Code {}", out.status))
        } else {
            err
        });
    }
    Ok(String::from_utf8_lossy(&out.stdout).to_string())
}

/// Start Pi in RPC mode in the given folder.
pub fn spawn_pi(h: &HostCfg, cwd: &str, extra_args: &[String]) -> Result<Child, String> {
    let pi = if h.pi_command.trim().is_empty() { "pi" } else { h.pi_command.trim() };
    let args: Vec<String> = extra_args.iter().map(|a| sq(a)).collect();
    let script = format!("cd {} && exec {} --mode rpc {}", shell_path(cwd), pi, args.join(" "));
    let mut cmd = shell_command(h, &script);
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.spawn().map_err(|e| spawn_error(h, e))
}

fn spawn_error(h: &HostCfg, e: std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::NotFound {
        if h.kind == "ssh" {
            tr("Program 'ssh' not found", "Programm 'ssh' nicht gefunden")
        } else {
            tr(format!("Shell '{}' not found", login_shell()), format!("Shell '{}' nicht gefunden", login_shell()))
        }
    } else {
        tr(format!("Start failed: {e}"), format!("Start fehlgeschlagen: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quotes_single_quotes() {
        assert_eq!(sq("a b"), "'a b'");
        assert_eq!(sq("it's"), "'it'\\''s'");
    }

    #[test]
    fn keeps_home_expandable() {
        assert_eq!(shell_path("~"), "\"$HOME\"");
        assert_eq!(shell_path(""), "\"$HOME\"");
        assert_eq!(shell_path("~/my dir"), "\"$HOME\"/'my dir'");
        assert_eq!(shell_path("/opt/x"), "'/opt/x'");
    }

    #[test]
    fn reads_shell_environment() {
        let out = b"Welcome!\n__PIBAR_ENV__OPENAI_BASE_URL=http://mini:1234/v1\0PATH=/opt/homebrew/bin:/usr/bin\0_=/usr/bin/env\0MULTI=a\nb\0";
        let env = parse_env(out);
        assert!(env.contains(&("OPENAI_BASE_URL".into(), "http://mini:1234/v1".into())));
        assert!(env.contains(&("PATH".into(), "/opt/homebrew/bin:/usr/bin".into())));
        assert!(env.contains(&("MULTI".into(), "a\nb".into())));
        assert!(!env.iter().any(|(k, _)| k == "_"));
        assert!(parse_env(b"no marker").is_empty());
    }

    #[test]
    fn injection_stays_quoted() {
        // a path with shell characters must never be executed
        assert_eq!(shell_path("/tmp/$(rm -rf ~)"), "'/tmp/$(rm -rf ~)'");
    }
}
