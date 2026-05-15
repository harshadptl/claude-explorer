// Tauri exposes `invoke` on window when running inside the desktop shell.
// When running plain `vite dev`, we fall back to mock data so the UI is iterable.
const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke;

const state = {
  data: null,
  view: 'overview',
};

const el = {
  content: document.getElementById('content'),
  scannedAt: document.getElementById('scanned-at'),
  rescan: document.getElementById('rescan'),
  footerPath: document.getElementById('footer-path'),
  footerWarnings: document.getElementById('footer-warnings'),
  tabs: document.querySelectorAll('.tab'),
};

// ---- bootstrap -----------------------------------------------------------

el.rescan.addEventListener('click', loadData);
el.tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    state.view = tab.dataset.view;
    el.tabs.forEach(t => t.classList.toggle('active', t === tab));
    render();
  });
});

loadData();

async function loadData() {
  el.content.innerHTML = '<div class="loading">Scanning your filesystem</div>';
  try {
    if (invoke) {
      state.data = await invoke('scan');
    } else {
      state.data = mockData();
    }
  } catch (err) {
    el.content.innerHTML = `<div class="empty-state"><div class="glyph">✕</div><p>Scan failed: ${escapeHtml(String(err))}</p></div>`;
    return;
  }
  updateChrome();
  render();
}

function updateChrome() {
  const d = state.data;
  if (!d) return;
  const dt = new Date(d.scanned_at);
  el.scannedAt.textContent = `scanned ${formatTime(dt)}`;
  el.footerPath.textContent = d.claude_dir || '~/.claude (not found)';
  const wc = d.warnings?.length || 0;
  el.footerWarnings.textContent = `${wc} warning${wc === 1 ? '' : 's'}`;
}

// ---- views ---------------------------------------------------------------

function render() {
  if (!state.data) return;
  const renderers = {
    overview: renderOverview,
    config: renderConfig,
    skills: renderSkills,
    projects: renderProjects,
    permissions: renderPermissions,
    mcp: renderMcp,
    agents: renderAgentsAndCommands,
  };
  el.content.innerHTML = renderers[state.view]?.(state.data) ?? '<p>not implemented</p>';
  attachModalHandlers();
}

function renderOverview(d) {
  const userSkills = d.skills.filter(s => s.scope === 'user').length;
  const projSkills = d.skills.length - userSkills;
  const totalSessions = d.projects.reduce((sum, p) => sum + p.session_count, 0);

  return `
    <div class="section-head">
      <h2>An overview of your <em>Claude</em></h2>
      <span class="count">${d.claude_dir_exists ? 'directory found' : 'no ~/.claude'}</span>
    </div>
    <p class="kicker">
      What follows is a tour of everything Claude Code keeps on this machine —
      skills it can summon, agents it can wear, the permissions you've granted and
      revoked, and every project you've ever opened a session in.
    </p>

    <div class="stats-grid">
      ${stat('Skills', d.skills.length, 'accent', `${userSkills} user · ${projSkills} project`)}
      ${stat('Agents', d.agents.length, 'lime')}
      ${stat('Slash commands', d.commands.length, 'lime')}
      ${stat('MCP servers', d.mcp_servers.length, 'hot')}
      ${stat('Hooks', d.hooks.length, 'hot')}
      ${stat('Projects', d.projects.length, '', `${totalSessions} sessions`)}
      ${stat('Model', d.global.model ?? '—', 'accent')}
      ${stat('Permissions', (d.global.permissions.allow.length + d.global.permissions.deny.length + d.global.permissions.ask.length), '', `${d.global.permissions.allow.length} allow · ${d.global.permissions.deny.length} deny · ${d.global.permissions.ask.length} ask`)}
    </div>

    ${d.warnings.length ? `
      <div class="section-head"><h2>Warnings</h2><span class="count">${d.warnings.length}</span></div>
      <ul style="list-style:none; padding:0; margin:0;">
        ${d.warnings.map(w => `<li style="padding:8px 0; border-bottom:1px dashed var(--rule-soft); color:var(--ink-dim); font-size:12px;">${escapeHtml(w)}</li>`).join('')}
      </ul>
    ` : ''}
  `;
}

function stat(label, value, color = '', sub = '') {
  return `
    <div class="stat">
      <div class="stat-label">${escapeHtml(label)}</div>
      <div class="stat-value ${color}">${escapeHtml(String(value))}</div>
      ${sub ? `<div class="stat-sub">${escapeHtml(sub)}</div>` : ''}
    </div>
  `;
}

function renderConfig(d) {
  const g = d.global;
  const envEntries = g.env && typeof g.env === 'object' && !Array.isArray(g.env)
    ? Object.entries(g.env)
    : [];

  return `
    <div class="section-head">
      <h2><em>Global</em> configuration</h2>
      <span class="count">${g.settings_path ? 'settings.json found' : 'no settings.json'}</span>
    </div>
    <dl class="kv-list">
      <dt>Settings path</dt>
      <dd>${g.settings_path ? escapeHtml(g.settings_path) : '<span class="empty">not found</span>'}</dd>
      <dt>Model</dt>
      <dd>${g.model ? escapeHtml(g.model) : '<span class="empty">default</span>'}</dd>
      <dt>Theme</dt>
      <dd>${g.theme ? escapeHtml(g.theme) : '<span class="empty">default</span>'}</dd>
      <dt>User CLAUDE.md</dt>
      <dd>${g.user_claude_md_path ? escapeHtml(g.user_claude_md_path) : '<span class="empty">none</span>'}</dd>
      <dt>Legacy ~/.claude.json</dt>
      <dd>${g.legacy_claude_json_path
          ? `${escapeHtml(g.legacy_claude_json_path)} <span style="color:var(--ink-faint)">(${formatBytes(g.legacy_claude_json_size_bytes)})</span>`
          : '<span class="empty">none</span>'}</dd>
    </dl>

    ${envEntries.length ? `
      <div class="section-head" style="margin-top:40px;"><h2>Environment</h2><span class="count">${envEntries.length} variables</span></div>
      <dl class="kv-list">
        ${envEntries.map(([k, v]) => `
          <dt>${escapeHtml(k)}</dt>
          <dd>${escapeHtml(String(v))}</dd>
        `).join('')}
      </dl>
    ` : ''}

    ${g.user_claude_md_preview ? `
      <div class="section-head" style="margin-top:40px;"><h2>User memory</h2><span class="count">CLAUDE.md preview</span></div>
      <pre class="json">${escapeHtml(g.user_claude_md_preview)}</pre>
    ` : ''}

    ${g.settings_raw ? `
      <div class="section-head" style="margin-top:40px;"><h2>Raw settings.json</h2><span class="count">expand to inspect</span></div>
      <pre class="json">${highlightJson(g.settings_raw)}</pre>
    ` : ''}
  `;
}

function renderSkills(d) {
  if (!d.skills.length) {
    return emptyState('No skills yet', 'No SKILL.md files were found in ~/.claude/skills or any project .claude/skills.');
  }
  return `
    <div class="section-head">
      <h2>The <em>skills</em> library</h2>
      <span class="count">${d.skills.length} total</span>
    </div>
    <p class="kicker">
      Skills are workflows Claude can summon on its own when the conversation matches.
      Each card is a real SKILL.md on disk — click to read the body.
    </p>
    <div class="card-grid">
      ${d.skills.map(s => skillCard(s)).join('')}
    </div>
  `;
}

function skillCard(s) {
  return `
    <div class="card clickable" data-modal-title="${escapeHtml(s.name)}" data-modal-path="${escapeHtml(s.path)}" data-modal-body="${escapeHtml(s.body_preview || '(no body)')}">
      <div class="card-head">
        <h3 class="card-title">${escapeHtml(s.name)}</h3>
        <span class="card-scope ${s.scope === 'user' ? 'user' : 'project'}">${s.scope === 'user' ? 'USER' : 'PROJECT'}</span>
      </div>
      <p class="card-desc">${escapeHtml(s.description || 'No description.')}</p>
      ${(s.allowed_tools.length || s.has_supporting_files) ? `
        <div class="card-meta">
          ${s.allowed_tools.map(t => `<span class="tag tool">${escapeHtml(t)}</span>`).join('')}
          ${s.has_supporting_files ? '<span class="tag">+ files</span>' : ''}
        </div>
      ` : ''}
    </div>
  `;
}

function renderProjects(d) {
  if (!d.projects.length) {
    return emptyState('No projects yet', 'Once you run Claude Code in a directory, it shows up here.');
  }
  return `
    <div class="section-head">
      <h2>Your <em>projects</em></h2>
      <span class="count">${d.projects.length} tracked</span>
    </div>
    <p class="kicker">
      Every directory you've opened a Claude Code session in, with session counts and
      a peek at the project's CLAUDE.md when available.
    </p>
    <div>
      ${d.projects.map(p => `
        <div class="project clickable"
             data-modal-title="${escapeHtml(p.name)}"
             data-modal-path="${escapeHtml(p.path)}"
             data-modal-body="${escapeHtml(p.claude_md_preview || '(no CLAUDE.md)')}">
          <div>
            <h3 class="project-name">${escapeHtml(p.name)}</h3>
            <div class="project-path">${escapeHtml(p.path)}</div>
          </div>
          <div class="project-stat">
            <strong>${p.session_count}</strong>
            sessions
            <div style="margin-top:4px;">${p.last_modified ? formatDate(new Date(p.last_modified)) : '—'}</div>
          </div>
          <div class="proj-flags">
            <span class="flag ${p.has_claude_md ? 'on' : ''}">MD</span>
            <span class="flag ${p.has_settings ? 'on' : ''}">CFG</span>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderPermissions(d) {
  const p = d.global.permissions;
  const col = (label, klass, rules) => `
    <div class="perm-col">
      <div class="perm-head ${klass}">${label} <span class="ct">${rules.length}</span></div>
      <div class="perm-list">
        ${rules.length
          ? rules.map(r => `<div class="perm-rule">${escapeHtml(r)}</div>`).join('')
          : '<div class="perm-empty">no rules</div>'}
      </div>
    </div>
  `;
  return `
    <div class="section-head">
      <h2><em>Permissions</em></h2>
      <span class="count">deny &gt; ask &gt; allow</span>
    </div>
    <p class="kicker">
      What Claude is allowed to do, must ask about, and is forbidden from.
      Deny rules win over allow rules — even when both match.
    </p>
    <div class="perm-grid">
      ${col('Allow', 'allow', p.allow)}
      ${col('Ask', 'ask', p.ask)}
      ${col('Deny', 'deny', p.deny)}
    </div>
  `;
}

function renderMcp(d) {
  return `
    <div class="section-head">
      <h2><em>MCP</em> servers</h2>
      <span class="count">${d.mcp_servers.length} configured</span>
    </div>
    ${d.mcp_servers.length ? `
      <div class="mcp-list">
        ${d.mcp_servers.map(m => `
          <div class="mcp-item">
            <div>
              <div class="mcp-name">${escapeHtml(m.name)}</div>
              <div class="mcp-transport">${escapeHtml(m.transport || 'unknown')}</div>
            </div>
            <div class="mcp-cmd">${escapeHtml(m.url || m.command || '—')}</div>
            <div style="text-align:right; font-size:10px; color:var(--ink-faint); letter-spacing:0.1em; text-transform:uppercase;">${escapeHtml(m.scope === 'user' ? 'user' : 'project')}</div>
          </div>
        `).join('')}
      </div>
    ` : '<div class="perm-empty" style="border:1px solid var(--rule); padding:24px;">no MCP servers configured</div>'}

    <div class="section-head" style="margin-top:40px;">
      <h2><em>Hooks</em></h2>
      <span class="count">${d.hooks.length} registered</span>
    </div>
    ${d.hooks.length ? `
      <div class="hook-list">
        ${d.hooks.map(h => `
          <div class="hook-item">
            <div>
              <div class="hook-event">${escapeHtml(h.event)}</div>
              ${h.matcher ? `<div class="hook-matcher">matches: ${escapeHtml(h.matcher)}</div>` : ''}
            </div>
            <div class="hook-cmd">${escapeHtml(h.command || '—')}</div>
            <div style="text-align:right; font-size:10px; color:var(--ink-faint); letter-spacing:0.1em; text-transform:uppercase;">${escapeHtml(h.scope === 'user' ? 'user' : 'project')}</div>
          </div>
        `).join('')}
      </div>
    ` : '<div class="perm-empty" style="border:1px solid var(--rule); padding:24px;">no hooks registered</div>'}
  `;
}

function renderAgentsAndCommands(d) {
  return `
    <div class="section-head">
      <h2><em>Agents</em></h2>
      <span class="count">${d.agents.length} defined</span>
    </div>
    ${d.agents.length ? `
      <div class="card-grid">
        ${d.agents.map(a => `
          <div class="card clickable" data-modal-title="${escapeHtml(a.name)}" data-modal-path="${escapeHtml(a.path)}" data-modal-body="${escapeHtml(a.body_preview)}">
            <div class="card-head">
              <h3 class="card-title">${escapeHtml(a.name)}</h3>
              <span class="card-scope ${a.scope === 'user' ? 'user' : 'project'}">${a.scope === 'user' ? 'USER' : 'PROJECT'}</span>
            </div>
            <p class="card-desc">${escapeHtml(a.description || 'No description.')}</p>
            <div class="card-meta">
              ${a.model ? `<span class="tag model">${escapeHtml(a.model)}</span>` : ''}
              ${a.tools.map(t => `<span class="tag tool">${escapeHtml(t)}</span>`).join('')}
            </div>
          </div>
        `).join('')}
      </div>
    ` : '<div class="perm-empty" style="border:1px solid var(--rule); padding:24px;">no agents defined</div>'}

    <div class="section-head" style="margin-top:40px;">
      <h2><em>Slash</em> commands</h2>
      <span class="count">${d.commands.length} commands</span>
    </div>
    ${d.commands.length ? `
      <div class="card-grid">
        ${d.commands.map(c => `
          <div class="card clickable" data-modal-title="/${escapeHtml(c.name)}" data-modal-path="${escapeHtml(c.path)}" data-modal-body="${escapeHtml(c.body_preview)}">
            <div class="card-head">
              <h3 class="card-title">/${escapeHtml(c.name)}</h3>
              <span class="card-scope ${c.scope === 'user' ? 'user' : 'project'}">${c.scope === 'user' ? 'USER' : 'PROJECT'}</span>
            </div>
            <p class="card-desc" style="-webkit-line-clamp:5;">${escapeHtml(c.body_preview || '(empty)')}</p>
          </div>
        `).join('')}
      </div>
    ` : '<div class="perm-empty" style="border:1px solid var(--rule); padding:24px;">no slash commands defined</div>'}
  `;
}

// ---- modal ---------------------------------------------------------------

function attachModalHandlers() {
  document.querySelectorAll('.clickable').forEach(c => {
    c.addEventListener('click', () => {
      openModal({
        title: c.dataset.modalTitle,
        path: c.dataset.modalPath,
        body: c.dataset.modalBody,
      });
    });
  });
}

function openModal({ title, path, body }) {
  let overlay = document.querySelector('.modal-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModal();
    });
  }
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" aria-label="close">×</button>
      <h3>${escapeHtml(title || '')}</h3>
      <div class="modal-path">${escapeHtml(path || '')}</div>
      <pre>${escapeHtml(body || '')}</pre>
    </div>
  `;
  overlay.classList.add('open');
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
}

function closeModal() {
  document.querySelector('.modal-overlay')?.classList.remove('open');
}

// ---- helpers -------------------------------------------------------------

function emptyState(title, sub) {
  return `
    <div class="empty-state">
      <div class="glyph">∅</div>
      <p>${escapeHtml(title)}</p>
      <p style="font-size:13px; font-style:normal; color:var(--ink-faint); margin-top:8px;">${escapeHtml(sub)}</p>
    </div>
  `;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function formatTime(d) {
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
}

function formatDate(d) {
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatBytes(n) {
  if (n == null) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(1)} ${units[i]}`;
}

function highlightJson(value) {
  const raw = JSON.stringify(value, null, 2);
  return escapeHtml(raw)
    .replace(/(&quot;)([^&]+?)\1(\s*:)/g, '<span class="k">$1$2$1</span>$3')
    .replace(/:\s*(&quot;)((?:[^&]|&(?!quot;))*?)\1/g, ': <span class="s">$1$2$1</span>')
    .replace(/:\s*(-?\d+\.?\d*)/g, ': <span class="n">$1</span>')
    .replace(/:\s*(true|false|null)\b/g, ': <span class="b">$1</span>');
}

// ---- mock data (for plain `vite dev` without Tauri) ---------------------

function mockData() {
  return {
    scanned_at: new Date().toISOString(),
    home_dir: '/Users/you',
    claude_dir: '/Users/you/.claude',
    claude_dir_exists: true,
    global: {
      settings_path: '/Users/you/.claude/settings.json',
      model: 'claude-sonnet-4-6',
      theme: 'dark',
      env: { ANTHROPIC_API_URL: 'https://api.anthropic.com', NODE_ENV: 'development' },
      permissions: {
        allow: ['Bash(npm run:*)', 'Bash(git:*)', 'Read(./**)'],
        deny: ['Read(.env)', 'Read(.env.*)', 'Bash(rm -rf:*)'],
        ask: ['Bash(curl:*)', 'WebFetch(*)'],
      },
      legacy_claude_json_path: '/Users/you/.claude.json',
      legacy_claude_json_size_bytes: 2_400_000,
      user_claude_md_path: '/Users/you/.claude/CLAUDE.md',
      user_claude_md_preview: '# My preferences\n\n- Prefer named exports\n- Write types first\n- Use ripgrep over grep',
      settings_raw: { model: 'claude-sonnet-4-6', permissions: { allow: ['Bash(npm run:*)'] } },
    },
    skills: [
      { name: 'security-review', description: 'Comprehensive security audit. Use when reviewing code for vulnerabilities or before deployments.', scope: 'user', path: '/Users/you/.claude/skills/security-review/SKILL.md', allowed_tools: ['Read', 'Grep', 'Glob'], body_preview: 'Analyze the codebase for security vulnerabilities including SQL injection, XSS, exposed credentials...', has_supporting_files: true },
      { name: 'deploy-checklist', description: 'Pre-deployment checklist runner.', scope: 'user', path: '/Users/you/.claude/skills/deploy/SKILL.md', allowed_tools: ['Bash', 'Read'], body_preview: 'Walk through deployment steps...', has_supporting_files: false },
      { name: 'pr-review', description: 'Project-scoped PR review with house style rules.', scope: '/Users/you/code/myapp', path: '/Users/you/code/myapp/.claude/skills/pr-review/SKILL.md', allowed_tools: ['Read', 'Bash'], body_preview: 'Review the PR against our conventions...', has_supporting_files: true },
    ],
    agents: [
      { name: 'code-reviewer', description: 'Senior code reviewer focused on correctness.', model: 'sonnet', tools: ['Read', 'Grep', 'Glob'], scope: 'user', path: '/Users/you/.claude/agents/code-reviewer.md', body_preview: 'You are a senior reviewer...' },
    ],
    commands: [
      { name: 'review', scope: 'user', path: '/Users/you/.claude/commands/review.md', body_preview: 'Review the staged changes for issues.' },
      { name: 'standup', scope: 'user', path: '/Users/you/.claude/commands/standup.md', body_preview: 'Generate a daily standup summary from recent commits.' },
    ],
    mcp_servers: [
      { name: 'github', source: '/Users/you/.claude/settings.json', scope: 'user', transport: 'stdio', command: 'npx @modelcontextprotocol/server-github', url: null, raw: {} },
      { name: 'asana', source: '/Users/you/.claude/settings.json', scope: 'user', transport: 'http', command: null, url: 'https://mcp.asana.com/sse', raw: {} },
    ],
    hooks: [
      { event: 'PreToolUse', matcher: 'Bash', command: '.claude/hooks/block-secrets.sh', scope: 'user', source: '/Users/you/.claude/settings.json' },
      { event: 'PostToolUse', matcher: 'Write', command: 'prettier --write $TOOL_INPUT_PATH', scope: 'user', source: '/Users/you/.claude/settings.json' },
    ],
    projects: [
      { path: '/Users/you/code/myapp', name: 'myapp', session_count: 42, last_modified: new Date(Date.now() - 1000*60*60*3).toISOString(), has_claude_md: true, has_settings: true, claude_md_preview: '# myapp\n\nNext.js 15, TypeScript strict, Tailwind v4.', settings_path: '/Users/you/code/myapp/.claude/settings.json' },
      { path: '/Users/you/code/scratch', name: 'scratch', session_count: 7, last_modified: new Date(Date.now() - 1000*60*60*24*2).toISOString(), has_claude_md: false, has_settings: false, claude_md_preview: null, settings_path: null },
    ],
    warnings: [],
  };
}
