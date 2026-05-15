// Tauri exposes `invoke` on window when running inside the desktop shell.
// When running plain `vite dev`, we fall back to mock data so the UI is iterable.
const invoke = window.__TAURI__?.core?.invoke ?? window.__TAURI__?.invoke;

const state = {
  data: null,
  view: 'overview',
  filters: {},
  selectedProject: null,
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
    state.selectedProject = null;
    el.tabs.forEach(t => t.classList.toggle('active', t === tab));
    render();
  });
});

loadData();

async function loadData() {
  el.content.innerHTML = '<div class="loading">Scanning your filesystem</div>';
  el.rescan.disabled = true;
  el.rescan.textContent = '↻ Scanning…';
  try {
    if (invoke) {
      state.data = await invoke('scan');
    } else {
      state.data = mockData();
    }
  } catch (err) {
    el.content.innerHTML = `<div class="empty-state"><div class="glyph">✕</div><p>Scan failed: ${escapeHtml(String(err))}</p></div>`;
    return;
  } finally {
    el.rescan.disabled = false;
    el.rescan.textContent = '↻ Rescan';
  }
  updateChrome();
  render();
}

function updateChrome() {
  const d = state.data;
  if (!d) return;
  const dt = new Date(d.scanned_at);
  el.scannedAt.textContent = `scanned ${formatTime(dt)}`;
  const pathLabel = d.claude_dir || '~/.claude (not found)';
  el.footerPath.textContent = d.claude_config_dir_override
    ? `${pathLabel} (CLAUDE_CONFIG_DIR)`
    : pathLabel;
  const wc = d.warnings?.length || 0;
  el.footerWarnings.textContent = `${wc} warning${wc === 1 ? '' : 's'}`;
}

// ---- views ---------------------------------------------------------------

function render() {
  if (!state.data) return;
  if (state.view === 'projects' && state.selectedProject) {
    el.content.innerHTML = renderProjectDetail(state.data, state.selectedProject);
    attachModalHandlers();
    attachProjectDetailHandlers();
    return;
  }
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
  attachProjectRowHandlers();
  if (state.view === 'permissions') attachPermissionHandlers();
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
  const q = (state.filters['skills'] || '').toLowerCase();
  const skills = q
    ? d.skills.filter(s => (s.name + ' ' + (s.description || '')).toLowerCase().includes(q))
    : d.skills;
  return `
    <div class="section-head">
      <h2>The <em>skills</em> library</h2>
      <span class="count">${skills.length} of ${d.skills.length}</span>
    </div>
    <p class="kicker">
      Skills are workflows Claude can summon on its own when the conversation matches.
      Each card is a real SKILL.md on disk — click to read the body.
    </p>
    <input class="filter-input" data-filter-view="skills" placeholder="Filter skills…" value="${escapeHtml(state.filters['skills'] || '')}">
    <div class="card-grid" style="margin-top:16px;">
      ${skills.length ? skills.map(s => skillCard(s)).join('') : '<div class="perm-empty" style="border:1px solid var(--rule);padding:24px;">no matches</div>'}
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
  const q = (state.filters['projects'] || '').toLowerCase();
  const projects = q
    ? d.projects.filter(p => (p.name + ' ' + p.path).toLowerCase().includes(q))
    : d.projects;
  return `
    <div class="section-head">
      <h2>Your <em>projects</em></h2>
      <span class="count">${projects.length} of ${d.projects.length} tracked</span>
    </div>
    <p class="kicker">
      Every directory you've opened a Claude Code session in, with session counts and
      a peek at the project's CLAUDE.md when available.
    </p>
    <input class="filter-input" data-filter-view="projects" placeholder="Filter projects…" value="${escapeHtml(state.filters['projects'] || '')}">
    <div style="margin-top:16px;">
      ${projects.length ? projects.map(p => `
        <div class="project project-row" data-project-path="${escapeHtml(p.path)}">
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
      `).join('') : '<div class="perm-empty" style="border:1px solid var(--rule);padding:24px;">no matches</div>'}
    </div>
  `;
}

function renderPermissions(d) {
  const p = d.global.permissions;
  const canEdit = !!(invoke && d.global.settings_path);
  const col = (label, klass, type, rules) => `
    <div class="perm-col">
      <div class="perm-head ${klass}">${label} <span class="ct">${rules.length}</span></div>
      <div class="perm-list">
        ${rules.length
          ? rules.map((r, i) => `
            <div class="perm-rule">
              ${escapeHtml(r)}
              ${canEdit ? `<button class="perm-delete" data-perm-type="${type}" data-perm-index="${i}" title="Remove rule">×</button>` : ''}
            </div>`).join('')
          : '<div class="perm-empty">no rules</div>'}
      </div>
      ${canEdit ? `
        <div class="perm-add-row" id="perm-add-${type}">
          <button class="btn perm-add-btn" data-perm-type="${type}" style="width:100%;font-size:10px;margin:8px 0 0;">+ Add rule</button>
        </div>
      ` : ''}
    </div>
  `;
  const editWarning = !canEdit && invoke ? `
    <div class="perm-empty" style="border:1px dashed var(--rule);padding:12px;margin-bottom:16px;font-size:11px;">
      Settings file not found — cannot edit permissions.
    </div>` : '';
  return `
    <div class="section-head">
      <h2><em>Permissions</em></h2>
      <span class="count">deny &gt; ask &gt; allow</span>
    </div>
    <p class="kicker">
      What Claude is allowed to do, must ask about, and is forbidden from.
      Deny rules win over allow rules — even when both match.
    </p>
    ${editWarning}
    <div class="perm-grid">
      ${col('Allow', 'allow', 'allow', p.allow)}
      ${col('Ask', 'ask', 'ask', p.ask)}
      ${col('Deny', 'deny', 'deny', p.deny)}
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
  const q = (state.filters['agents'] || '').toLowerCase();
  const agents = q
    ? d.agents.filter(a => (a.name + ' ' + (a.description || '')).toLowerCase().includes(q))
    : d.agents;
  const commands = q
    ? d.commands.filter(c => c.name.toLowerCase().includes(q))
    : d.commands;
  return `
    <input class="filter-input" data-filter-view="agents" placeholder="Filter agents &amp; commands…" value="${escapeHtml(state.filters['agents'] || '')}" style="margin-bottom:24px;">
    <div class="section-head">
      <h2><em>Agents</em></h2>
      <span class="count">${agents.length} of ${d.agents.length} defined</span>
    </div>
    ${agents.length ? `
      <div class="card-grid">
        ${agents.map(a => `
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
      <span class="count">${commands.length} of ${d.commands.length} commands</span>
    </div>
    ${commands.length ? `
      <div class="card-grid">
        ${commands.map(c => `
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

// ---- permissions editor --------------------------------------------------

function attachPermissionHandlers() {
  // Delete rule
  document.querySelectorAll('.perm-delete').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const type = btn.dataset.permType;
      const idx  = parseInt(btn.dataset.permIndex, 10);
      const rules = [...state.data.global.permissions[type]];
      rules.splice(idx, 1);
      savePermissions({ ...state.data.global.permissions, [type]: rules });
    });
  });

  // Show add-rule inline form
  document.querySelectorAll('.perm-add-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const type = btn.dataset.permType;
      const row  = document.getElementById(`perm-add-${type}`);
      if (!row) return;
      row.innerHTML = `
        <div style="display:flex;gap:4px;padding:8px 0;">
          <input class="filter-input perm-new-input" placeholder="e.g. Bash(npm:*)" style="flex:1;">
          <button class="btn perm-save-btn" data-perm-type="${type}" style="font-size:10px;">Save</button>
          <button class="btn perm-cancel-btn" style="font-size:10px;">✕</button>
        </div>
      `;
      const input = row.querySelector('.perm-new-input');
      input.focus();
      row.querySelector('.perm-cancel-btn').addEventListener('click', render);
      row.querySelector('.perm-save-btn').addEventListener('click', () => {
        const val = input.value.trim();
        if (!val) return;
        const rules = [...state.data.global.permissions[type], val];
        savePermissions({ ...state.data.global.permissions, [type]: rules });
      });
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') row.querySelector('.perm-save-btn').click();
        if (e.key === 'Escape') render();
      });
    });
  });
}

async function savePermissions(newPerms) {
  const d = state.data;
  if (!invoke || !d.global.settings_path) return;
  const updated = JSON.parse(JSON.stringify(d.global.settings_raw || {}));
  updated.permissions = { allow: newPerms.allow, deny: newPerms.deny, ask: newPerms.ask };
  try {
    await invoke('write_settings', { path: d.global.settings_path, content: JSON.stringify(updated, null, 2) });
    await loadData();
  } catch (err) {
    alert(`Failed to save settings: ${err}`);
  }
}

// ---- project handlers & detail -------------------------------------------

function attachProjectRowHandlers() {
  document.querySelectorAll('.project-row').forEach(row => {
    row.addEventListener('click', () => {
      state.selectedProject = row.dataset.projectPath;
      render();
    });
  });
}

function attachProjectDetailHandlers() {
  const backBtn = document.getElementById('proj-back');
  if (backBtn) {
    backBtn.addEventListener('click', () => {
      state.selectedProject = null;
      render();
    });
  }
  // Load CLAUDE.md content if invoke is available
  const mdPre = document.getElementById('proj-md-pre');
  if (mdPre && invoke) {
    const mdPath = mdPre.dataset.path;
    if (mdPath) {
      invoke('read_text_file', { path: mdPath }).then(full => {
        mdPre.textContent = full;
      }).catch(() => {});
    }
  }
  // Load settings.json
  const settingsPre = document.getElementById('proj-settings-pre');
  if (settingsPre && invoke) {
    const p = state.data?.projects.find(x => x.path === state.selectedProject);
    if (p?.settings_path) {
      invoke('read_text_file', { path: p.settings_path }).then(text => {
        try {
          settingsPre.innerHTML = highlightJson(JSON.parse(text));
        } catch {
          settingsPre.textContent = text;
        }
      }).catch(() => { settingsPre.textContent = '(could not load)'; });
    }
  }
}

function renderProjectDetail(d, projectPath) {
  const p = d.projects.find(x => x.path === projectPath);
  if (!p) return emptyState('Project not found', 'The selected project could not be found in the snapshot.');

  const skills   = d.skills.filter(x => x.scope === projectPath);
  const agents   = d.agents.filter(x => x.scope === projectPath);
  const commands = d.commands.filter(x => x.scope === projectPath);
  const mcps     = d.mcp_servers.filter(x => x.scope === projectPath);
  const hooks    = d.hooks.filter(x => x.scope === projectPath);

  const mdSection = p.has_claude_md && p.claude_md_preview ? `
    <div class="section-head" style="margin-top:40px;"><h2>CLAUDE.md</h2><span class="count">project memory</span></div>
    <pre class="json" id="proj-md-pre" data-path="${escapeHtml(p.path + '/CLAUDE.md')}">${escapeHtml(p.claude_md_preview)}</pre>
  ` : '';

  const settingsSection = p.has_settings && p.settings_path ? `
    <div class="section-head" style="margin-top:40px;"><h2>settings.json</h2><span class="count">project config</span></div>
    <pre class="json" id="proj-settings-pre">${escapeHtml('(loading…)')}</pre>
  ` : '';

  const skillsSection = skills.length ? `
    <div class="section-head" style="margin-top:40px;"><h2>Skills</h2><span class="count">${skills.length}</span></div>
    <div class="card-grid">${skills.map(s => skillCard(s)).join('')}</div>
  ` : '';

  const agentsSection = agents.length ? `
    <div class="section-head" style="margin-top:40px;"><h2>Agents</h2><span class="count">${agents.length}</span></div>
    <div class="card-grid">${agents.map(a => `
      <div class="card clickable" data-modal-title="${escapeHtml(a.name)}" data-modal-path="${escapeHtml(a.path)}" data-modal-body="${escapeHtml(a.body_preview)}">
        <div class="card-head"><h3 class="card-title">${escapeHtml(a.name)}</h3></div>
        <p class="card-desc">${escapeHtml(a.description || 'No description.')}</p>
      </div>`).join('')}
    </div>
  ` : '';

  const commandsSection = commands.length ? `
    <div class="section-head" style="margin-top:40px;"><h2>Slash commands</h2><span class="count">${commands.length}</span></div>
    <div class="card-grid">${commands.map(c => `
      <div class="card clickable" data-modal-title="/${escapeHtml(c.name)}" data-modal-path="${escapeHtml(c.path)}" data-modal-body="${escapeHtml(c.body_preview)}">
        <div class="card-head"><h3 class="card-title">/${escapeHtml(c.name)}</h3></div>
        <p class="card-desc">${escapeHtml(c.body_preview || '(empty)')}</p>
      </div>`).join('')}
    </div>
  ` : '';

  const mcpSection = mcps.length ? `
    <div class="section-head" style="margin-top:40px;"><h2>MCP servers</h2><span class="count">${mcps.length}</span></div>
    <div class="mcp-list">${mcps.map(m => `
      <div class="mcp-item">
        <div><div class="mcp-name">${escapeHtml(m.name)}</div><div class="mcp-transport">${escapeHtml(m.transport || 'unknown')}</div></div>
        <div class="mcp-cmd">${escapeHtml(m.url || m.command || '—')}</div>
        <div></div>
      </div>`).join('')}
    </div>
  ` : '';

  const hooksSection = hooks.length ? `
    <div class="section-head" style="margin-top:40px;"><h2>Hooks</h2><span class="count">${hooks.length}</span></div>
    <div class="hook-list">${hooks.map(h => `
      <div class="hook-item">
        <div><div class="hook-event">${escapeHtml(h.event)}</div>${h.matcher ? `<div class="hook-matcher">matches: ${escapeHtml(h.matcher)}</div>` : ''}</div>
        <div class="hook-cmd">${escapeHtml(h.command || '—')}</div>
        <div></div>
      </div>`).join('')}
    </div>
  ` : '';

  return `
    <div style="display:flex; align-items:center; gap:16px; margin-bottom:24px;">
      <button id="proj-back" class="btn">← Back</button>
      <div class="proj-flags">
        <span class="flag ${p.has_claude_md ? 'on' : ''}">MD</span>
        <span class="flag ${p.has_settings ? 'on' : ''}">CFG</span>
      </div>
    </div>
    <div class="section-head">
      <h2><em>${escapeHtml(p.name)}</em></h2>
      <span class="count">${p.session_count} sessions</span>
    </div>
    <div class="project-path" style="margin-bottom:24px;">${escapeHtml(p.path)}</div>
    ${mdSection}
    ${settingsSection}
    ${skillsSection}
    ${agentsSection}
    ${commandsSection}
    ${mcpSection}
    ${hooksSection}
    ${!mdSection && !settingsSection && !skillsSection && !agentsSection && !commandsSection && !mcpSection && !hooksSection
      ? '<div class="perm-empty" style="border:1px solid var(--rule);padding:24px;margin-top:24px;">No project-scoped configuration found.</div>'
      : ''}
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
  document.querySelectorAll('.filter-input').forEach(input => {
    input.addEventListener('input', e => {
      state.filters[e.target.dataset.filterView] = e.target.value;
      render();
      // Restore focus to the filter input after re-render
      const restored = document.querySelector(`.filter-input[data-filter-view="${e.target.dataset.filterView}"]`);
      if (restored) { restored.focus(); restored.setSelectionRange(restored.value.length, restored.value.length); }
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
  const initialContent = invoke && path ? 'Loading\u2026' : escapeHtml(body || '');
  const editorBtn = invoke && path
    ? `<button class="modal-editor-btn btn" aria-label="open in editor">Open in editor</button>`
    : '';
  overlay.innerHTML = `
    <div class="modal">
      <button class="modal-close" aria-label="close">×</button>
      <h3>${escapeHtml(title || '')}</h3>
      <div class="modal-path">${escapeHtml(path || '')}</div>
      ${editorBtn}
      <pre>${initialContent}</pre>
    </div>
  `;
  overlay.classList.add('open');
  overlay.querySelector('.modal-close').addEventListener('click', closeModal);
  const editorBtnEl = overlay.querySelector('.modal-editor-btn');
  if (editorBtnEl) {
    editorBtnEl.addEventListener('click', () => {
      invoke('open_in_editor', { path }).catch(err => {
        alert(`Could not open file: ${err}`);
      });
    });
  }

  // Load full file content when running inside Tauri
  if (invoke && path) {
    invoke('read_text_file', { path }).then(full => {
      const pre = overlay.querySelector('.modal pre');
      if (pre) pre.textContent = full;
    }).catch(() => {
      const pre = overlay.querySelector('.modal pre');
      if (pre && body) pre.textContent = body;
    });
  }
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
    claude_config_dir_override: null,
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
