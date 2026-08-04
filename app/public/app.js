// Task Juggler - Local-First Frontend Application

const API_BASE = '/api';

let state = { tasks: [], tree: [], counts: {}, selected: new Set(), sources: null };

// --- API helpers ---
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

async function updateTask(id, body) {
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

// --- UI helpers ---
function prioritize(tasks) {
  const score = (t) => {
    let s = 0;
    if (t.ballInUsersCourt) s += 100;
    if (t.status === 'in_progress') s += 80;
    if (t.priority === 'urgent') s += 40;
    if (t.priority === 'high') s += 20;
    if (t.dueDate) {
      const days = (new Date(t.dueDate) - new Date()) / (1000*60*60*24);
      if (days <= 0) s += 50;
      else if (days <= 2) s += 30;
      else if (days <= 7) s += 10;
    }
    return s;
  };
  return [...tasks].sort((a, b) => score(b) - score(a));
}

function partitionTasks() {
  const active = [];
  const notStarted = [];
  const completed = [];

  function walk(node) {
    if (node.status === 'completed') {
      completed.push(node);
    } else if (node.status === 'not_started') {
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

// --- Source label / icon helpers ---
const SOURCE_META = {
  slack:  { icon: '💬', label: 'Slack', keyLabel: 'SLACK_BOT_TOKEN', keyHint: 'xoxb-...' },
  linear: { icon: '⬡', label: 'Linear', keyLabel: 'LINEAR_API_KEY', keyHint: 'lin_api_...' },
  todoist:{ icon: '✓', label: 'Todoist', keyLabel: 'TODOIST_API_TOKEN', keyHint: '...' },
  devin:  { icon: 'Δ', label: 'Devin', keyLabel: 'DEVIN_API_TOKEN', keyHint: '...' },
  claude: { icon: '✦', label: 'Claude/Cowork' },
};

// Stored API keys (in-memory on frontend, sent with each scan)
let _apiKeys = {};

// Load any saved keys from the server on init
async function loadApiKeys() {
  try {
    const data = await api('/sources/keys');
    if (data.keys) {
      for (const [sid, info] of Object.entries(data.keys)) {
        if (info.configured) _apiKeys[sid] = true; // mark as configured (actual key is server-side)
      }
    }
  } catch { /* server may be starting up */ }
}

// --- Render ---
function render() {
  const { active, notStarted, completed } = partitionTasks();

  renderTaskList('activeList', active, 'active');
  renderTaskList('notStartedList', notStarted, 'notStarted');
  renderTaskList('completedList', completed, 'completed');

  // Count badges
  const notStartedEl = document.getElementById('notStartedList');
  document.getElementById('notStartedCount').textContent = notStarted.length;
  document.getElementById('completedCount').textContent = completed.length;

  // Active count in header
  const total = active.length + notStarted.length;
  document.getElementById('taskCount').textContent = `${active.length} active${notStarted.length > 0 ? ` + ${notStarted.length} pending` : ''}`;

  // Collapse state persists
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
  if (!state.sources) {
    container.innerHTML = '<div class="source-entry"><div class="source-empty">Click Refresh to scan for new tasks from Slack, Linear, Todoist, and Devin.</div></div>';
    document.getElementById('sourcesSummary').textContent = '';
    return;
  }

  const results = state.sources.results || {};
  const entries = Object.entries(results);
  const totalErrors = entries.filter(([, r]) => (r.errors || []).length > 0).length;
  const totalItems = entries.reduce((sum, [, r]) => sum + (r.items || []).length, 0);

  document.getElementById('sourcesSummary').textContent =
    `${totalItems} found${totalErrors > 0 ? `, ${totalErrors} with errors` : ''}`;

  container.innerHTML = entries.map(([sourceId, result]) => {
    const meta = SOURCE_META[sourceId] || { icon: '?', label: sourceId };
    const errors = result.errors || [];
    const items = result.items || [];
    const hasKeys = !!_apiKeys[sourceId];
    const statusClass = errors.length > 0 ? 'error' : (result.status || 'ok');

    // Only show configure option for sources that support direct API keys
    const showConfig = meta.keyLabel && ['slack', 'linear', 'todoist', 'devin'].includes(sourceId);

    return `
      <div class="source-entry" data-source="${sourceId}">
        <div class="source-icon-label">
          <span>${meta.icon}</span>
          <span>${meta.label}</span>
          <span class="source-status ${statusClass}">${statusClass}</span>
          ${hasKeys ? '<span class="source-status ok" style="margin-left:4px;">key set</span>' : ''}
          ${showConfig ? `<button class="btn small source-config-btn" data-source="${sourceId}" style="margin-left:4px;">🔑</button>` : ''}
        </div>
        <div class="source-items">
          ${showConfig ? `
            <div class="source-key-config hidden" data-source="${sourceId}" id="key-config-${sourceId}">
              <input type="password" class="source-key-input" data-source="${sourceId}" placeholder="${meta.keyLabel} (${meta.keyHint})" style="width:100%;padding:4px 8px;margin-bottom:4px;background:var(--bg);border:1px solid var(--border);border-radius:3px;color:var(--text);font-size:0.8rem;">
              <button class="btn small source-key-save" data-source="${sourceId}" style="margin-bottom:6px;">Save Key</button>
            </div>
          ` : ''}
          ${items.length === 0 && errors.length === 0
            ? `<div class="source-empty">No items found.</div>`
            : items.map((item) => `
              <div class="source-item">
                <span class="item-label" title="${escapeHtml(item.label)}">${escapeHtml(item.label)}</span>
                ${item.outcome ? `<span class="item-outcome ${item.outcome}">${item.outcome}</span>` : ''}
              </div>
            `).join('')
          }
          ${errors.length > 0 ? `
            <div class="source-errors">
              ${errors.map((e) => `<div class="source-error">⚠ ${escapeHtml(e)}</div>`).join('')}
            </div>
          ` : ''}
        </div>
      </div>
    `;
  }).join('');
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

// --- Event handling ---
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

  // Refresh button — scan all sources
  document.getElementById('refreshBtn').addEventListener('click', handleRefresh);

  // API key configuration (delegated)
  document.addEventListener('click', (e) => {
    const configBtn = e.target.closest('.source-config-btn');
    if (configBtn) {
      const sid = configBtn.dataset.source;
      const configEl = document.getElementById(`key-config-${sid}`);
      if (configEl) configEl.classList.toggle('hidden');
      return;
    }
    const saveBtn = e.target.closest('.source-key-save');
    if (saveBtn) {
      const sid = saveBtn.dataset.source;
      const input = document.querySelector(`.source-key-input[data-source="${sid}"]`);
      if (input && input.value.trim()) {
        handleSaveApiKey(sid, input.value.trim());
        input.value = '';
        const configEl = document.getElementById(`key-config-${sid}`);
        if (configEl) configEl.classList.add('hidden');
      }
      return;
    }
  });

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

// --- Actions ---
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
          await updateTask(id, { status: 'in_progress' });
        }
        showToast(`Activated ${state.selected.size} tasks`, 'success');
        break;
      case 'setNotStarted':
        for (const id of state.selected) {
          await updateTask(id, { status: 'not_started' });
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
    await updateTask(id, { status: 'in_progress' });
    await loadTasks();
    showToast('Task started', 'success');
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function handlePauseTask(id) {
  try {
    await updateTask(id, { status: 'not_started' });
    await loadTasks();
  } catch (err) {
    showToast(`Error: ${err.message}`, 'error');
  }
}

async function handleCompleteTask(id) {
  try {
    await updateTask(id, { status: 'completed' });
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
        await updateTask(id, { title: newTitle });
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

// --- API key management ---
async function handleSaveApiKey(sourceId, key) {
  try {
    // First save to server (persists in memory)
    const body = { keys: { [sourceId]: key } };
    await api('/sources/keys', { method: 'POST', body: JSON.stringify(body) });
    _apiKeys[sourceId] = key;
    showToast(`${SOURCE_META[sourceId]?.label || sourceId} API key saved`, 'success');
    // Immediately scan with the new key
    await handleRefresh();
  } catch (err) {
    showToast(`Failed to save key: ${err.message}`, 'error');
  }
}

// --- Refresh (scan sources) ---
async function handleRefresh() {
  const refreshBtn = document.getElementById('refreshBtn');
  const loadingEl = document.getElementById('sourcesLoading');
  const panel = document.getElementById('sourcesPanel');

  refreshBtn.disabled = true;
  refreshBtn.textContent = '⟳ Scanning…';
  loadingEl.classList.remove('hidden');
  panel.classList.remove('collapsed');

  // Expand the sources panel if it was collapsed
  const sourcesHeader = document.querySelector('[data-target="sourcesPanel"] .collapse-toggle');
  if (sourcesHeader) sourcesHeader.classList.add('open');

  try {
    // Keys saved server-side are used automatically — no need to send them
    // from the frontend. Only send keys if the user just entered them via
    // handleSaveApiKey (that function calls handleRefresh with the new key).
    const data = await api('/sources/scan', { method: 'POST', body: '{}' });
    state.sources = data;
    render();
    showToast('Scan complete', 'success');
  } catch (err) {
    showToast(`Scan error: ${err.message}`, 'error');
  } finally {
    refreshBtn.disabled = false;
    refreshBtn.textContent = '⟳ Refresh';
    loadingEl.classList.add('hidden');
  }
}

// --- New Task Modal ---
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

// --- Import ---
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

// --- Toast ---
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

// --- Init ---
async function init() {
  try {
    await loadApiKeys();
    await loadTasks();
  } catch (err) {
    document.getElementById('activeList').innerHTML =
      `<div class="empty-state">Could not connect to server (http://localhost:3000).<br>Make sure the server is running.</div>`;
  }
  setupEventListeners();
}

init();