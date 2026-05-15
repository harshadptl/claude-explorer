# Code Walkthrough — Claude Explorer

A developer guide for understanding the codebase and wiring the mockup UI to real `.claude` data.

---

## Architecture Overview

Claude Explorer is a Tauri v2 desktop app. The stack is:

```
Frontend (Vite + vanilla JS/HTML/CSS)
        |
        | window.__TAURI__.core.invoke('scan' | 'read_text_file' | 'write_settings' | 'open_in_editor')
        |
Tauri bridge (IPC)
        |
Rust backend (src-tauri/src/)
  ├── main.rs       — Tauri entry point + command registration + plugin init
  └── scanner.rs    — filesystem walker, returns Snapshot struct
```

The frontend never touches the filesystem directly. All read data comes from a single `scan` IPC call that returns a serialized `Snapshot` JSON object. Writes (permissions editing) go through `write_settings`. File display in modals uses `read_text_file`. Opening files in an external editor uses `open_in_editor`.

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
    ├── Cargo.toml            # Rust deps: tauri, serde, serde_json, serde_yaml, dirs, walkdir, chrono, anyhow
    ├── tauri.conf.json       # window config, CSP, build hooks
    ├── build.rs              # standard tauri build script
    └── src/
        ├── main.rs           # registers 4 commands, inits shell + dialog plugins
        └── scanner.rs        # all filesystem logic, all data types
```

---

## Data Flow: End-to-End

### 1. App starts → `loadData()` is called

`src/main.js:35` — `loadData()` runs immediately on page load and again on every Rescan click. While scanning, the Rescan button is disabled and shows "Scanning…".

```js
// main.js:40-44
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

`src-tauri/src/main.rs:8-11` — the `scan` command simply delegates to `scanner::scan_all()`:

```rust
#[tauri::command]
fn scan() -> Result<Snapshot, String> {
    scanner::scan_all().map_err(|e| e.to_string())
}
```

### 3. `scanner::scan_all()` builds the Snapshot

`scanner.rs:110-173` — the top-level scan function. It:

1. Resolves the config dir: checks `CLAUDE_CONFIG_DIR` env var first, falls back to `~/.claude` via `dirs::home_dir()`
2. Records `claude_config_dir_override` on the snapshot if the env var is set, and adds a warning
3. Calls `scan_global()` to parse `settings.json`, `CLAUDE.md`, `~/.claude.json`
4. Calls `scan_skills / scan_agents / scan_commands` on `~/.claude/skills`, `agents`, `commands`
5. Extracts MCP servers and hooks from the parsed `settings_raw` JSON
6. Calls `scan_projects()` which also recurses into each project's `.claude/` folder

### 4. Snapshot is serialized and returned to JS

All structs derive `serde::Serialize`. Tauri auto-serializes the return value to JSON. The JS receives a plain object matching the `Snapshot` type definition (see below).

### 5. Frontend renders

`main.js:71-92` — `render()` dispatches to one of 7 view renderers based on `state.view`. If the Projects tab is active and `state.selectedProject` is set, it renders `renderProjectDetail()` instead. After injecting HTML into `#content`, it calls the appropriate event-wiring functions.

---

## The Snapshot Data Shape

This is the contract between Rust and JS. Every renderer reads from this object.

```typescript
// TypeScript equivalent of scanner.rs structs

interface Snapshot {
  scanned_at: string;                   // ISO datetime
  home_dir: string | null;
  claude_dir: string | null;            // e.g. "/Users/you/.claude"
  claude_dir_exists: boolean;
  claude_config_dir_override: string | null;  // set if CLAUDE_CONFIG_DIR env var is present
  global: GlobalConfig;
  skills: Skill[];
  agents: Agent[];
  commands: SlashCommand[];
  mcp_servers: McpServer[];
  hooks: Hook[];
  projects: Project[];                  // sorted by last_modified desc
  warnings: string[];
}

interface GlobalConfig {
  settings_path: string | null;
  settings_raw: object | null;  // raw parsed settings.json (used for write-back)
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

## Tauri Commands (main.rs)

Four commands are registered:

| Command | Direction | Purpose |
|---|---|---|
| `scan` | Rust → JS | Full filesystem scan; returns `Snapshot` |
| `read_text_file(path)` | Rust → JS | Read any file as UTF-8 string |
| `write_settings(path, content)` | JS → Rust | Overwrite a settings.json file |
| `open_in_editor(path)` | JS → Rust | Open file in system default app via `tauri_plugin_shell` |

Two plugins are initialized: `tauri_plugin_shell` (for `open_in_editor`) and `tauri_plugin_dialog` (available for future use).

---

## App State (main.js)

```js
const state = {
  data: null,           // current Snapshot
  view: 'overview',     // active tab
  filters: {},          // per-tab filter strings, keyed by view name
  selectedProject: null, // absolute path of drill-down project, or null
};
```

`state.filters` is populated by `<input class="filter-input" data-filter-view="…">` elements. `attachModalHandlers()` wires these inputs — on each keystroke, the filter is saved to `state.filters[viewName]` and `render()` is called to re-filter.

---

## View Renderers (main.js)

Each renderer is a pure function `(data: Snapshot) => string` (HTML string).

| Function | Tab | Key data fields consumed |
|---|---|---|
| `renderOverview(d)` | Overview | `d.skills`, `d.agents`, `d.commands`, `d.mcp_servers`, `d.hooks`, `d.projects`, `d.global.model`, `d.global.permissions`, `d.warnings` |
| `renderConfig(d)` | Config | `d.global` (all fields) |
| `renderSkills(d)` | Skills | `d.skills[]`, `state.filters['skills']` |
| `renderProjects(d)` | Projects | `d.projects[]`, `state.filters['projects']` |
| `renderPermissions(d)` | Permissions | `d.global.permissions`, `d.global.settings_path` |
| `renderMcp(d)` | MCP & Hooks | `d.mcp_servers[]`, `d.hooks[]` |
| `renderAgentsAndCommands(d)` | Agents & Commands | `d.agents[]`, `d.commands[]`, `state.filters['agents']` |
| `renderProjectDetail(d, path)` | Projects (drill-down) | single `Project` + all scoped skills/agents/commands/MCP/hooks |

### Filter inputs

Skills, Projects, and Agents & Commands tabs include a live filter input. The filter string is stored in `state.filters[viewName]` and applied before rendering the list. Focus is restored to the input after each re-render.

### Modal pattern (cards)

Any element with class `clickable` gets a click handler. Data is passed via `data-modal-*` attributes:

```html
<div class="card clickable"
     data-modal-title="skill-name"
     data-modal-path="/path/to/SKILL.md"
     data-modal-body="first 600 chars of body">
```

`attachModalHandlers()` (`main.js:606`) wires these after every render. `openModal()` creates/reuses a single `.modal-overlay` DOM node.

**Full file loading:** When running inside Tauri, `openModal()` immediately calls `invoke('read_text_file', { path })` and replaces the `body_preview` placeholder with the full file content once it loads. The modal also shows an "Open in editor" button that calls `invoke('open_in_editor', { path })`.

### Project drill-down

Clicking a project row sets `state.selectedProject` to the project's absolute path and calls `render()`. `render()` detects this and calls `renderProjectDetail()` instead of `renderProjects()`.

`renderProjectDetail()` (`main.js:511`) renders:
- Back button (clears `state.selectedProject`)
- Project name, path, session count
- CLAUDE.md preview (full content loaded async via `read_text_file`)
- settings.json (loaded async, syntax-highlighted via `highlightJson()`)
- Project-scoped skills, agents, slash commands, MCP servers, hooks (filtered from the global snapshot by `scope === projectPath`)

`attachProjectDetailHandlers()` (`main.js:477`) wires the back button and triggers the async file loads.

---

## Permissions Editor

The Permissions tab is the only view that writes back to disk.

`renderPermissions(d)` (`main.js:270`) checks `canEdit = !!(invoke && d.global.settings_path)`. If true, each rule gets a `×` delete button and each column gets an "+ Add rule" button.

`attachPermissionHandlers()` (`main.js:410`) wires:
- **Delete:** removes the rule at `data-perm-index` from `state.data.global.permissions[type]` and calls `savePermissions()`
- **Add:** replaces the "+ Add rule" button with an inline input form; on Save calls `savePermissions()`

`savePermissions(newPerms)` (`main.js:453`):
1. Deep-clones `settings_raw`
2. Patches `permissions.allow/deny/ask` in place
3. Calls `invoke('write_settings', { path, content: JSON.stringify(updated, null, 2) })`
4. Calls `loadData()` to rescan and re-render with the saved state

---

## Rust Scanner Deep Dive

### `scan_global()` — `scanner.rs:177`

Reads `~/.claude/settings.json` and extracts:
- `model`, `theme` — top-level string fields
- `env` — entire env block passed through as raw JSON
- `permissions.allow/deny/ask` — collected as `Vec<String>` via `collect_strings()`
- `settings_raw` — full parsed JSON (used for raw display, MCP/hooks extraction, and write-back)
- `CLAUDE.md` — read if present, truncated to 800 chars
- `~/.claude.json` — path + size only (never parsed, can be 100 MB+)

### `parse_skill()` / `parse_agent()` — `scanner.rs:267, 335`

Both use `split_frontmatter()` to separate YAML frontmatter (between `---` delimiters) from the body. YAML is parsed with `serde_yaml`. Fields come from frontmatter; `name` falls back to directory/filename.

`split_frontmatter()` at `scanner.rs:624`:
- Looks for opening `---` at start of file
- Finds closing `\n---` to delimit the frontmatter block
- Returns `(frontmatter_str, body_str)` tuple

### `extract_mcp_from_settings()` — `scanner.rs:398`

Reads `settings.json → mcpServers` object. Each key is a server name. Transport is inferred: if a `transport` field exists it is used directly; if `url` is present → `"http"`, otherwise → `"stdio"`.

### `extract_hooks_from_settings()` — `scanner.rs:424`

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

### `scan_projects()` — `scanner.rs:464`

- Reads `~/.claude/projects/` directory
- Each subdirectory name is an encoded project path (slashes replaced with dashes)
- `decode_project_dir()` (`scanner.rs:597`) reverses this: leading `-` means it's an encoded path; does a simple `-` → `/` replacement
- `resolve_project_path()` (`scanner.rs:606`) wraps the decoder and also checks whether the decoded path actually exists on disk
- If the path doesn't exist, a warning is emitted (dash-in-dirname ambiguity); the project still appears in the list but without MD/CFG resolution
- Counts `.jsonl` files = session count, takes newest mtime
- If decoded path exists on disk, reads `CLAUDE.md`, `.claude/settings.json`, and recurses into `.claude/` for project-scoped skills/agents/commands/MCP/hooks; also checks `.mcp.json` at project root
- Results are sorted by `last_modified` descending before returning

**Known limitation** (`decode_project_dir`, `scanner.rs:597-601`): The decode is a simple `-` → `/` replacement. Paths with dashes in directory names (e.g. `/Users/you/my-project`) decode incorrectly. This is noted in README.md.

---

## Chrome: Footer and Header

`updateChrome()` (`main.js:56`) runs after every scan:
- Sets the scanned-at timestamp pill to `HH:MM`
- Footer path shows `claude_dir`; if `claude_config_dir_override` is set, appends `(CLAUDE_CONFIG_DIR)` to signal the non-default location
- Footer warnings count shows total `warnings.length`

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

`main.js:731` — `mockData()` returns a hardcoded `Snapshot`. It mirrors the real data shape exactly, including the `claude_config_dir_override: null` field. When iterating on UI without running the Tauri shell, run `npm run dev` and the app renders against this fixture.

To update the mock, edit `mockData()` directly. The shape must match the `Snapshot` interface above.

---

## Dev Commands

```bash
npm install          # install JS deps
npm run dev          # frontend-only, mock data, http://localhost:5173
npm run tauri:dev    # full app with hot reload (requires Rust toolchain)
npm run tauri:build  # production binary → src-tauri/target/release/bundle/
```
