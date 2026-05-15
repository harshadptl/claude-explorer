use anyhow::{Context, Result};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

#[derive(Debug, Serialize, Deserialize)]
pub struct Snapshot {
    pub scanned_at: DateTime<Utc>,
    pub home_dir: Option<String>,
    pub claude_dir: Option<String>,
    pub claude_dir_exists: bool,
    pub claude_config_dir_override: Option<String>,
    pub global: GlobalConfig,
    pub skills: Vec<Skill>,
    pub agents: Vec<Agent>,
    pub commands: Vec<SlashCommand>,
    pub mcp_servers: Vec<McpServer>,
    pub hooks: Vec<Hook>,
    pub projects: Vec<Project>,
    pub warnings: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct GlobalConfig {
    pub settings_path: Option<String>,
    pub settings_raw: Option<serde_json::Value>,
    pub model: Option<String>,
    pub theme: Option<String>,
    pub env: serde_json::Value,
    pub permissions: Permissions,
    pub legacy_claude_json_path: Option<String>,
    pub legacy_claude_json_size_bytes: Option<u64>,
    pub user_claude_md_path: Option<String>,
    pub user_claude_md_preview: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Default)]
pub struct Permissions {
    pub allow: Vec<String>,
    pub deny: Vec<String>,
    pub ask: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Skill {
    pub name: String,
    pub description: Option<String>,
    pub scope: String,            // "user" or project path
    pub path: String,
    pub allowed_tools: Vec<String>,
    pub body_preview: String,
    pub has_supporting_files: bool,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Agent {
    pub name: String,
    pub description: Option<String>,
    pub model: Option<String>,
    pub tools: Vec<String>,
    pub scope: String,
    pub path: String,
    pub body_preview: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct SlashCommand {
    pub name: String,
    pub scope: String,
    pub path: String,
    pub body_preview: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct McpServer {
    pub name: String,
    pub source: String, // file it was found in
    pub scope: String,  // "user" or project path
    pub transport: Option<String>,
    pub command: Option<String>,
    pub url: Option<String>,
    pub raw: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Hook {
    pub event: String,
    pub matcher: Option<String>,
    pub command: Option<String>,
    pub scope: String,
    pub source: String,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct Project {
    pub path: String,
    pub name: String,
    pub session_count: usize,
    pub last_modified: Option<DateTime<Utc>>,
    pub has_claude_md: bool,
    pub has_settings: bool,
    pub claude_md_preview: Option<String>,
    pub settings_path: Option<String>,
}

// ---- Entry point ---------------------------------------------------------

pub fn scan_all() -> Result<Snapshot> {
    let mut warnings: Vec<String> = Vec::new();

    let home = dirs::home_dir();
    let config_dir_override = std::env::var("CLAUDE_CONFIG_DIR").ok();
    let claude_dir = config_dir_override
        .as_ref()
        .map(|s| PathBuf::from(s))
        .or_else(|| home.as_ref().map(|h| h.join(".claude")));
    if let Some(ref ov) = config_dir_override {
        warnings.push(format!("CLAUDE_CONFIG_DIR is set: using {ov} instead of ~/.claude"));
    }
    let claude_dir_exists = claude_dir
        .as_ref()
        .map(|p| p.exists())
        .unwrap_or(false);

    let global = scan_global(home.as_deref(), claude_dir.as_deref(), &mut warnings);

    let mut skills = Vec::new();
    let mut agents = Vec::new();
    let mut commands = Vec::new();
    let mut mcp_servers = Vec::new();
    let mut hooks = Vec::new();

    if let Some(dir) = claude_dir.as_deref() {
        scan_skills(&dir.join("skills"), "user", &mut skills, &mut warnings);
        scan_agents(&dir.join("agents"), "user", &mut agents, &mut warnings);
        scan_commands(&dir.join("commands"), "user", &mut commands, &mut warnings);
    }

    // Pull MCP servers and hooks from global settings.json
    if let Some(ref raw) = global.settings_raw {
        extract_mcp_from_settings(raw, "user", &global.settings_path.clone().unwrap_or_default(), &mut mcp_servers);
        extract_hooks_from_settings(raw, "user", &global.settings_path.clone().unwrap_or_default(), &mut hooks);
    }

    // Projects are tracked in ~/.claude/projects (session transcripts)
    let projects = scan_projects(
        claude_dir.as_deref(),
        &mut skills,
        &mut agents,
        &mut commands,
        &mut mcp_servers,
        &mut hooks,
        &mut warnings,
    );

    Ok(Snapshot {
        scanned_at: Utc::now(),
        home_dir: home.as_ref().map(|p| p.to_string_lossy().into_owned()),
        claude_dir: claude_dir.as_ref().map(|p| p.to_string_lossy().into_owned()),
        claude_dir_exists,
        claude_config_dir_override: config_dir_override,
        global,
        skills,
        agents,
        commands,
        mcp_servers,
        hooks,
        projects,
        warnings,
    })
}

// ---- Global config -------------------------------------------------------

fn scan_global(
    home: Option<&Path>,
    claude_dir: Option<&Path>,
    warnings: &mut Vec<String>,
) -> GlobalConfig {
    let mut cfg = GlobalConfig::default();

    if let Some(dir) = claude_dir {
        let settings_path = dir.join("settings.json");
        if settings_path.exists() {
            cfg.settings_path = Some(settings_path.to_string_lossy().into_owned());
            match fs::read_to_string(&settings_path) {
                Ok(text) => match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(value) => {
                        cfg.model = value.get("model").and_then(|v| v.as_str()).map(String::from);
                        cfg.theme = value.get("theme").and_then(|v| v.as_str()).map(String::from);
                        cfg.env = value.get("env").cloned().unwrap_or(serde_json::Value::Null);
                        if let Some(perms) = value.get("permissions") {
                            cfg.permissions.allow = collect_strings(perms.get("allow"));
                            cfg.permissions.deny = collect_strings(perms.get("deny"));
                            cfg.permissions.ask = collect_strings(perms.get("ask"));
                        }
                        cfg.settings_raw = Some(value);
                    }
                    Err(e) => warnings.push(format!("Could not parse {}: {e}", settings_path.display())),
                },
                Err(e) => warnings.push(format!("Could not read {}: {e}", settings_path.display())),
            }
        } else {
            warnings.push(format!("{} not found", settings_path.display()));
        }

        // Optional user-level CLAUDE.md
        let user_md = dir.join("CLAUDE.md");
        if user_md.exists() {
            cfg.user_claude_md_path = Some(user_md.to_string_lossy().into_owned());
            if let Ok(content) = fs::read_to_string(&user_md) {
                cfg.user_claude_md_preview = Some(truncate(&content, 800));
            }
        }
    }

    // The legacy ~/.claude.json — note size but don't parse fully (it's huge for many users)
    if let Some(h) = home {
        let legacy = h.join(".claude.json");
        if legacy.exists() {
            cfg.legacy_claude_json_path = Some(legacy.to_string_lossy().into_owned());
            if let Ok(meta) = fs::metadata(&legacy) {
                cfg.legacy_claude_json_size_bytes = Some(meta.len());
            }
        }
    }

    cfg
}

// ---- Skills --------------------------------------------------------------

fn scan_skills(
    skills_dir: &Path,
    scope: &str,
    out: &mut Vec<Skill>,
    warnings: &mut Vec<String>,
) {
    if !skills_dir.exists() {
        return;
    }
    let entries = match fs::read_dir(skills_dir) {
        Ok(e) => e,
        Err(e) => {
            warnings.push(format!("Could not read {}: {e}", skills_dir.display()));
            return;
        }
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let skill_md = path.join("SKILL.md");
        if !skill_md.exists() {
            continue;
        }
        match parse_skill(&skill_md, scope) {
            Ok(s) => out.push(s),
            Err(e) => warnings.push(format!("Skill parse failed for {}: {e}", skill_md.display())),
        }
    }
}

fn parse_skill(path: &Path, scope: &str) -> Result<Skill> {
    let content = fs::read_to_string(path).with_context(|| format!("reading {}", path.display()))?;
    let (frontmatter, body) = split_frontmatter(&content);
    let yaml: serde_yaml::Value = if frontmatter.is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(&frontmatter).unwrap_or(serde_yaml::Value::Null)
    };
    let name = yaml
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            path.parent()
                .and_then(|p| p.file_name())
                .map(|s| s.to_string_lossy().into_owned())
        })
        .unwrap_or_else(|| "unnamed".to_string());
    let description = yaml.get("description").and_then(|v| v.as_str()).map(String::from);
    let allowed_tools = yaml
        .get("allowed-tools")
        .and_then(|v| v.as_str())
        .map(|s| s.split(',').map(|x| x.trim().to_string()).collect::<Vec<_>>())
        .unwrap_or_default();

    // Detect supporting files in the same directory other than SKILL.md
    let parent = path.parent().unwrap_or(Path::new("."));
    let has_supporting_files = WalkDir::new(parent)
        .max_depth(3)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path() != path && e.file_type().is_file())
        .next()
        .is_some();

    Ok(Skill {
        name,
        description,
        scope: scope.to_string(),
        path: path.to_string_lossy().into_owned(),
        allowed_tools,
        body_preview: truncate(body.trim(), 600),
        has_supporting_files,
    })
}

// ---- Agents --------------------------------------------------------------

fn scan_agents(agents_dir: &Path, scope: &str, out: &mut Vec<Agent>, warnings: &mut Vec<String>) {
    if !agents_dir.exists() {
        return;
    }
    let walker = WalkDir::new(agents_dir).max_depth(2);
    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        match parse_agent(path, scope) {
            Ok(a) => out.push(a),
            Err(e) => warnings.push(format!("Agent parse failed for {}: {e}", path.display())),
        }
    }
}

fn parse_agent(path: &Path, scope: &str) -> Result<Agent> {
    let content = fs::read_to_string(path)?;
    let (frontmatter, body) = split_frontmatter(&content);
    let yaml: serde_yaml::Value = if frontmatter.is_empty() {
        serde_yaml::Value::Null
    } else {
        serde_yaml::from_str(&frontmatter).unwrap_or(serde_yaml::Value::Null)
    };

    let name = yaml
        .get("name")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            path.file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_else(|| "unnamed".into())
        });

    Ok(Agent {
        name,
        description: yaml.get("description").and_then(|v| v.as_str()).map(String::from),
        model: yaml.get("model").and_then(|v| v.as_str()).map(String::from),
        tools: yaml
            .get("tools")
            .and_then(|v| v.as_str())
            .map(|s| s.split(',').map(|x| x.trim().to_string()).collect())
            .unwrap_or_default(),
        scope: scope.to_string(),
        path: path.to_string_lossy().into_owned(),
        body_preview: truncate(body.trim(), 400),
    })
}

// ---- Slash commands ------------------------------------------------------

fn scan_commands(cmds_dir: &Path, scope: &str, out: &mut Vec<SlashCommand>, _warnings: &mut Vec<String>) {
    if !cmds_dir.exists() {
        return;
    }
    let walker = WalkDir::new(cmds_dir).max_depth(2);
    for entry in walker.into_iter().filter_map(|e| e.ok()) {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let name = path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
        let body = fs::read_to_string(path).unwrap_or_default();
        let (_, b) = split_frontmatter(&body);
        out.push(SlashCommand {
            name,
            scope: scope.to_string(),
            path: path.to_string_lossy().into_owned(),
            body_preview: truncate(b.trim(), 400),
        });
    }
}

// ---- MCP & Hooks ---------------------------------------------------------

fn extract_mcp_from_settings(
    raw: &serde_json::Value,
    scope: &str,
    source: &str,
    out: &mut Vec<McpServer>,
) {
    let servers = raw.get("mcpServers").and_then(|v| v.as_object());
    if let Some(map) = servers {
        for (name, val) in map {
            out.push(McpServer {
                name: name.clone(),
                source: source.to_string(),
                scope: scope.to_string(),
                transport: val
                    .get("transport")
                    .and_then(|v| v.as_str())
                    .map(String::from)
                    .or_else(|| if val.get("url").is_some() { Some("http".into()) } else { Some("stdio".into()) }),
                command: val.get("command").and_then(|v| v.as_str()).map(String::from),
                url: val.get("url").and_then(|v| v.as_str()).map(String::from),
                raw: val.clone(),
            });
        }
    }
}

fn extract_hooks_from_settings(
    raw: &serde_json::Value,
    scope: &str,
    source: &str,
    out: &mut Vec<Hook>,
) {
    let hooks_obj = match raw.get("hooks").and_then(|v| v.as_object()) {
        Some(h) => h,
        None => return,
    };
    for (event, entries) in hooks_obj {
        if let Some(arr) = entries.as_array() {
            for entry in arr {
                let matcher = entry.get("matcher").and_then(|v| v.as_str()).map(String::from);
                if let Some(hooks_arr) = entry.get("hooks").and_then(|v| v.as_array()) {
                    for h in hooks_arr {
                        out.push(Hook {
                            event: event.clone(),
                            matcher: matcher.clone(),
                            command: h.get("command").and_then(|v| v.as_str()).map(String::from),
                            scope: scope.to_string(),
                            source: source.to_string(),
                        });
                    }
                } else {
                    out.push(Hook {
                        event: event.clone(),
                        matcher: matcher.clone(),
                        command: entry.get("command").and_then(|v| v.as_str()).map(String::from),
                        scope: scope.to_string(),
                        source: source.to_string(),
                    });
                }
            }
        }
    }
}

// ---- Projects ------------------------------------------------------------

fn scan_projects(
    claude_dir: Option<&Path>,
    skills: &mut Vec<Skill>,
    agents: &mut Vec<Agent>,
    commands: &mut Vec<SlashCommand>,
    mcp_servers: &mut Vec<McpServer>,
    hooks: &mut Vec<Hook>,
    warnings: &mut Vec<String>,
) -> Vec<Project> {
    let mut projects = Vec::new();
    let Some(dir) = claude_dir else { return projects };
    let projects_dir = dir.join("projects");
    if !projects_dir.exists() {
        return projects;
    }

    let entries = match fs::read_dir(&projects_dir) {
        Ok(e) => e,
        Err(e) => {
            warnings.push(format!("Could not read {}: {e}", projects_dir.display()));
            return projects;
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let name = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| "?".into());

        // Project directory names encode the absolute path: -Users-name-repos-foo
        let (decoded_path, path_exists_on_disk) = resolve_project_path(&name);
        if !path_exists_on_disk {
            warnings.push(format!(
                "Project path could not be resolved on disk: {} (decoded from {}). \
                 Path may contain dashes in directory names.",
                decoded_path, name
            ));
        }

        // Count session transcripts (.jsonl files) and find last modified
        let mut session_count = 0;
        let mut last_modified: Option<DateTime<Utc>> = None;
        if let Ok(files) = fs::read_dir(&path) {
            for f in files.flatten() {
                let p = f.path();
                if p.extension().and_then(|e| e.to_str()) == Some("jsonl") {
                    session_count += 1;
                    if let Ok(meta) = f.metadata() {
                        if let Ok(modified) = meta.modified() {
                            let dt: DateTime<Utc> = modified.into();
                            last_modified = Some(last_modified.map_or(dt, |x| x.max(dt)));
                        }
                    }
                }
            }
        }

        // If we can resolve the real project path on disk, look for .claude/ files there too
        let real_path = PathBuf::from(&decoded_path);
        let (has_claude_md, claude_md_preview, has_settings, settings_path) = if path_exists_on_disk {
            let proj_claude = real_path.join(".claude");
            let md = real_path.join("CLAUDE.md");
            let md_preview = if md.exists() {
                fs::read_to_string(&md).ok().map(|s| truncate(&s, 600))
            } else {
                None
            };
            let s = proj_claude.join("settings.json");
            let s_path = if s.exists() { Some(s.to_string_lossy().into_owned()) } else { None };

            // Pull project-scoped skills/agents/commands too
            scan_skills(&proj_claude.join("skills"), &decoded_path, skills, warnings);
            scan_agents(&proj_claude.join("agents"), &decoded_path, agents, warnings);
            scan_commands(&proj_claude.join("commands"), &decoded_path, commands, warnings);

            // Project settings -> MCP + hooks
            if let Some(ref sp) = s_path {
                if let Ok(text) = fs::read_to_string(sp) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        extract_mcp_from_settings(&v, &decoded_path, sp, mcp_servers);
                        extract_hooks_from_settings(&v, &decoded_path, sp, hooks);
                    }
                }
            }
            // .mcp.json at project root
            let proj_mcp = real_path.join(".mcp.json");
            if proj_mcp.exists() {
                if let Ok(text) = fs::read_to_string(&proj_mcp) {
                    if let Ok(v) = serde_json::from_str::<serde_json::Value>(&text) {
                        extract_mcp_from_settings(&v, &decoded_path, &proj_mcp.to_string_lossy(), mcp_servers);
                    }
                }
            }

            (md.exists(), md_preview, s.exists(), s_path)
        } else {
            (false, None, false, None)
        };

        let display_name = real_path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| decoded_path.clone());

        projects.push(Project {
            path: decoded_path,
            name: display_name,
            session_count,
            last_modified,
            has_claude_md,
            has_settings,
            claude_md_preview,
            settings_path,
        });
    }

    projects.sort_by(|a, b| b.last_modified.cmp(&a.last_modified));
    projects
}

/// Project directories in ~/.claude/projects encode the absolute path by
/// replacing `/` with `-`. This converts back heuristically.
///
/// The naive approach (replace all `-` with `/`) works for paths whose
/// directory components contain no dashes. For paths like `/Users/jane/my-project`,
/// we first try the naive decode; if that path exists we're done. If not, we
/// return the naive decode anyway and the caller emits a warning — the project
/// will still appear in the list but without MD/CFG resolution.
fn decode_project_dir(encoded: &str) -> String {
    if !encoded.starts_with('-') {
        return encoded.to_string();
    }
    encoded.replace('-', "/")
}

/// Attempt to resolve a decoded project path. Returns the path string and
/// whether it was confirmed to exist on disk.
fn resolve_project_path(encoded: &str) -> (String, bool) {
    let decoded = decode_project_dir(encoded);
    let exists = PathBuf::from(&decoded).exists();
    (decoded, exists)
}

// ---- helpers -------------------------------------------------------------

fn collect_strings(val: Option<&serde_json::Value>) -> Vec<String> {
    val.and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn split_frontmatter(content: &str) -> (String, String) {
    let trimmed = content.trim_start();
    if !trimmed.starts_with("---") {
        return (String::new(), content.to_string());
    }
    let rest = &trimmed[3..];
    if let Some(end_idx) = rest.find("\n---") {
        let fm = &rest[..end_idx];
        let body_start = end_idx + 4;
        let body = if body_start <= rest.len() { &rest[body_start..] } else { "" };
        (fm.trim_start_matches('\n').to_string(), body.trim_start_matches('\n').to_string())
    } else {
        (String::new(), content.to_string())
    }
}

fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let cutoff: String = s.chars().take(max).collect();
        format!("{cutoff}…")
    }
}
