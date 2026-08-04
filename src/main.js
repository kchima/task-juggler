import { createApp } from './app.js';
import { renderList, renderCard, nextStatus, renderErrors, renderCandidates, buildDebugSnapshot } from './ui.js';
import { mergeSeedTasks, readSeedFromDocument } from './seedMerge.js';
import { loadTasks, saveTasks } from './storage.js';
import { sortTasks } from './scoring.js';

const DEFAULT_TOOL_NAMES = {
  slackReadThread: '',
  slackSearch: '',
  linearWorkspaces: {},
  todoistFindTasks: '',
};

// Reads and validates connector configuration from the dedicated JSON block
// in the artifact shell. Returns null when the block is absent, blank, or
// contains invalid JSON, so callers fall back to window.__JUGGLER_TOOL_NAMES__
// (existing injected artifacts) then DEFAULT_TOOL_NAMES.
export function readToolConfig(doc = globalThis.document) {
  const el = doc?.getElementById('juggler-tool-config');
  if (!el) return null;
  const raw = el.textContent?.trim();
  if (!raw) return null;
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  return parsed;
}

// Validates and normalises a tool-config object, discarding unrecognised
// fields and substituting defaults for recognised fields with invalid types.
// Returns a complete tool-names object matching DEFAULT_TOOL_NAMES shape.
export function validateToolConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) return null;
  const result = { ...DEFAULT_TOOL_NAMES };
  if (typeof config.slackReadThread === 'string') result.slackReadThread = config.slackReadThread;
  if (typeof config.slackSearch === 'string') result.slackSearch = config.slackSearch;
  if (typeof config.todoistFindTasks === 'string') result.todoistFindTasks = config.todoistFindTasks;
  if (config.linearWorkspaces && typeof config.linearWorkspaces === 'object' && !Array.isArray(config.linearWorkspaces)) {
    const workspaces = {};
    for (const [label, prefix] of Object.entries(config.linearWorkspaces)) {
      if (typeof label === 'string' && typeof prefix === 'string') {
        workspaces[label] = prefix;
      }
    }
    result.linearWorkspaces = workspaces;
  }
  return result;
}

// Resolves the effective tool configuration from available sources in order:
//   1. Valid config from the #juggler-tool-config JSON block (new artifacts)
//   2. Legacy window.__JUGGLER_TOOL_NAMES__ global (existing artifacts)
//   3. Static DEFAULT_TOOL_NAMES (all connectors disabled)
// A blank or missing config block does not override the legacy global;
// an explicit {} config block (valid but empty) intentionally disables all
// sources even when a legacy global exists.
function resolveToolConfig(doc) {
  const config = readToolConfig(doc);
  const legacy = typeof globalThis.__JUGGLER_TOOL_NAMES__ === 'object'
    && globalThis.__JUGGLER_TOOL_NAMES__ !== null
    ? globalThis.__JUGGLER_TOOL_NAMES__
    : null;
  if (config !== null) {
    // Config block was present and parsed: use it (may be empty {} -> all disabled)
    return validateToolConfig(config);
  }
  if (legacy !== null) {
    // No config block; fall back to legacy global
    return validateToolConfig(legacy);
  }
  return { ...DEFAULT_TOOL_NAMES };
}

// Claude session discovery doesn't run from inside the artifact at all — a
// live probe confirmed session-listing tools are blocked at the
// artifact-bridge layer even when correctly configured (see SKILL.md). This
// is what the "Claude" column in the candidates panel always shows instead
// of a live per-scan result, since there's nothing here to report.
const CLAUDE_SESSIONS_INFO = [{
  key: 'claude:chat-only',
  label: 'Tracked via Cowork chat, not this artifact — ask chat to "scan my Claude sessions" (see SKILL.md)',
  outcome: 'info',
}];

// While the artifact is open and visible, check for updates and new
// candidates automatically — no scheduled task or background service
// required, since this is just a normal setInterval inside the artifact's
// own JS, using the same MCP access it already has.
const AUTO_REFRESH_MS = 5 * 60 * 1000;

export function mountApp(doc, app, options = {}) {
  // Auto-refresh is opt-in (null by default) so existing/new tests never spin
  // up a real interval unintentionally — the real boot() below turns it on
  // with a sensible interval. Visibility-checked so it doesn't do work while
  // the artifact tab/panel isn't actually open.
  const { autoRefreshMs = null, offline = false, aiUnavailable = false } = options;
  let viewMode = 'list';
  let cardQueue = [];
  let cardIndex = 0;

  function activeIds(tasks) {
    // Card view exists to surface the single best next thing to do, so its
    // initial queue order must match the same priority tiering as list view
    // (not raw insertion order).
    return sortTasks(tasks).map((t) => t.id);
  }

  function render() {
    const tasks = app.getTasks();
    const listEl = doc.getElementById('jg-list');
    const cardEl = doc.getElementById('jg-card');

    if (viewMode === 'list') {
      listEl.hidden = false;
      cardEl.hidden = true;
      renderList(listEl, tasks, handlers);
    } else {
      listEl.hidden = true;
      cardEl.hidden = false;
      if (!cardQueue.length) cardQueue = activeIds(tasks);
      const id = cardQueue.length ? cardQueue[cardIndex % cardQueue.length] : null;
      renderCard(cardEl, tasks.find((t) => t.id === id) ?? null, handlers);
    }
  }

  const handlers = {
    onCycleStatus(id) { app.cycleStatusManual(id, nextStatus); render(); },
    onDelete(id) { app.remove(id); render(); },
    onReopen(id) { app.reopen(id); render(); },
    async onRefreshOne(id) { await app.refreshOne(id); render(); },
    onSkip(id) {
      const pos = cardQueue.indexOf(id);
      if (pos !== -1) cardQueue.push(cardQueue.splice(pos, 1)[0]);
      cardIndex = cardQueue.length ? cardIndex % cardQueue.length : 0;
      render();
    },
  };

  doc.getElementById('jg-add-btn').addEventListener('click', () => {
    const input = doc.getElementById('jg-add-input');
    const value = input.value.trim();
    if (!value) return;
    if (/^https?:\/\//.test(value)) app.addByLink(value);
    else app.addManualTask(value);
    input.value = '';
    render();
  });

  async function runRefreshAndDiscover(statusPrefix) {
    const statusEl = doc.getElementById('jg-status');
    if (offline) {
      statusEl.textContent = 'Local mode — no connectors available, discovery is off';
      return;
    }
    statusEl.textContent = `${statusPrefix}…`;
    try {
      // In aiUnavailable mode (callMcpTool present but askClaude absent),
      // Linear/Todoist discovery still works; only Slack AI classification
      // is unavailable. The app's runSlackTriage will see askClaude throw
      // and surface that as an error — and the UI reports it as such rather
      // than hiding behind this catch or silently disabling Slack.
      const [refreshResult, discoverResult, slackResult] = await Promise.all([
        app.refreshAll(), app.discoverNewTasks(), app.runSlackTriage(),
      ]);
      const aiCalls = refreshResult.results.filter((r) => r.aiCalled).length + (slackResult.aiCalled ? 1 : 0);
      const addedNote = discoverResult.added ? `, ${discoverResult.added} new` : '';
      const slackNote = slackResult.scanned
        ? `, Slack: ${slackResult.scanned} scanned/${slackResult.ongoing} ongoing/${slackResult.updated} updated/${slackResult.skippedResolved} resolved`
        : '';
      const aiNote = aiUnavailable ? ' [AI unavailable — Slack refresh limited]' : '';
      statusEl.textContent = refreshResult.skipped
        ? 'Just refreshed'
        : `${statusPrefix}ed (${aiCalls} AI call${aiCalls === 1 ? '' : 's'}${addedNote}${slackNote})${aiNote}`;
      renderErrors(doc.getElementById('jg-errors'), [
        ...(refreshResult.errors ?? []),
        ...(discoverResult.errors ?? []),
        ...(slackResult.errors ?? []),
      ]);
      renderCandidates(doc.getElementById('jg-candidates'), {
        slack: slackResult.detected ?? [],
        claude: CLAUDE_SESSIONS_INFO,
        linear: discoverResult.detected?.linear ?? [],
        todoist: discoverResult.detected?.todoist ?? [],
      });
    } catch (err) {
      // A failing connector must never take the list down with it — this
      // catch is now only for something outside every per-source try/catch
      // in app.js (e.g. storage itself failing), which should be rare.
      statusEl.textContent = `Refresh failed: ${err?.message ?? 'unknown error'}`;
      renderErrors(doc.getElementById('jg-errors'), [err?.message ?? 'unknown error']);
    }
    render();
  }

  doc.getElementById('jg-refresh-btn').addEventListener('click', () => runRefreshAndDiscover('Refresh'));

  doc.getElementById('jg-view-toggle').addEventListener('click', () => {
    viewMode = viewMode === 'list' ? 'card' : 'list';
    cardQueue = [];
    cardIndex = 0;
    render();
  });

  // Purely a stored preference — no bridge call involved, so this stays
  // usable even offline. Saved immediately on change; takes effect on the
  // next refresh rather than triggering one itself, so picking a date isn't
  // a surprise network action.
  const lookbackInput = doc.getElementById('jg-lookback-input');
  lookbackInput.max = new Date().toISOString().slice(0, 10); // picking a future date makes no sense
  lookbackInput.value = app.getSlackLookbackDate() ?? '';
  lookbackInput.addEventListener('change', () => {
    app.setSlackLookbackDate(lookbackInput.value);
  });

  // One click instead of "screenshot the errors dropdown, then the
  // candidates panel, then tell me the date field's value" every time
  // something needs reporting. Clipboard access from inside an artifact
  // iframe is unverified — the session_info restriction already showed the
  // sandbox can behave unexpectedly — so this degrades to a visible,
  // selectable textarea rather than assuming writeText works.
  doc.getElementById('jg-copy-debug-btn').addEventListener('click', async () => {
    const text = buildDebugSnapshot(doc);
    const statusEl = doc.getElementById('jg-status');
    const fallback = doc.getElementById('jg-debug-fallback');
    try {
      if (!navigator.clipboard?.writeText) throw new Error('Clipboard API unavailable');
      await navigator.clipboard.writeText(text);
      fallback.hidden = true;
      statusEl.textContent = 'Debug info copied to clipboard';
    } catch {
      fallback.value = text;
      fallback.hidden = false;
      fallback.focus();
      fallback.select();
      statusEl.textContent = 'Clipboard unavailable — select the text below and copy it manually';
    }
  });

  if (autoRefreshMs) {
    setInterval(() => {
      if (doc.visibilityState && doc.visibilityState !== 'visible') return;
      runRefreshAndDiscover('Auto-refresh');
    }, autoRefreshMs);
  }

  render();
  return { render, handlers };
}

// The artifact may be opened somewhere with no MCP bridge at all (a plain
// browser, a preview, a host that exposes a different runtime). Previously
// that threw on `window.cowork.callMcpTool` and killed the whole page. It
// should instead run as a perfectly good local task list: manual add, edit,
// status, dismissal and persistence all work without any bridge — only
// discovery and refresh need one.
// callMcpTool and askClaude are evaluated independently: MCP-only environments
// (callMcpTool present, askClaude absent) can still run Linear and Todoist
// discovery; only Slack AI classification requires askClaude.
function resolveBridge(win) {
  const hasMcp = Boolean(win.cowork?.callMcpTool);
  const hasAi = Boolean(win.cowork?.askClaude);
  const unavailable = async () => {
    throw new Error('No MCP bridge available in this environment');
  };
  return {
    callMcpTool: hasMcp ? win.cowork.callMcpTool : unavailable,
    askClaude: hasAi ? win.cowork.askClaude : unavailable,
    mcpAvailable: hasMcp,
    aiAvailable: hasAi,
  };
}

function boot() {
  const seeds = readSeedFromDocument(document);
  if (seeds.length) {
    saveTasks(mergeSeedTasks(loadTasks(window.localStorage), seeds), window.localStorage);
  }
  const bridge = resolveBridge(window);
  const app = createApp({
    storage: window.localStorage,
    callMcpTool: bridge.callMcpTool,
    askClaude: bridge.askClaude,
    toolNames: resolveToolConfig(document),
  });
  const connected = bridge.mcpAvailable || bridge.aiAvailable;
  mountApp(document, app, {
    autoRefreshMs: connected ? AUTO_REFRESH_MS : null,
    offline: !bridge.mcpAvailable && !bridge.aiAvailable,
    aiUnavailable: !bridge.aiAvailable && bridge.mcpAvailable,
  });
}

if (typeof window !== 'undefined' && !window.__JUGGLER_TEST__) {
  // The script may execute before OR after DOMContentLoaded has already fired
  // (e.g. a host environment that injects this script into an already-parsed
  // document), so check readyState instead of unconditionally waiting for an
  // event that might never come.
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
}
