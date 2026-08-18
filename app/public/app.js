// Task Juggler - Local-First Frontend Application
import { prioritize } from './scoring.js';

const API_BASE = '/api';

let state = { tasks: [], tree: [], counts: {}, selected: new Set(), sources: null, connections: {} };

// ─── Provider metadata ────────────────────────────────────────────────────
const PROVIDERS = {
  slack: {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    color: '#4a154b',
    supportsOAuth: true,
    isMcpOAuth: false, // direct user-token OAuth (Claude-style), not hosted MCP
    supportsToken: true,
    tokenLabel: 'Slack token — xoxb- (bot) or xoxp- (user)',
    tokenHint: 'xoxb-… / xoxp-…',
    description: 'Messages, threads, and files',
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    icon: '⬡',
    color: '#5e6ad2',
    supportsOAuth: true,
    isMcpOAuth: true,
    description: 'Issues and projects',
  },
  todoist: {
    id: 'todoist',
    name: 'Todoist',
    icon: '✓',
    color: '#e44332',
    supportsOAuth: true,
    isMcpOAuth: true,
    description: 'Tasks and projects',
  },
  devin: {
    id: 'devin',
    name: 'Devin',
    icon: 'Δ',
    supportsOAuth: false,
    supportsMCP: false,
    supportsToken: true,
    description: 'Active sessions',
    tokenLabel: 'Devin service-user API key',
    tokenHint: 'cog-… (starts with cog_)',
  },
  claude: {
    id: 'claude',
    name: 'Claude',
    icon: '✦',
    supportsOAuth: false,
    supportsMCP: false,
    supportsToken: false,
    description: 'Local Code and Desktop sessions',
  },
  opencode: {
    id: 'opencode',
    name: 'OpenCode',
    icon: '⌘',
    supportsOAuth: false,
    supportsMCP: false,
    supportsToken: false,
    description: 'Unfinished local OpenCode todos',
  },
};

// Track which OAuth provider is currently being set up
let _pendingAuth = null;
let _pollAuthInterval = null;

// ─── API helpers ──────────────────────────────────────────────────────────
async function api(path, options = {}) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || 'API error');
  }
  return resp.json();
}

async function loadTasks() {
  const data = await api('/tasks');
  state.tasks = data.tasks;
  state.counts = data.counts;
  const treeData = await api('/tasks/tree');
  state.tree = treeData.tree;
  render();
}

async function createTask(body) {
  const data = await api('/tasks', { method: 'POST', body: JSON.stringify(body) });
  return data.task;
}

async function updateTaskApi(id, body) {
  const data = await api(`/tasks/${id}`, { method: 'PATCH', body: JSON.stringify(body) });
  return data.task;
}

async function deleteTask(id) {
  await api(`/tasks/${id}`, { method: 'DELETE' });
}

async function batchAction(ids, action, newStatus) {
  const body = { ids: [...ids], action };
  if (newStatus) body.newStatus = newStatus;
  await api('/tasks/batch', { method: 'POST', body: JSON.stringify(body) });
}

// ─── Connection management ────────────────────────────────────────────────

async function loadConnections() {
  try {
    const data = await api('/auth/status');
    state.connections = data.statuses || {};

    // Also check which providers have app credentials configured (e.g. Slack)
    for (const providerId of ['slack', 'linear', 'todoist', 'devin']) {
      try {
        const setupData = await api(`/auth/mcp-setup/${providerId}`);
        if (setupData.configured) {
          // Mark as having app credentials — frontend will show "Connect" button
          state.connections[providerId] = {
            ...(state.connections[providerId] || { connected: false, providerId }),
            appConfigured: true,
          };
        }
      } catch {
        // Provider may not exist or setup route not available
      }
    }

    // Token-configured sources (Slack/Devin via Keychain) — show a configured badge
    try {
      const keys = await api('/sources/keys');
      for (const [sid, info] of Object.entries(keys.keys || {})) {
        if (info.configured) {
          state.connections[sid] = {
            ...(state.connections[sid] || { connected: false, providerId: sid }),
            tokenConfigured: true,
          };
        }
      }
    } catch {
      // Endpoint unavailable during startup
    }
  } catch {
    state.connections = {};
  }
}

/**
 * Start OAuth authorization for a provider.
 * Uses MCP OAuth for providers with hosted MCP endpoints, 
 * falls back to direct OAuth for others.
 */
async function handleConnect(providerId) {
  const provider = PROVIDERS[providerId];
  if (!provider) return;

  const connectBtn = document.querySelector(`[data-connect="${providerId}"]`);
  if (connectBtn) {
    connectBtn.disabled = true;
    connectBtn.textContent = 'Opening browser…';
  }

  try {
    // Use MCP OAuth for providers that support it, else legacy direct OAuth
    const endpoint = provider.isMcpOAuth ? '/auth/mcp-start' : '/auth/start';
    const data = await api(`${endpoint}/${providerId}`, { method: 'POST' });
    _pendingAuth = { providerId, state: data.state };

    // Open the authorization URL in a popup. Poll for completion either way so
    // the app updates the moment the provider redirects back.
    let authWindow = null;
    try {
      authWindow = window.open(data.authUrl, '_blank', 'width=800,height=700');
    } catch {}

    if (!authWindow || authWindow.closed || typeof authWindow.closed === 'undefined') {
      // Popup blocked: keep the app in this tab and surface the link for manual
      // open, rather than navigating the app away and losing poll state.
      try { navigator.clipboard.writeText(data.authUrl); } catch {}
      const link = window.prompt('Popup blocked. Copy the authorization link and open it in a new tab:', data.authUrl);
      void link;
      showToast(`Authorize in the new tab, then return here`, 'info');
    }

    startPollingForConnection(providerId);
  } catch (err) {
    showToast(`Connection failed: ${err.message}`, 'error');
    if (connectBtn) {
      connectBtn.disabled = false;
      connectBtn.textContent = 'Connect';
    }
    _pendingAuth = null;
  }
}

/**
 * Poll for connection status after initiating OAuth.
 */
function startPollingForConnection(providerId) {
  // Clear any existing poll
  if (_pollAuthInterval) {
    clearInterval(_pollAuthInterval);
  }

  let attempts = 0;
  const maxAttempts = 60; // 2 minutes (2s interval)

  _pollAuthInterval = setInterval(async () => {
    attempts++;
    try {
      const data = await api(`/auth/status/${providerId}`);
      if (data.status && data.status.connected) {
        clearInterval(_pollAuthInterval);
        _pollAuthInterval = null;
        _pendingAuth = null;
        state.connections[providerId] = data.status;
        showToast(`Connected to ${PROVIDERS[providerId]?.name || providerId}`, 'success');
        render();

        // Auto-scan after connection
        handleRefresh();
      }
    } catch {
      // Ignore polling errors
    }

    if (attempts >= maxAttempts) {
      clearInterval(_pollAuthInterval);
      _pollAuthInterval = null;
      if (_pendingAuth) {
        _pendingAuth = null;
        showToast('Authorization timed out. Please try again.', 'error');
        render();
      }
    }
  }, 2000);
}

/**
 * Disconnect a provider (revoke + remove credentials).
 */
async function handleDisconnect(providerId) {
  if (!confirm(`Disconnect ${PROVIDERS[providerId]?.name || providerId}? This will revoke access.`)) return;

  try {
    // Try MCP disconnect first, fall back to legacy
    try {
      await api(`/auth/mcp-disconnect/${providerId}`, { method: 'POST' });
    } catch {
      await api(`/auth/disconnect/${providerId}`, { method: 'POST' });
    }
    // Also update local state
    try { await api(`/auth/disconnect/${providerId}`, { method: 'POST' }); } catch {}
    state.connections[providerId] = { connected: false };
    showToast(`Disconnected from ${PROVIDERS[providerId]?.name || providerId}`, 'success');
    render();
  } catch (err) {
    showToast(`Disconnect failed: ${err.message}`, 'error');
  }
}

// ─── UI helpers ───────────────────────────────────────────────────────────
// Ordering lives in scoring.js (the finishing-bias rules the product is built
// on): tier first (active work above blocked), then score. A not_started task
// the user is responsible for belongs in the top Active list, not the collapsed
// Not Started section.

function partitionTasks() {
  const active = [];
  const notStarted = [];
  const completed = [];

  function walk(node) {
    if (node.status === 'completed') {
      completed.push(node);
    } else if (node.status === 'not_started' && !node.ballInUsersCourt) {
      notStarted.push(node);
    } else {
      active.push(node);
    }
  }

  for (const t of state.tasks) {
    walk(t);
  }

  return {
    active: prioritize(active),
    notStarted: prioritize(notStarted),
    completed: completed.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt)),
  };
}

// ─── Render ───────────────────────────────────────────────────────────────
function render() {
  const { active, notStarted, completed } = partitionTasks();

  renderTaskList('activeList', active, 'active');
  renderTaskList('notStartedList', notStarted, 'notStarted');
  renderTaskList('completedList', completed, 'completed');

  // Count badges
  document.getElementById('notStartedCount').textContent = notStarted.length;
  document.getElementById('completedCount').textContent = completed.length;

  // Active count in header
  const total = active.length + notStarted.length;
  document.getElementById('taskCount').textContent = `${active.length} active${notStarted.length > 0 ? ` + ${notStarted.length} pending` : ''}`;

  // Collapse state persists
  const notStartedEl = document.getElementById('notStartedList');
  if (!notStartedEl.classList.contains('collapsed')) {
    const toggle = document.querySelector('[data-target="notStartedList"] .collapse-toggle');
    if (toggle) toggle.classList.add('open');
  }
  const completedEl = document.getElementById('completedList');
  if (!completedEl.classList.contains('collapsed')) {
    const toggle = document.querySelector('[data-target="completedList"] .collapse-toggle');
    if (toggle) toggle.classList.add('open');
  }

  updateBatchToolbar();
  renderSourcesPanel();
}

function renderSourcesPanel() {
  const container = document.getElementById('sourcesContent');
  const connectedCount = Object.values(state.connections).filter((c) => c && c.connected).length;
  document.getElementById('sourcesSummary').textContent =
    connectedCount > 0 ? `${connectedCount} connected` : '';

  const scanResults = state.sources?.results || {};

  container.innerHTML = Object.values(PROVIDERS).map((provider) => {
    const conn = state.connections[provider.id];
    const scanResult = scanResults[provider.id];

    return renderSourceEntry(provider, conn, scanResult);
  }).join('');
}

function renderSourceEntry(provider, conn, scanResult) {
  const isConnected = conn && conn.connected;
  const isPendingOAuth = _pendingAuth && _pendingAuth.providerId === provider.id;
  const hasToken = provider.supportsToken;
  const scanItems = scanResult?.items || [];
  const scanErrors = scanResult?.errors || [];

  // Action buttons
  let actionHtml = '';
  if (provider.id === 'slack') {
    // Slack: browser user-token OAuth is primary (Claude-style "Sign in with
    // Slack"). A pasted bot/user token remains a fallback.
    const appConfigured = conn && conn.appConfigured;
    const tokenConfigured = conn && conn.tokenConfigured;
    if (isConnected) {
      const scopeLabel = conn.scope ? conn.scope.split(' ').slice(0, 2).join(', ') : '';
      actionHtml = `
        <div class="conn-status">
          <span class="conn-badge connected">Connected</span>
          ${scopeLabel ? `<span class="conn-scope">${escapeHtml(scopeLabel)}</span>` : ''}
          <button class="btn small conn-disconnect" data-disconnect="${provider.id}">Disconnect</button>
        </div>
      `;
    } else if (isPendingOAuth) {
      actionHtml = `
        <div class="conn-status">
          <span class="spinner"></span>
          <span class="conn-pending">Waiting for Slack authorization…</span>
        </div>
      `;
    } else if (appConfigured) {
      actionHtml = `
        <div class="conn-status">
          <button class="btn small primary conn-connect" data-connect="${provider.id}">Sign in with Slack</button>
        </div>
        <div class="conn-status">
          <button class="btn small conn-token-toggle" data-token-toggle="${provider.id}">Use a bot/user token instead</button>
          ${tokenConfigured ? `<span class="conn-badge connected">Token configured</span>` : ''}
        </div>
        <div class="conn-token-config hidden" data-token-config="${provider.id}">
          <input type="password" class="conn-token-input" data-token-input="${provider.id}"
                 placeholder="Slack token — xoxb- (bot) or xoxp- (user)">
          <button class="btn small conn-token-save" data-token-save="${provider.id}">Save</button>
        </div>
      `;
    } else {
      actionHtml = `
        <div class="conn-status">
          <span class="conn-unavailable">One-time Slack app setup required — then you can sign in.</span>
        </div>
        <div class="conn-setup-config" data-setup-config="${provider.id}">
          <div class="setup-guide">
            <p><strong>Set up the Slack app once (a private registration, not an install into your company workspace):</strong></p>
            <ol>
              <li>Create a Slack app at <a href="https://api.slack.com/apps" target="_blank" rel="noopener">api.slack.com/apps</a> → <strong>Blank app</strong>.</li>
              <li><strong>OAuth &amp; Permissions → Enable PKCE</strong> (one-way).</li>
              <li>Add <strong>Redirect URL</strong>: <code>http://localhost:3000/api/auth/callback/slack</code></li>
              <li>Add <strong>User Token Scopes</strong>:<br>
                <code>search:read, search:read.private, channels:read, channels:history,<br>
                groups:history, im:history, mpim:history, users:read,<br>
                reactions:read, files:read, emoji:read</code></li>
              <li>Copy the <strong>Client ID</strong> from Basic Information (no secret needed with PKCE).</li>
            </ol>
          </div>
          <div class="setup-form">
            <input type="text" class="conn-client-input" data-client-input="${provider.id}" placeholder="Slack Client ID">
            <button class="btn small primary conn-client-save" data-client-save="${provider.id}">Save &amp; Sign in with Slack</button>
          </div>
        </div>
      `;
    }
  } else if (provider.isMcpOAuth) {
    // MCP OAuth — zero-setup, just "Connect with browser" (Linear, Todoist)
    if (isConnected) {
      const scopeLabel = conn.scope ? conn.scope.split(' ').slice(0, 2).join(', ') : '';
      actionHtml = `
        <div class="conn-status">
          <span class="conn-badge connected">Connected</span>
          ${conn.mcpUrl ? `<span class="conn-scope">MCP</span>` : ''}
          ${scopeLabel ? `<span class="conn-scope">${escapeHtml(scopeLabel)}</span>` : ''}
          <button class="btn small conn-disconnect" data-disconnect="${provider.id}">Disconnect</button>
        </div>
      `;
    } else if (isPendingOAuth) {
      actionHtml = `
        <div class="conn-status">
          <span class="spinner"></span>
          <span class="conn-pending">Waiting for browser authorization…</span>
        </div>
      `;
    } else {
      actionHtml = `
        <div class="conn-status">
          <button class="btn small primary conn-connect" data-connect="${provider.id}">
            Connect with browser
          </button>
        </div>
      `;
    }
  } else if (hasToken) {
    // Non-OAuth token-based (Devin)
    actionHtml = `
      <div class="conn-status">
        <button class="btn small conn-token-toggle" data-token-toggle="${provider.id}">API Token</button>
      </div>
      <div class="conn-token-config hidden" data-token-config="${provider.id}">
        <input type="password" class="conn-token-input" data-token-input="${provider.id}" placeholder="${provider.tokenLabel} (${provider.tokenHint})">
        <button class="btn small conn-token-save" data-token-save="${provider.id}">Save</button>
      </div>
    `;
  } else if (provider.id === 'claude' || provider.id === 'opencode') {
    actionHtml = `
      <div class="conn-status">
        <span class="conn-unavailable">Local discovery only</span>
      </div>
    `;
  }

  return `
    <div class="source-entry" data-source="${provider.id}">
      <div class="source-icon-label" style="${provider.color ? `--provider-color: ${provider.color}` : ''}">
        <span class="source-icon">${provider.icon}</span>
        <span class="source-name">${provider.name}</span>
      </div>
      <div class="source-items">
        ${actionHtml}
        ${scanItems.length > 0 ? `
          <div class="scan-items">
            ${scanItems.slice(0, 5).map((item) => `
              <div class="scan-item" title="${escapeHtml(item.label)}">
                <span>${escapeHtml(item.label)}</span>
              </div>
            `).join('')}
            ${scanItems.length > 5 ? `<div class="scan-item-more">+${scanItems.length - 5} more</div>` : ''}
          </div>
        ` : ''}
        ${scanErrors.length > 0 ? `
          <div class="scan-errors">
            ${scanErrors.map((e) => `<div class="scan-error">⚠ ${escapeHtml(e)}</div>`).join('')}
          </div>
        ` : ''}
      </div>
    </div>
  `;
}

function renderTaskList(containerId, tasks, listType) {
  const container = document.getElementById(containerId);
  if (!tasks.length) {
    const msg = listType === 'active' ? 'No active tasks. Create one!' :
                listType === 'notStarted' ? 'No pending tasks.' : 'No completed tasks.';
    container.innerHTML = `<div class="empty-state">${msg}</div>`;
    return;
  }

  container.innerHTML = tasks.map((t) => renderTaskCard(t, listType)).join('');
}

function renderTaskCard(task, listType) {
  const isSelected = state.selected.has(task.id);
  const isCompleted = task.status === 'completed';
  const hasSource = task.sourceUrl;
  const indent = task.parentId ? ' style="margin-left: 20px;"' : '';

  const priorityLabel = task.priority ? task.priority.charAt(0).toUpperCase() + task.priority.slice(1) : '';
  const priorityClass = task.priority ? `priority-${task.priority}` : '';

  const dueLabel = task.dueDate ? `Due: ${new Date(task.dueDate).toLocaleDateString()}` : '';
  const estLabel = task.estRemaining ? `${task.estRemaining}` : '';
  const sourceLabel = task.sourceType ? task.sourceType : '';

  return `
    <div class="task-card ${task.status} ${isCompleted ? 'completed' : ''} ${isSelected ? 'selected' : ''}" data-id="${task.id}"${indent}>
      <input type="checkbox" class="checkbox" data-id="${task.id}" ${isSelected ? 'checked' : ''}>
      <div class="task-body">
        <div>
          <span class="task-title${hasSource ? ' source-link' : ''}" data-id="${task.id}" data-action="${hasSource ? 'openSource' : 'edit'}">
            ${escapeHtml(task.title)}
            ${hasSource ? '<span class="source-icon">↗</span>' : ''}
          </span>
          <span class="status-badge ${task.status}">${task.status.replace(/_/g, ' ')}</span>
        </div>
        <div class="task-meta">
          ${priorityLabel ? `<span class="${priorityClass}">${priorityLabel}</span>` : ''}
          ${dueLabel ? `<span>${dueLabel}</span>` : ''}
          ${estLabel ? `<span>${estLabel}</span>` : ''}
          ${sourceLabel ? `<span>${sourceLabel}</span>` : ''}
        </div>
      </div>
      <div class="task-actions">
        ${task.status !== 'in_progress' && task.status !== 'completed' ? `<button class="btn small" data-id="${task.id}" data-action="start">Start</button>` : ''}
        ${task.status !== 'not_started' && task.status !== 'completed' ? `<button class="btn small" data-id="${task.id}" data-action="pause">Pause</button>` : ''}
        ${!isCompleted ? `<button class="btn small" data-id="${task.id}" data-action="complete">✓</button>` : ''}
        <button class="btn small" data-id="${task.id}" data-action="subtask">+Sub</button>
        <button class="btn small danger" data-id="${task.id}" data-action="delete">✕</button>
      </div>
    </div>
  `;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

// ─── Event handling ───────────────────────────────────────────────────────
function setupEventListeners() {
  // Task list clicks (delegated)
  document.addEventListener('click', (e) => {
    const checkbox = e.target.closest('.checkbox');
    if (checkbox) {
      handleCheckbox(checkbox.dataset.id);
      return;
    }

    const titleEl = e.target.closest('.task-title');
    if (titleEl && titleEl.dataset.action === 'openSource') {
      handleOpenSource(titleEl.dataset.id);
      return;
    }
    if (titleEl && titleEl.dataset.action === 'edit') {
      handleInlineEdit(titleEl);
      return;
    }

    const btn = e.target.closest('[data-action]');
    if (!btn) return;

    const id = btn.dataset.id;
    const action = btn.dataset.action;

    switch (action) {
      case 'start': handleStartTask(id); break;
      case 'pause': handlePauseTask(id); break;
      case 'complete': handleCompleteTask(id); break;
      case 'delete': handleDeleteTask(id); break;
      case 'subtask': handleCreateSubtask(id); break;
    }
  });

  // Connection OAuth handlers
  document.addEventListener('click', (e) => {
    const connectBtn = e.target.closest('[data-connect]');
    if (connectBtn) {
      handleConnect(connectBtn.dataset.connect);
      return;
    }

    const disconnectBtn = e.target.closest('[data-disconnect]');
    if (disconnectBtn) {
      handleDisconnect(disconnectBtn.dataset.disconnect);
      return;
    }

    // App setup toggle (for Slack-style providers)
    const setupBtn = e.target.closest('[data-setup]');
    if (setupBtn) {
      const providerId = setupBtn.dataset.setup;
      const configEl = document.querySelector(`[data-setup-config="${providerId}"]`);
      if (configEl) {
        configEl.classList.toggle('hidden');
      }
      return;
    }

    // Client ID + Secret save (for Slack — non-DCR OAuth providers)
    const clientSaveBtn = e.target.closest('[data-client-save]');
    if (clientSaveBtn) {
      const providerId = clientSaveBtn.dataset.clientSave;
      const clientInput = document.querySelector(`[data-client-input="${providerId}"]`);
      const secretInput = document.querySelector(`[data-secret-input="${providerId}"]`);
      if (clientInput && clientInput.value.trim()) {
        handleSaveClientCredentials(providerId, clientInput.value.trim(), secretInput?.value?.trim() || '');
        clientInput.value = '';
        if (secretInput) secretInput.value = '';
        const configEl = document.querySelector(`[data-setup-config="${providerId}"]`);
        if (configEl) configEl.classList.add('hidden');
      } else {
        showToast('Client ID is required', 'error');
      }
      return;
    }
  });

  // API token configuration (for Devin — non-OAuth source)
  document.addEventListener('click', (e) => {
    const tokenToggle = e.target.closest('[data-token-toggle]');
    if (tokenToggle) {
      const sid = tokenToggle.dataset.tokenToggle;
      const configEl = document.querySelector(`[data-token-config="${sid}"]`);
      if (configEl) configEl.classList.toggle('hidden');
      return;
    }

    const tokenSave = e.target.closest('[data-token-save]');
    if (tokenSave) {
      const sid = tokenSave.dataset.tokenSave;
      const input = document.querySelector(`[data-token-input="${sid}"]`);
      if (input && input.value.trim()) {
        handleSaveSourceToken(sid, input.value.trim());
        input.value = '';
        const configEl = document.querySelector(`[data-token-config="${sid}"]`);
        if (configEl) configEl.classList.add('hidden');
      }
      return;
    }
  });

  // Collapsible sections
  document.addEventListener('click', (e) => {
    const title = e.target.closest('.section-title.collapsible');
    if (!title) return;
    const targetId = title.dataset.target;
    const list = document.getElementById(targetId);
    const toggle = title.querySelector('.collapse-toggle');
    if (list) {
      list.classList.toggle('collapsed');
      if (toggle) toggle.classList.toggle('open');
    }
  });

  // New task modal
  document.getElementById('newTaskBtn').addEventListener('click', showNewTaskModal);
  document.getElementById('cancelNewTask').addEventListener('click', hideNewTaskModal);
  document.getElementById('newTaskForm').addEventListener('submit', handleNewTaskSubmit);

  // Batch toolbar
  document.getElementById('batchCompleteBtn').addEventListener('click', () => handleBatch('complete'));
  document.getElementById('batchSetActiveBtn').addEventListener('click', () => handleBatch('setActive'));
  document.getElementById('batchNotStartedBtn').addEventListener('click', () => handleBatch('setNotStarted'));
  document.getElementById('batchDeleteBtn').addEventListener('click', () => handleBatch('delete'));
  document.getElementById('batchClearBtn').addEventListener('click', clearSelection);

  // Close modal on backdrop click
  document.querySelector('.modal-backdrop').addEventListener('click', hideNewTaskModal);

  // Import
  document.getElementById('importBtn').addEventListener('click', handleImport);

  // Refresh button
  document.getElementById('refreshBtn').addEventListener('click', handleRefresh);

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.key === 'n' && (e.metaKey || e.ctrlKey) && !e.target.closest('input,textarea,select')) {
      e.preventDefault();
      showNewTaskModal();
    }
    if (e.key === 'r' && (e.metaKey || e.ctrlKey) && e.shiftKey && !e.target.closest('input,textarea,select')) {
      e.preventDefault();
      handleRefresh();
    }
  });
}

// ─── Actions ──────────────────────────────────────────────────────────────
async function handleCheckbox(id) {
  if (state.selected.has(id)) {
    state.selected.delete(id);
  } else {
    state.selected.add(id);
  }
  updateBatchToolbar();
  render();
}

function updateBatchToolbar() {
  const toolbar = document.getElementById('batchToolbar');
  const count = state.selected.size;
  if (count > 0) {
    toolbar.classList.remove('hidden');
    document.getElementById('selectedCount').textContent = `${count} selected`;
  } else {
    toolbar.classList.add('hidden');
  }
}

function clearSelection() {
  state.selected.clear();
  updateBatchToolbar();
  render();
}

async function handleBatch(action) {
  if (state.selected.size === 0) return;
  try {
    switch (action) {
      case 'complete':
        await batchAction(state.selected, 'complete');
        showToast(`Completed ${state.selected.size} tasks`, 'success');
        break;
      case 'setActive':
        for (const id of state.selected) {
          await updateTaskApi(id, { status: 'in_progress' });
        }
        showToast(`Activated ${state.selected.size} tasks`, 'success');
        break;
      case 'setNotStarted':
        for (const id of state.selected) {
          await updateTaskApi(id, { status: 'not_started' });
        }
        showToast(`Moved ${state.selected.size} to not started`, 'success');
        break;
      case 'delete':
        await batchAction(state.selected, 'delete');
        showToast(`Deleted ${state.selected.size} tasks`, 'success');
        break;
    }
    clearSelection();
    await loadTasks();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function handleStartTask(id) {
  try {
    await updateTaskApi(id, { status: 'in_progress' });
    await loadTasks();
    showToast('Task started', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function handlePauseTask(id) {
  try {
    await updateTaskApi(id, { status: 'not_started' });
    await loadTasks();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function handleCompleteTask(id) {
  try {
    await updateTaskApi(id, { status: 'completed' });
    await loadTasks();
    showToast('Task completed', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function handleDeleteTask(id) {
  if (!confirm('Delete this task and its subtasks?')) return;
  try {
    await deleteTask(id);
    clearSelection();
    await loadTasks();
    showToast('Task deleted', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

function handleOpenSource(id) {
  const task = state.tasks.find((t) => t.id === id);
  if (task && task.sourceUrl) {
    window.open(task.sourceUrl, '_blank');
  }
}

function handleInlineEdit(titleEl) {
  const id = titleEl.dataset.id;
  const task = state.tasks.find((t) => t.id === id);
  if (!task) return;

  const currentText = titleEl.textContent.trim().replace('↗', '').trim();
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'task-title-edit';
  input.value = currentText;
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const save = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== currentText) {
      try {
        await updateTaskApi(id, { title: newTitle });
        await loadTasks();
      } catch (err) {
        showToast(`Error: ${err.message}`, 'error');
      }
    } else {
      render();
    }
  };

  input.addEventListener('blur', save);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { input.blur(); }
    if (e.key === 'Escape') { render(); }
  });
}

async function handleCreateSubtask(parentId) {
  const title = prompt('Subtask title:');
  if (!title || !title.trim()) return;
  try {
    await createTask({ title: title.trim(), parentId, status: 'not_started' });
    await loadTasks();
    showToast('Subtask created', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─── API token management (Slack, Devin, … non-OAuth direct sources) ─────
async function handleSaveSourceToken(sourceId, token) {
  try {
    const body = { keys: { [sourceId]: token } };
    await api('/sources/keys', { method: 'POST', body: JSON.stringify(body) });
    showToast(`${PROVIDERS[sourceId]?.name || sourceId} token saved`, 'success');
    await handleRefresh();
  } catch (err) {
    showToast(`Failed to save token: ${err.message}`, 'error');
  }
}

// ─── Slack app credential management ────────────────────────────────────
async function handleSaveClientCredentials(providerId, clientId, clientSecret) {
  try {
    // Direct OAuth setup route (clientId required; secret optional for PKCE).
    await api(`/auth/setup/${providerId}`, {
      method: 'POST',
      body: JSON.stringify({ clientId, clientSecret: clientSecret || null }),
    });
    showToast(`${PROVIDERS[providerId]?.name || providerId} app configured`, 'success');

    // Reload connections to update the UI with "Sign in with Slack" button
    await loadConnections();
    render();

    // Now automatically start the OAuth flow
    if (providerId === 'slack') {
      await handleConnect('slack');
    } else {
      await handleConnect(providerId);
    }
  } catch (err) {
    showToast(`Failed to save credentials: ${err.message}`, 'error');
  }
}

// ─── Refresh (scan sources) ──────────────────────────────────────────────
let _scanInFlight = false;

async function handleRefresh({ silent = false } = {}) {
  if (_scanInFlight) return false;
  _scanInFlight = true;

  const refreshBtn = document.getElementById('refreshBtn');
  const loadingEl = document.getElementById('sourcesLoading');
  const panel = document.getElementById('sourcesPanel');

  if (!silent) {
    refreshBtn.disabled = true;
    refreshBtn.textContent = '⟳ Scanning…';
  }
  loadingEl.classList.remove('hidden');
  panel.classList.remove('collapsed');

  const sourcesHeader = document.querySelector('[data-target="sourcesPanel"] .collapse-toggle');
  if (sourcesHeader) sourcesHeader.classList.add('open');

  try {
    const data = await api('/sources/scan', { method: 'POST', body: '{}' });
    state.sources = data;
    render();
    // Reload tasks so newly ingested/classified source items appear immediately.
    await loadTasks();
    if (!silent) {
      const ai = data.aiConfigured ? ' · AI ready' : '';
      const enqueued = data.ingestion?.enqueue?.enqueued;
      const enqueueMsg = Number.isFinite(enqueued) && enqueued > 0 ? ` (${enqueued} to classify)` : '';
      showToast(`Scan complete${ai}${enqueueMsg}`, 'success');
    }
    return true;
  } catch (err) {
    if (!silent) showToast(`Scan error: ${err.message}`, 'error');
    return false;
  } finally {
    _scanInFlight = false;
    if (!silent) {
      refreshBtn.disabled = false;
      refreshBtn.textContent = '⟳ Refresh';
    }
    loadingEl.classList.add('hidden');
  }
}

// ─── Focus-aware auto-scan ───────────────────────────────────────────────
// Policy: scan every 5 minutes only while the app window is focused and the
// page is visible. When unfocused/hidden nothing is scheduled. When the app is
// refocused, run a single scan immediately (debounced against focus flicker).
const AUTO_SCAN_MS = 5 * 60 * 1000;
const AUTO_SCAN_DEBOUNCE_MS = 5 * 1000;
let _autoScanTimer = null;
let _lastAutoScanAt = 0;

function appIsActive() {
  return document.visibilityState === 'visible' && document.hasFocus();
}

function stopAutoScan() {
  if (_autoScanTimer) {
    clearTimeout(_autoScanTimer);
    _autoScanTimer = null;
  }
}

function scheduleNextAutoScan() {
  stopAutoScan();
  _autoScanTimer = setTimeout(() => {
    _autoScanTimer = null;
    if (appIsActive()) {
      void maybeAutoScan();
    }
    // If the app went inactive, do nothing: the focus/visibility listener
    // re-arms (and scans once) when the user comes back.
  }, AUTO_SCAN_MS);
}

async function maybeAutoScan() {
  const now = Date.now();
  if (now - _lastAutoScanAt < AUTO_SCAN_DEBOUNCE_MS) {
    // Focus flicker (e.g. Cmd+Tab round-trip) — skip, keep cadence.
    scheduleNextAutoScan();
    return;
  }
  if (!appIsActive()) return;
  _lastAutoScanAt = now;
  try {
    await handleRefresh({ silent: true });
  } finally {
    scheduleNextAutoScan();
  }
}

function handleAppFocusChange() {
  if (appIsActive()) {
    // Just became active/focused → scan once, then resume the 5-min cadence.
    void maybeAutoScan();
  } else {
    // Went background/unfocused → stop any pending scan.
    stopAutoScan();
  }
}

function initAutoScan() {
  window.addEventListener('focus', handleAppFocusChange);
  window.addEventListener('blur', handleAppFocusChange);
  document.addEventListener('visibilitychange', handleAppFocusChange);
  // On first load, just arm the cadence (the explicit Refresh button and any
  // focus change already cover an immediate first scan).
  scheduleNextAutoScan();
}

// ─── New Task Modal ──────────────────────────────────────────────────────
function showNewTaskModal() {
  const modal = document.getElementById('newTaskModal');
  modal.classList.remove('hidden');
  document.getElementById('taskTitle').value = '';
  document.getElementById('taskDescription').value = '';
  document.getElementById('taskPriority').value = 'medium';

  const parentSelect = document.getElementById('taskParent');
  parentSelect.innerHTML = '<option value="">None (root)</option>';
  const candidates = state.tasks.filter((t) => t.status !== 'completed' && t.status !== 'cancelled');
  for (const t of candidates) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.title;
    parentSelect.appendChild(opt);
  }

  setTimeout(() => document.getElementById('taskTitle').focus(), 100);
}

function hideNewTaskModal() {
  document.getElementById('newTaskModal').classList.add('hidden');
}

async function handleNewTaskSubmit(e) {
  e.preventDefault();
  const title = document.getElementById('taskTitle').value.trim();
  if (!title) return;

  try {
    await createTask({
      title,
      description: document.getElementById('taskDescription').value.trim(),
      priority: document.getElementById('taskPriority').value,
      parentId: document.getElementById('taskParent').value || null,
      status: 'not_started',
    });
    hideNewTaskModal();
    await loadTasks();
    showToast('Task created', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

// ─── Import ──────────────────────────────────────────────────────────────
async function handleImport() {
  try {
    const legacyData = localStorage.getItem('task-juggler:tasks:v1');
    if (!legacyData) {
      showToast('No legacy data found in localStorage', 'error');
      return;
    }
    const tasks = JSON.parse(legacyData);
    if (!Array.isArray(tasks) || tasks.length === 0) {
      showToast('No tasks to import', 'error');
      return;
    }
    const result = await api('/import', { method: 'POST', body: JSON.stringify({ tasks }) });
    showToast(`Imported ${result.imported} tasks (${result.skipped} skipped)`, 'success');
    await loadTasks();
  } catch (err) {
    showToast(`Import error: ${err.message}`, 'error');
  }
}

// ─── Toast ───────────────────────────────────────────────────────────────
function showToast(message, type = 'info') {
  let toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.className = `show ${type}`;
  clearTimeout(toast._hideTimer);
  toast._hideTimer = setTimeout(() => {
    toast.classList.remove('show');
  }, 3000);
}

// ─── Init ────────────────────────────────────────────────────────────────
async function init() {
  try {
    await loadConnections();
    await loadTasks();
  } catch (err) {
    document.getElementById('activeList').innerHTML =
      `<div class="empty-state">Could not connect to server (http://localhost:3000).<br>Make sure the server is running.</div>`;
  }
  setupEventListeners();
  initAutoScan();
}

init();