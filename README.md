# Claude Explorer

A desktop visualizer for everything Claude Code keeps on your machine — skills,
agents, slash commands, MCP servers, hooks, permissions, and every project
you've ever opened a session in.

Built with Tauri (Rust backend + web frontend). Reads from `~/.claude/`,
`~/.claude.json`, and any project `.claude/` directories it can resolve.

## Screenshots / views

- **Overview** — counts and the headline numbers
- **Config** — `~/.claude/settings.json` parsed and raw, env vars, user CLAUDE.md
- **Skills** — every SKILL.md as a card, click for full body
- **Projects** — every directory tracked under `~/.claude/projects/`
- **Permissions** — allow / ask / deny rules side-by-side
- **MCP & Hooks** — every server and every hook with its trigger event
- **Agents & Commands** — subagent personas and slash commands

## Requirements

- **Rust** (stable): https://rustup.rs
- **Node.js** ≥ 18: https://nodejs.org
- On Linux you'll also need the usual Tauri prereqs (webkit2gtk, etc.) — see
  https://v2.tauri.app/start/prerequisites/

## Setup

```bash
cd claude-explorer
npm install
```

The first time you run it, Cargo will download and compile a handful of crates.
That takes a few minutes; subsequent runs are fast.

## Run in dev mode

```bash
npm run tauri:dev
```

Opens the desktop window with hot reload on the frontend. Edits to the Rust
scanner trigger an automatic rebuild.

## Run the frontend alone (with mock data)

If you just want to iterate on the UI without recompiling Rust:

```bash
npm run dev
```

Then open http://localhost:5173 in any browser. Detects it's not running inside
Tauri and falls back to a mock dataset.

## Build a release binary

```bash
npm run tauri:build
```

Produces a platform-native binary in `src-tauri/target/release/bundle/`.

## How the scanner works

The Rust scanner (`src-tauri/src/scanner.rs`) walks:

| Source | What it pulls |
|---|---|
| `~/.claude/settings.json` | model, theme, env, permissions, MCP servers, hooks |
| `~/.claude/CLAUDE.md` | user-level memory preview |
| `~/.claude.json` | path + size only (legacy file, can be huge) |
| `~/.claude/skills/*/SKILL.md` | name, description, allowed-tools, body |
| `~/.claude/agents/*.md` | name, description, model, tools, body |
| `~/.claude/commands/*.md` | name + body |
| `~/.claude/projects/*` | session counts and last-modified per project |
| Each resolved project's `.claude/` | per-project skills, agents, commands, MCP, hooks |
| Each project's `.mcp.json` | project-scoped MCP servers |

Project directories under `~/.claude/projects/` are stored with `/` replaced by
`-`. The scanner decodes that heuristically; if the resolved path doesn't exist
on disk anymore, the project still shows up but without the MD/CFG flags.

Everything is read-only. The app never writes to `~/.claude`.

## Project layout

```
claude-explorer/
├── package.json              # frontend deps + tauri scripts
├── vite.config.js
├── src/                      # frontend
│   ├── index.html
│   ├── style.css             # editorial dark theme
│   └── main.js               # view routing + render
└── src-tauri/
    ├── Cargo.toml
    ├── tauri.conf.json
    ├── build.rs
    └── src/
        ├── main.rs           # Tauri entry, command handlers
        └── scanner.rs        # the filesystem walker
```

## Notes

- Tauri v2 syntax — `npm run tauri:dev`, not `cargo tauri dev`.
- If you set `CLAUDE_CONFIG_DIR`, the scanner doesn't currently honor it. Open
  an issue with yourself and add it to `scan_global()`.
- The icons in `src-tauri/icons/` aren't included — `tauri:build` will complain
  until you `npm run tauri icon path/to/icon.png` to generate them. Dev mode
  works without them.
