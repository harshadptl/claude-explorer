# Code Walkthrough — Claude Explorer

A developer guide for understanding the codebase and wiring the mockup UI to real `.claude` data.

---

## Architecture Overview

Claude Explorer is a Tauri v2 desktop app. The stack is:

```
Frontend (Vite + vanilla JS/HTML/CSS)
        |
        | window.__TAURI__.core.invoke('scan')
        |
Tauri bridge (IPC)
        |
Rust backend (src-tauri/src/)
  ├── main.rs       — Tauri entry point + command registration
  └── scanner.rs    — filesystem walker, returns Snapshot struct
```

The frontend never touches the filesystem directly. All data comes from a single `scan` IPC call that returns a serialized `Snapshot` JSON object. The frontend is a pure read-only view over that snapshot.

---

## Directory Structure

```
claude-explorer/
├── package.json              # npm scripts; deps: @tauri-apps/api, vite
├── vite.config.js            # minimal vite config
├── src/                      # frontend
│   ├── index.html            # shell HTML, tab bar, header, footer
│   ├── style.css             # full design system (tokens, all components)
│   └── main.js               # all JS: data loading, routing, rendering
└── src-tauri/
    ├── Cargo.toml            # Rust deps: tauri, serde, serde_yaml, dirs, walkdir, chrono, anyhow
    ├── tauri.conf.json       # window config, CSP, build hooks
    ├── build.rs              # standard tauri build script
    └── src/
        ├── main.rs           # registers `scan` and `read_text_file` commands
        └── scanner.rs        # all filesystem logic, all data types
```

---

## Data Flow: End-to-End

### 1. App starts → `loadData()` is called

`src/main.js:30` — `loadData()` runs immediately on page load and again on every Rescan click.

```js
// main.js:35-43
if (invoke) {
  state.data = await invoke('scan');   // inside Tauri → real data
} else {
  state.data = mockData();             // plain browser → mock data
}
```

The `invoke` bridge is detected at `main.js:3`:
```js
const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke;
```
If `window.__TAURI__` is absent (plain `vite dev`), `invoke` is `undefined` and the app falls back to `mockData()`.

### 2. Rust `scan` command executes

`src-tauri/src/main.rs:9-11` — the `scan` command simply delegates to `scanner::scan_all()`:

```rust
#[tauri::command]
fn scan() -> Result<Snapshot, String> {
    scanner::scan_all().map_err(|e| e.to_string())
}
```

### 3. `scanner::scan_all()` builds the Snapshot

`scanner.rs:109-164` — the top-level scan function. It:

1. Resolves `~/.claude` via the `dirs` crate (`dirs::home_dir()`)
2. Calls `scan_global()` to parse `settings.json`, `CLAUDE.md`, `~/.claude.json`
3. Calls `scan_skills / scan_agents / scan_commands` on `~/.claude/skills`, `agents`, `commands`
4. Extracts MCP servers and hooks from the parsed `settings_raw` JSON
5. Calls `scan_projects()` which also recurses into each project's `.claude/` folder

### 4. Snapshot is serialized and returned to JS

All structs derive `serde::Serialize`. Tauri auto-serializes the return value to JSON. The JS receives a plain object that matches the `Snapshot` type definition (see below).

### 5. Frontend renders

`main.js:60-73` — `render()` dispatches to one of 7 view renderers based on `state.view`, injects the result as `innerHTML` into `#content`, then calls `attachModalHandlers()` to wire click events.

---

## The Snapshot Data Shape

This is the contract between Rust and JS. Every renderer reads from this object.

```typescript
// TypeScript equivalent of scanner.rs structs

interface Snapshot {
  scanned_at: string;           // ISO datetime
  home_dir: string | null;
  claude_dir: string | null;    // e.g. "/Users/you/.claude"
  claude_dir_exists: boolean;
  global: GlobalConfig;
  skills: Skill[];
  agents: Agent[];
  commands: SlashCommand[];
  mcp_servers: McpServer[];
  hooks: Hook[];
  projects: Project[];
  warnings: string[];
}

interface GlobalConfig {
  settings_path: string | null;
  settings_raw: object | null;  // raw parsed settings.json
  model: string | null;
  theme: string | null;
  env: object | null;           // settings.json "env" block
  permissions: {
    allow: string[];
    deny: string[];
    ask: string[];
  };
  legacy_claude_json_path: string | null;
  legacy_claude_json_size_bytes: number | null;
  user_claude_md_path: string | null;
  user_claude_md_preview: string | null;  // first 800 chars
}

interface Skill {
  name: string;
  description: string | null;
  scope: string;                // "user" OR absolute project path
  path: string;                 // full path to SKILL.md
  allowed_tools: string[];      // from "allowed-tools" frontmatter
  body_preview: string;         // first 600 chars of body
  has_supporting_files: boolean;
}

interface Agent {
  name: string;
  description: string | null;
  model: string | null;
  tools: string[];
  scope: string;                // "user" OR project path
  path: string;
  body_preview: string;         // first 400 chars
}

interface SlashCommand {
  name: string;                 // filename without .md
  scope: string;
  path: string;
  body_preview: string;
}

interface McpServer {
  name: string;
  source: string;               // settings.json file it came from
  scope: string;                // "user" OR project path
  transport: string | null;     // "stdio" | "http" | "sse"
  command: string | null;       // for stdio servers
  url: string | null;           // for http/sse servers
  raw: object;                  // full original JSON block
}

interface Hook {
  event: string;                // "PreToolUse" | "PostToolUse" | etc.
  matcher: string | null;       // tool name glob
  command: string | null;       // shell command to run
  scope: string;
  source: string;               // settings.json file it came from
}

interface Project {
  path: string;                 // decoded absolute path
  name: string;                 // last path component
  session_count: number;        // count of .jsonl files
  last_modified: string | null; // ISO datetime of newest .jsonl
  has_claude_md: boolean;
  has_settings: boolean;
  claude_md_preview: string | null;
  settings_path: string | null;
}
```

---

## View Renderers (main.js)

Each renderer is a pure function `(data: Snapshot) => string` (HTML string).

| Function | Tab | Key data fields consumed |
|---|---|---|
| `renderOverview(d)` | Overview | `d.skills`, `d.agents`, `d.commands`, `d.mcp_servers`, `d.hooks`, `d.projects`, `d.global.model`, `d.global.permissions`, `d.warnings` |
| `renderConfig(d)` | Config | `d.global` (all fields) |
| `renderSkills(d)` | Skills | `d.skills[]` |
| `renderProjects(d)` | Projects | `d.projects[]` |
| `renderPermissions(d)` | Permissions | `d.global.permissions` |
| `renderMcp(d)` | MCP & Hooks | `d.mcp_servers[]`, `d.hooks[]` |
| `renderAgentsAndCommands(d)` | Agents & Commands | `d.agents[]`, `d.commands[]` |

### Modal pattern (cards/projects)

Any element with class `clickable` gets a click handler. Data is passed via `data-modal-*` attributes:

```html
<div class="card clickable"
     data-modal-title="skill-name"
     data-modal-path="/path/to/SKILL.md"
     data-modal-body="first 600 chars of body">
```

`attachModalHandlers()` (main.js:361) wires these after every render. `openModal()` creates/reuses a single `.modal-overlay` DOM node.

**Limitation:** The modal only shows `body_preview` (truncated). To show the full file, you'd call `invoke('read_text_file', { path })` — the command is already registered in `main.rs:14-16`.

---

## Rust Scanner Deep Dive

### `scan_global()` — `scanner.rs:168`

Reads `~/.claude/settings.json` and extracts:
- `model`, `theme` — top-level string fields
- `env` — entire env block passed through as raw JSON
- `permissions.allow/deny/ask` — collected as `Vec<String>` via `collect_strings()`
- `settings_raw` — full parsed JSON (used for raw display and MCP/hooks extraction)
- `CLAUDE.md` — read if present, truncated to 800 chars
- `~/.claude.json` — path + size only (never parsed, can be 100MB+)

### `parse_skill()` / `parse_agent()` — `scanner.rs:258, 326`

Both use `split_frontmatter()` to separate YAML frontmatter (between `---` delimiters) from the body. YAML is parsed with `serde_yaml`. Fields come from frontmatter; `name` falls back to directory/filename.

`split_frontmatter()` at `scanner.rs:597`:
- Looks for opening `---` at start of file
- Finds closing `\n---` to delimit the frontmatter block
- Returns `(frontmatter_str, body_str)` tuple

### `extract_mcp_from_settings()` — `scanner.rs:389`

Reads `settings.json → mcpServers` object. Each key is a server name. Transport is inferred: if `url` is present → `"http"`, otherwise → `"stdio"`.

### `extract_hooks_from_settings()` — `scanner.rs:415`

Reads `settings.json → hooks` object. The schema Claude Code uses is:
```json
{
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "command": "..." }] }
    ]
  }
}
```
The extractor handles both the nested `hooks: [...]` form and a flat `command` directly on the entry.

### `scan_projects()` — `scanner.rs:455`

- Reads `~/.claude/projects/` directory
- Each subdirectory name is an encoded project path (dashes replace slashes)
- `decode_project_dir()` (`scanner.rs:576`) reverses this: leading `-` means it's an encoded path
- Counts `.jsonl` files = session count, takes newest mtime
- If decoded path exists on disk, reads `CLAUDE.md`, `.claude/settings.json`, and recurses into `.claude/` for project-scoped skills/agents/commands/MCP/hooks
- Also checks for `.mcp.json` at project root

**Known limitation** (`decode_project_dir`, `scanner.rs:576-583`): The decode is a simple `-` → `/` replacement. Paths with dashes in directory names (e.g. `/Users/you/my-project`) decode incorrectly. This is noted in README.md.

---

## The `read_text_file` Command

`main.rs:13-16` — already registered but not yet called from the frontend:

```rust
#[tauri::command]
fn read_text_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| format!("Failed to read {path}: {e}"))
}
```

Call from JS:
```js
const content = await invoke('read_text_file', { path: '/absolute/path/to/file' });
```

This is what you'd use to show full file contents in modals instead of truncated previews.

---

## Design System (style.css)

All design tokens are CSS custom properties on `:root`:

| Token | Value | Usage |
|---|---|---|
| `--bg` | `#14110d` | Page background |
| `--bg-elev` | `#1c1814` | Elevated surfaces (cards, modals) |
| `--ink` | `#efe7d4` | Primary text |
| `--ink-dim` | `#b8ad95` | Secondary text |
| `--ink-faint` | `#6e6353` | Tertiary / labels |
| `--accent` | `#e8b75c` | Gold — skills, project scope, JSON keys |
| `--accent-hot` | `#ff7847` | Orange — deny rules, active tab indicator, close button |
| `--lime` | `#b8e060` | Green — allow rules, user-scope badge |
| `--rose` | `#d4738f` | Pink — model tags, JSON numbers |
| `--serif` | Instrument Serif | Headings, large numbers |
| `--mono` | JetBrains Mono | All body text (the default font) |

Layout is a 4-row CSS grid: `header / tabs / content / footer`.

---

## Mock Data (for UI-only dev)

`main.js:453-501` — `mockData()` returns a hardcoded `Snapshot`. It mirrors the real data shape exactly. When iterating on UI without running the Tauri shell, run `npm run dev` and the app renders against this fixture.

To update the mock, edit `mockData()` directly. The shape must match the `Snapshot` interface above.

---

## Dev Commands

```bash
npm install          # install JS deps
npm run dev          # frontend-only, mock data, http://localhost:5173
npm run tauri:dev    # full app with hot reload (requires Rust toolchain)
npm run tauri:build  # production binary → src-tauri/target/release/bundle/
```
