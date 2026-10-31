//! A host's model list without a running session: run `pi --list-models` and parse the table.

use crate::config::HostCfg;
use crate::hostexec;
use serde::Serialize;

#[derive(Serialize, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ModelInfo {
    pub provider: String,
    pub id: String,
    pub thinking: bool,
    pub images: bool,
}

pub fn list(host: &HostCfg) -> Result<Vec<ModelInfo>, String> {
    let pi = if host.pi_command.trim().is_empty() { "pi" } else { host.pi_command.trim() };
    let out = hostexec::run_shell(host, &format!("{pi} --list-models"), None)?;
    Ok(parse(&out))
}

/// Table printed by `pi --list-models`: provider, model, context, max-out, thinking, images
pub fn parse(out: &str) -> Vec<ModelInfo> {
    out.lines()
        .filter_map(|l| {
            let c: Vec<&str> = l.split_whitespace().collect();
            if c.len() < 6 || c[0] == "provider" {
                return None;
            }
            Some(ModelInfo {
                provider: c[0].to_string(),
                id: c[1].to_string(),
                thinking: c[4] == "yes",
                images: c[5] == "yes",
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_table_and_skips_header() {
        let out = "provider        model                 context  max-out  thinking  images\n\
                   anthropic       claude-sonnet-4-5     200K     64K      yes       yes\n\
                   amazon-bedrock  amazon.nova-micro-v1  128K     10K      no        no\n\
                   irgendwas kaputt\n";
        let m = parse(out);
        assert_eq!(m.len(), 2);
        assert_eq!(
            m[0],
            ModelInfo { provider: "anthropic".into(), id: "claude-sonnet-4-5".into(), thinking: true, images: true }
        );
        assert!(!m[1].thinking && !m[1].images);
    }
}
