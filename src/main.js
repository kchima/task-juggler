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
  const { autoRefreshMs = null, offline = false } = options;
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
      const [refreshResult, discoverResult, slackResult] = await Promise.all([
        app.refreshAll(), app.discoverNewTasks(), app.runSlackTriage(),
      ]);
      const aiCalls = refreshResult.results.filter((r) => r.aiCalled).length + (slackResult.aiCalled ? 1 : 0);
      const addedNote = discoverResult.added ? `, ${discoverResult.added} new` : '';
      const slackNote = slackResult.scanned
        ? `, Slack: ${slackResult.scanned} scanned/${slackResult.ongoing} ongoing/${slackResult.updated} updated/${slackResult.skippedResolved} resolved`
        : '';
      statusEl.textContent = refreshResult.skipped
        ? 'Just refreshed'
        : `${statusPrefix}ed (${aiCalls} AI call${aiCalls === 1 ? '' : 's'}${addedNote}${slackNote})`;
      renderErrors(doc.getElementById('jg-errors'), [
        ...(refreshResult.errors ?? []),
        ...(discoverResult.errors ?? []),
        ...(slackResult.errors ?? []),
      ]);
      renderCandidates(doc.getElementById('jg-candidates'), {
        slack: slackResult.detected ?? [],
        claude: CLAUDE_SESSIONS_INFO,
        linear: discoverResult.detected?.linear ?? [],
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
function resolveBridge(win) {
  if (win.cowork?.callMcpTool && win.cowork?.askClaude) {
    return { callMcpTool: win.cowork.callMcpTool, askClaude: win.cowork.askClaude, connected: true };
  }
  const unavailable = async () => {
    throw new Error('No MCP bridge available in this environment');
  };
  return { callMcpTool: unavailable, askClaude: unavailable, connected: false };
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
    toolNames: window.__JUGGLER_TOOL_NAMES__ ?? DEFAULT_TOOL_NAMES,
  });
  mountApp(document, app, {
    autoRefreshMs: bridge.connected ? AUTO_REFRESH_MS : null,
    offline: !bridge.connected,
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
