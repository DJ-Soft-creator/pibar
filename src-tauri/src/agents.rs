//! Agent definitions for subagent sessions (src/main/subagents.ts): read `~/.pi/agent/agents/*.md` and the nearest
//! `.pi/agents/*.md` above the working folder on the host, parse their frontmatter, and write an agent's system
//! prompt (the body without the frontmatter) to a file below `~/.pibar` that Pi gets via `--append-system-prompt`.

use crate::config::HostCfg;
use crate::hostexec::{self, sq};
use serde::Serialize;

/// One agent definition (a Markdown file with YAML frontmatter, like Pi's subagent extension uses)
#[derive(Serialize, Debug, PartialEq, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AgentInfo {
    pub name: String,
    pub description: String,
    /// Tool allowlist, None = Pi's default
    pub tools: Option<Vec<String>>,
    /// Model ("provider/id" or a bare id), empty = the parent session's model
    pub model: String,
    /// "user" (~/.pi/agent/agents) or "project" (.pi/agents)
    pub source: String,
    /// Path of the definition on the host
    pub path: String,
}

/// Marker lines around each file in the listing script's output
const BEGIN: &str = "===PIBAR-AGENT ";
const END: &str = "===PIBAR-END";

/// Shell script that prints every agent file with its source and path, user agents first (project ones override)
fn list_script(cwd: &str) -> String {
    format!(
        r#"cd {cwd} 2>/dev/null || exit 0
emit() {{
  [ -d "$1" ] || return 0
  for f in "$1"/*.md; do
    [ -f "$f" ] || continue
    printf '{begin}%s %s\n' "$2" "$f"
    cat "$f"
    printf '\n{end}\n'
  done
}}
emit "$HOME/.pi/agent/agents" user
d=$PWD
while :; do
  if [ -d "$d/.pi/agents" ]; then emit "$d/.pi/agents" project; break; fi
  [ "$d" = "/" ] && break
  d=$(dirname "$d")
done"#,
        cwd = hostexec::shell_path(cwd),
        begin = BEGIN,
        end = END,
    )
}

/// Read the agent definitions of a host (user level, plus the nearest project level above `cwd`)
pub fn list(host: &HostCfg, cwd: &str) -> Result<Vec<AgentInfo>, String> {
    let out = hostexec::run_shell(host, &list_script(cwd), None)?;
    Ok(parse_listing(&out))
}

/// Parse the listing script's output; a project agent overrides a user agent with the same name
pub fn parse_listing(out: &str) -> Vec<AgentInfo> {
    let mut agents: Vec<AgentInfo> = Vec::new();
    let mut current: Option<(String, String, Vec<String>)> = None; // source, path, content lines
    for line in out.lines() {
        if let Some(rest) = line.strip_prefix(BEGIN) {
            if let Some((source, path, content)) = current.take() {
                if let Some(a) = parse_agent(&content.join("\n"), &source, &path) {
                    upsert(&mut agents, a);
                }
            }
            let (source, path) = rest.split_once(' ').unwrap_or(("user", rest));
            current = Some((source.to_string(), path.to_string(), Vec::new()));
        } else if line == END {
            if let Some((source, path, content)) = current.take() {
                if let Some(a) = parse_agent(&content.join("\n"), &source, &path) {
                    upsert(&mut agents, a);
                }
            }
        } else if let Some((_, _, content)) = current.as_mut() {
            content.push(line.to_string());
        }
    }
    agents
}

fn upsert(agents: &mut Vec<AgentInfo>, a: AgentInfo) {
    if let Some(old) = agents.iter_mut().find(|x| x.name == a.name) {
        *old = a;
    } else {
        agents.push(a);
    }
}

/// Frontmatter value: a bare scalar or a YAML list in flow form ("[read, bash]")
fn frontmatter_value(v: &str) -> String {
    v.trim().trim_matches(|c| c == '"' || c == '\'').trim().to_string()
}

/// Parse one agent file: frontmatter (name and description required) plus the body as the system prompt
pub fn parse_agent(content: &str, source: &str, path: &str) -> Option<AgentInfo> {
    let (fm, _body) = split_frontmatter(content)?;
    let mut name = String::new();
    let mut description = String::new();
    let mut tools: Option<Vec<String>> = None;
    let mut model = String::new();
    for line in fm.lines() {
        let Some((key, value)) = line.split_once(':') else { continue };
        let value = frontmatter_value(value);
        match key.trim() {
            "name" => name = value,
            "description" => description = value,
            "model" => model = value,
            "tools" => {
                let list: Vec<String> = value
                    .trim_start_matches('[')
                    .trim_end_matches(']')
                    .split(',')
                    .map(frontmatter_value)
                    .filter(|t| !t.is_empty())
                    .collect();
                if !list.is_empty() {
                    tools = Some(list);
                }
            }
            _ => {}
        }
    }
    if name.is_empty() || description.is_empty() {
        return None;
    }
    Some(AgentInfo { name, description, tools, model, source: source.to_string(), path: path.to_string() })
}

/// Split a Markdown file into its frontmatter (between the first two "---" lines) and its body
pub fn split_frontmatter(content: &str) -> Option<(String, String)> {
    let rest = content.strip_prefix("---\n").or_else(|| content.strip_prefix("---\r\n"))?;
    let end = rest.find("\n---")?;
    let fm = rest[..end].to_string();
    let after = &rest[end + 4..];
    let body = after.strip_prefix('\n').or_else(|| after.strip_prefix("\r\n")).unwrap_or(after);
    Some((fm, body.to_string()))
}

/// Write an agent's system prompt (the body of its file) below `~/.pibar/agent-prompts` on the host and return the
/// absolute path. The file stays there, so a child session opened again later keeps its agent prompt.
pub fn prompt_file(host: &HostCfg, path: &str) -> Result<String, String> {
    if !path.ends_with(".md") || path.contains('\n') {
        return Err("not an agent file".into());
    }
    let content = hostexec::run_shell(host, &format!("cat {}", sq(path)), None)?;
    let (_, body) = split_frontmatter(&content).ok_or("agent file has no frontmatter")?;
    let file = format!("prompt-{}.md", crate::bg::hash(path));
    let script = format!(
        "mkdir -p \"$HOME/.pibar/agent-prompts\" && cat > \"$HOME/.pibar/agent-prompts/{file}\" && printf '%s\\n' \"$HOME/.pibar/agent-prompts/{file}\""
    );
    let out = hostexec::run_shell(host, &script, Some(body.as_bytes()))?;
    Ok(out.trim().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    const SCOUT: &str = "---\nname: scout\ndescription: Fast recon\ntools: read, grep, find, ls\nmodel: claude-haiku-4-5\n---\nYou are a scout.\n";

    #[test]
    fn parses_frontmatter_and_body() {
        let a = parse_agent(SCOUT, "user", "/home/u/.pi/agent/agents/scout.md").unwrap();
        assert_eq!(a.name, "scout");
        assert_eq!(a.description, "Fast recon");
        assert_eq!(
            a.tools.as_deref(),
            Some(&["read".to_string(), "grep".to_string(), "find".to_string(), "ls".to_string()][..])
        );
        assert_eq!(a.model, "claude-haiku-4-5");
        let (_, body) = split_frontmatter(SCOUT).unwrap();
        assert_eq!(body, "You are a scout.\n");
    }

    #[test]
    fn parses_flow_lists_and_quotes() {
        let c = "---\nname: \"worker\"\ndescription: 'General'\ntools: [read, bash]\n---\nBody";
        let a = parse_agent(c, "project", "/p/.pi/agents/worker.md").unwrap();
        assert_eq!(a.name, "worker");
        assert_eq!(a.tools.as_deref(), Some(&["read".to_string(), "bash".to_string()][..]));
        assert_eq!(a.model, "");
    }

    #[test]
    fn skips_files_without_name_or_description() {
        assert!(parse_agent("---\nname: x\n---\nBody", "user", "/x.md").is_none());
        assert!(parse_agent("no frontmatter", "user", "/x.md").is_none());
    }

    #[test]
    fn listing_keeps_order_and_project_overrides_user() {
        let out = format!(
            "{BEGIN}user /u/scout.md\n{SCOUT}\n{END}\n{BEGIN}project /p/scout.md\n---\nname: scout\ndescription: Project scout\n---\nOther\n{END}\n"
        );
        let agents = parse_listing(&out);
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].source, "project");
        assert_eq!(agents[0].description, "Project scout");
    }
}
