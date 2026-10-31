//! Run commands on a host: locally through the login shell, remotely through SSH.
//! Both paths use the same shell script so sessions and files work the same everywhere.

use crate::config::HostCfg;
use crate::i18n::tr;
use std::io::Write;
use std::process::{Child, Command, Stdio};

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

fn login_shell() -> String {
    std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
}

fn ssh_command(h: &HostCfg) -> Command {
    let mut c = Command::new("ssh");
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
        let mut c = Command::new(login_shell());
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
    fn injection_stays_quoted() {
        // a path with shell characters must never be executed
        assert_eq!(shell_path("/tmp/$(rm -rf ~)"), "'/tmp/$(rm -rf ~)'");
    }
}
