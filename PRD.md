# PRD — Claude Explorer

**Status:** Mockup complete, backend scanner implemented, frontend is read-only
**Goal:** Wire the UX to real `.claude` data, add write/edit capabilities, and ship a useful desktop tool for Claude Code power users

---

## Problem

Claude Code stores a growing amount of configuration on disk — skills, agents, slash commands, MCP servers, hooks, permissions, CLAUDE.md files — spread across `~/.claude/` and per-project `.claude/` directories. There is no visual interface to see, audit, or manage any of it. Power users either know the file locations by heart or discover them by accident.

---

## Users

- **Primary:** Developers who use Claude Code heavily across multiple projects and have accumulated many skills, agents, and custom configs
- **Secondary:** Teams wanting to audit what Claude Code permissions and hooks are active before running in sensitive codebases

---

## What Exists Today (the mockup)

The mockup is a fully designed, fully styled read-only viewer. The Rust scanner is complete and returns real data. The frontend renders it correctly. What the mockup does **not** have:

1. Full file content in modals (only truncated previews)
2. Any write/edit capability
3. Search or filtering across lists
4. Per-project drill-down view
5. `CLAUDE_CONFIG_DIR` env var support
6. Correct handling of project directory names that contain dashes

---

## Features to Build

### P0 — Must have for v1

#### F1: Full file view in modals

**Current state:** Modal shows `body_preview` (600 char truncate) from the Snapshot.
**Target:** Clicking a skill/agent/command card loads and shows the full file.

**How to wire it:**
- The `read_text_file(path: String)` Tauri command is already registered in `main.rs:14`
- In `attachModalHandlers()` (`main.js:361`), when a `.clickable` is clicked, call:
  ```js
  const full = await invoke('read_text_file', { path: card.dataset.modalPath });
  ```
- Replace the `<pre>` content in `openModal()` with the full text
- Show a loading state (`"Loading…"`) while the async read completes
- Handle the error case (file deleted since last scan)

#### F2: Rescan reflects current disk state

**Current state:** Rescan button calls `loadData()` which re-invokes `scan`. This already works correctly.
**Gap:** There is no feedback that a rescan is in progress vs complete beyond the loading spinner in `#content`.

**How to wire it:**
- Disable the `#rescan` button and change its label while `loadData()` is running
- Re-enable and update `#scanned-at` pill when complete (`updateChrome()` already does this, just needs the button state wired)

#### F3: `CLAUDE_CONFIG_DIR` support

**Current state:** Scanner always uses `~/.claude`. Claude Code itself respects the `CLAUDE_CONFIG_DIR` env var.
**Target:** If `CLAUDE_CONFIG_DIR` is set, use it instead.

**How to wire it:**
In `scanner.rs`, `scan_global()` and `scan_all()`, replace:
```rust
let claude_dir = home.as_ref().map(|h| h.join(".claude"));
```
with:
```rust
let claude_dir = std::env::var("CLAUDE_CONFIG_DIR")
    .ok()
    .map(PathBuf::from)
    .or_else(|| home.as_ref().map(|h| h.join(".claude")));
```
Add a warning to the snapshot if `CLAUDE_CONFIG_DIR` is set, so the UI can show which directory is active.

#### F4: Fix project path decode for hyphenated directory names

**Current state:** `decode_project_dir()` (`scanner.rs:576`) replaces all `-` with `/`. A project at `/Users/jane/my-project` becomes `/Users/jane/my/project` — incorrect.

**Target:** Correctly decode project directory names.

**How to wire it:**
Claude Code encodes project paths by replacing `/` with `-`. The first character of the encoded name is always `-` (since all absolute paths start with `/`). The decode needs to be smarter: only replace `-` that correspond to path separators, not word-separators in dir names.

The reliable approach is to attempt the naive decode, check if the resulting path exists, and if not, use a scored walk — try replacing each `-` combination from left to right, stopping at the first real path that exists on disk. Alternatively, store the real path in a sidecar file in each project directory during first use (requires a write operation).

For v1, a practical fix: after the naive decode, if the path doesn't exist, scan the projects directory and try to match by checking all existing `~/.claude/projects/` dirs against paths that actually exist on disk. Surface a warning when a project path can't be resolved.

---

### P1 — High value, ship in v1.1

#### F5: Search / filter

Every list view (skills, projects, agents, commands) should have a text filter input that narrows the list in real-time. No backend change needed — filter against `state.data` in JS before rendering.

**Implementation sketch:**
- Add a `<input class="filter-input">` at the top of each list view
- Store filter state per-view in `state.filters[viewName]`
- Re-render only the list content (not the whole view) on input

#### F6: Per-project drill-down

**Current state:** Projects tab shows a flat list. Clicking opens a modal with CLAUDE.md preview only.
**Target:** A project detail view showing: CLAUDE.md (full), settings.json (formatted), and all project-scoped skills/agents/commands/MCP/hooks filtered to that project.

**How to wire it:**
- Add a `state.selectedProject` field
- When a project row is clicked, set `state.selectedProject = project.path` and re-render
- In the renderer, filter all `d.skills/agents/commands/mcp_servers/hooks` where `scope === project.path`
- Add a back button that clears `state.selectedProject`

This requires no new Tauri commands — all the project-scoped data is already in the Snapshot with `scope` set to the project path.

#### F7: Settings editor (allow/deny/ask)

Let users add and remove permission rules directly from the Permissions tab.

**How to wire it:**

Backend — add a new Tauri command in `main.rs`:
```rust
#[tauri::command]
fn write_settings(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, &content).map_err(|e| e.to_string())
}
```

Frontend — in `renderPermissions()`:
- Add `[+ Allow]` / `[+ Deny]` / `[+ Ask]` buttons per column
- On click, show an inline input for the rule pattern (e.g. `Bash(npm:*)`)
- On confirm: read `state.data.global.settings_raw`, modify `permissions`, re-serialize, call `invoke('write_settings', { path, content })`
- Trigger `loadData()` to re-scan and confirm the write

**Safety:** Before writing, show the diff. Never overwrite without user confirmation. Preserve unknown keys in settings.json.

#### F8: Open file in editor

Add an "Open in editor" button to modals (skills, agents, commands, project CLAUDE.md).

**How to wire it:**
Use the `tauri-plugin-shell` (already in `Cargo.toml`):
```rust
#[tauri::command]
async fn open_in_editor(app: tauri::AppHandle, path: String) -> Result<(), String> {
    tauri_plugin_shell::open(&app.shell(), path, None)
        .map_err(|e| e.to_string())
}
```
This uses the OS default handler for `.md` files. Wire a button in `openModal()` that calls `invoke('open_in_editor', { path })`.

---

### P2 — Nice to have

#### F9: Session transcript viewer

Each project accumulates `.jsonl` session transcripts in `~/.claude/projects/<encoded-path>/`. These contain the full conversation history. A basic viewer could show:
- List of sessions by date/time
- Each session as a conversation thread (assistant/user turns)

Requires a new scanner function to parse JSONL and a new view renderer. The JSONL schema matches the Claude API message format.

#### F10: Hook tester

From the MCP & Hooks tab, add a "Dry run" button that shows what would happen if a given hook fired, without actually executing the shell command. This is UI-only — just show the command that would run and its configured matcher.

#### F11: Export / copy config

A button on the Config tab to copy the current `settings.json` as formatted JSON to the clipboard, or export it to a file. Useful for sharing configs across machines.

---

## Non-goals

- Claude Explorer will never send data to any external server
- It will not manage Claude Code sessions or start/stop Claude processes
- It will not modify JSONL session transcripts
- It will not handle multi-user or team config syncing

---

## Technical Constraints

- **Read-only by default** — all write operations are opt-in and require explicit confirmation
- **No external network** — the app operates entirely offline
- **Tauri v2 API** — `invoke` is at `window.__TAURI__.core.invoke`, not `window.__TAURI__.invoke`
- **Settings.json is the write target** — only `~/.claude/settings.json` and project `.claude/settings.json` are candidates for writes; SKILL.md / agent .md files are edited by opening in an external editor (F8)
- **serde_yaml 0.9** is already in Cargo.toml; frontmatter parsing already works for `name`, `description`, `model`, `tools`, `allowed-tools` fields

---

## File Locations Reference (for scanner wiring)

| What | Real path | Where scanner reads it |
|---|---|---|
| Global settings | `~/.claude/settings.json` | `scan_global()` |
| User memory | `~/.claude/CLAUDE.md` | `scan_global()` |
| Legacy auth/prefs | `~/.claude.json` | `scan_global()` (size only) |
| User skills | `~/.claude/skills/*/SKILL.md` | `scan_skills(..., "user", ...)` |
| User agents | `~/.claude/agents/*.md` | `scan_agents(..., "user", ...)` |
| User slash cmds | `~/.claude/commands/*.md` | `scan_commands(..., "user", ...)` |
| MCP servers | `settings.json → mcpServers` | `extract_mcp_from_settings()` |
| Hooks | `settings.json → hooks` | `extract_hooks_from_settings()` |
| Projects index | `~/.claude/projects/` | `scan_projects()` |
| Session files | `~/.claude/projects/<enc>/*.jsonl` | `scan_projects()` (count only) |
| Project CLAUDE.md | `<project>/.claude/../CLAUDE.md` | `scan_projects()` |
| Project settings | `<project>/.claude/settings.json` | `scan_projects()` |
| Project MCP | `<project>/.mcp.json` | `scan_projects()` |
| Project skills | `<project>/.claude/skills/` | `scan_projects() → scan_skills()` |
| Project agents | `<project>/.claude/agents/` | `scan_projects() → scan_agents()` |
| Project commands | `<project>/.claude/commands/` | `scan_projects() → scan_commands()` |

---

## Acceptance Criteria for v1

- [ ] Clicking any card shows the full file content (not truncated)
- [ ] `CLAUDE_CONFIG_DIR` is respected when set
- [ ] Project list correctly identifies projects even when project directory names contain dashes
- [ ] Rescan button is visually disabled while a scan is in progress
- [ ] App renders without errors when `~/.claude` does not exist (empty state shown)
- [ ] All mock data values in `mockData()` match the real Snapshot types exactly
- [ ] No writes happen without an explicit user action and a visible confirmation
