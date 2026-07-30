import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountApp } from '../src/main.js';

function domFixture() {
  document.body.innerHTML = `
    <details id="jg-errors" hidden><summary></summary><ul></ul></details>
    <details id="jg-candidates">
      <summary></summary>
      <details data-group="slack"><summary></summary><ul></ul></details>
      <details data-group="claude"><summary></summary><ul></ul></details>
      <details data-group="linear"><summary></summary><ul></ul></details>
    </details>
    <input id="jg-add-input" />
    <button id="jg-add-btn"></button>
    <button id="jg-view-toggle"></button>
    <button id="jg-refresh-btn"></button>
    <button id="jg-probe-btn"></button>
    <span id="jg-status"></span>
    <details id="jg-probe" hidden><summary></summary><ul></ul></details>
    <div id="jg-list"></div>
    <div id="jg-card" hidden></div>
  `;
}

function fakeApp(overrides = {}) {
  return {
    getTasks: vi.fn().mockReturnValue([]),
    refreshAll: vi.fn().mockResolvedValue({ skipped: false, results: [] }),
    refreshOne: vi.fn().mockResolvedValue(null),
    discoverNewTasks: vi.fn().mockResolvedValue({ added: 0 }),
    runSlackTriage: vi.fn().mockResolvedValue({
      skipped: false, scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false,
    }),
    probeSessionTools: vi.fn().mockResolvedValue([]),
    addManualTask: vi.fn(),
    addByLink: vi.fn(),
    cycleStatusManual: vi.fn(),
    reopen: vi.fn(),
    remove: vi.fn(),
    ...overrides,
  };
}

beforeEach(domFixture);

describe('mountApp', () => {
  it('renders the current task list on mount', () => {
    const app = fakeApp({ getTasks: vi.fn().mockReturnValue([{ id: '1', title: 'A', status: 'not_started' }]) });
    mountApp(document, app);
    expect(document.querySelector('.jg-row')).not.toBeNull();
  });

  it('typing a plain title and clicking Add calls addManualTask', () => {
    const app = fakeApp();
    mountApp(document, app);
    document.getElementById('jg-add-input').value = 'Write the report';
    document.getElementById('jg-add-btn').click();
    expect(app.addManualTask).toHaveBeenCalledWith('Write the report');
    expect(document.getElementById('jg-add-input').value).toBe('');
  });

  it('typing a URL and clicking Add calls addByLink instead of addManualTask', () => {
    const app = fakeApp();
    mountApp(document, app);
    document.getElementById('jg-add-input').value = 'https://linear.app/acme/issue/ACME-1/x';
    document.getElementById('jg-add-btn').click();
    expect(app.addByLink).toHaveBeenCalledWith('https://linear.app/acme/issue/ACME-1/x');
    expect(app.addManualTask).not.toHaveBeenCalled();
  });

  it('clicking Add with an empty input calls neither', () => {
    const app = fakeApp();
    mountApp(document, app);
    document.getElementById('jg-add-btn').click();
    expect(app.addManualTask).not.toHaveBeenCalled();
    expect(app.addByLink).not.toHaveBeenCalled();
  });

  it('clicking Refresh calls app.refreshAll and updates the status line', async () => {
    const app = fakeApp({ refreshAll: vi.fn().mockResolvedValue({ skipped: false, results: [{ aiCalled: true }, { aiCalled: false }] }) });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.refreshAll).toHaveBeenCalled();
    expect(document.getElementById('jg-status').textContent).toContain('1');
  });

  it('clicking Refresh twice quickly still only calls refreshAll twice (debounce logic lives in app, not here)', async () => {
    const app = fakeApp();
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    document.getElementById('jg-refresh-btn').click();
    expect(app.refreshAll).toHaveBeenCalledTimes(2);
  });

  it('clicking Refresh also calls discoverNewTasks and reports how many were added', async () => {
    const app = fakeApp({ discoverNewTasks: vi.fn().mockResolvedValue({ added: 2 }) });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.discoverNewTasks).toHaveBeenCalledTimes(1);
    expect(document.getElementById('jg-status').textContent).toContain('2 new');
  });

  it('clicking Refresh also calls runSlackTriage and reports its counts in the status line', async () => {
    const app = fakeApp({
      runSlackTriage: vi.fn().mockResolvedValue({
        skipped: false, scanned: 3, ongoing: 2, updated: 1, added: 1, skippedResolved: 1, unparsed: 0, aiCalled: true,
      }),
    });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(app.runSlackTriage).toHaveBeenCalledTimes(1);
    const status = document.getElementById('jg-status').textContent;
    expect(status).toContain('3 scanned');
    expect(status).toContain('2 ongoing');
    expect(status).toContain('1 updated');
    expect(status).toContain('1 resolved');
  });

  it('the errors dropdown stays hidden when nothing failed', async () => {
    const app = fakeApp();
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('jg-errors').hidden).toBe(true);
  });

  it('a discoverNewTasks shape-mismatch error shows up in the errors dropdown, not the status line', async () => {
    const app = fakeApp({
      discoverNewTasks: vi.fn().mockResolvedValue({ added: 0, errors: ['list_sessions returned an unrecognized shape'] }),
    });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    const errorsEl = document.getElementById('jg-errors');
    expect(errorsEl.hidden).toBe(false);
    expect(errorsEl.querySelector('summary').textContent).toContain('1 issue');
    expect(errorsEl.querySelector('ul').textContent).toContain('list_sessions returned an unrecognized shape');
    expect(document.getElementById('jg-status').textContent).not.toContain('list_sessions');
  });

  it('combines errors from refreshAll, discoverNewTasks, and runSlackTriage into one dropdown', async () => {
    const app = fakeApp({
      refreshAll: vi.fn().mockResolvedValue({ skipped: false, results: [], errors: ['Some task: connector error'] }),
      discoverNewTasks: vi.fn().mockResolvedValue({ added: 0, errors: ['Linear (Acme): connector error'] }),
      runSlackTriage: vi.fn().mockResolvedValue({
        skipped: false, scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false,
        errors: ['Slack search ("is:thread to:me after:2026-07-29"): connector error'],
      }),
    });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    const errorsEl = document.getElementById('jg-errors');
    expect(errorsEl.querySelectorAll('li')).toHaveLength(3);
  });

  it('the candidates panel shows what each source detected, split by group, and stays visible even with zero found', async () => {
    const app = fakeApp({
      runSlackTriage: vi.fn().mockResolvedValue({
        skipped: false, scanned: 2, ongoing: 1, updated: 0, added: 1, skippedResolved: 1, unparsed: 0, aiCalled: true,
        detected: [
          { key: 'slack:C1:1', label: 'Priya asked Dana to review pricing copy', outcome: 'added' },
          { key: 'slack:C2:2', label: 'thanks, all set', outcome: 'skipped-resolved' },
        ],
      }),
      discoverNewTasks: vi.fn().mockResolvedValue({
        added: 1, errors: [],
        detected: {
          claude: [{ key: 'claude_session:s1', label: 'Payments webhook retry backoff', outcome: 'added' }],
          linear: [],
        },
      }),
    });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();

    const candidatesEl = document.getElementById('jg-candidates');
    expect(candidatesEl.hidden).toBe(false);
    expect(candidatesEl.querySelector(':scope > summary').textContent).toContain('3');

    const slackGroup = candidatesEl.querySelector('[data-group="slack"]');
    expect(slackGroup.querySelector('summary').textContent).toContain('Slack (2)');
    const slackItems = [...slackGroup.querySelectorAll('li')].map((li) => li.textContent);
    expect(slackItems).toEqual([
      '[added] Priya asked Dana to review pricing copy',
      '[skipped-resolved] thanks, all set',
    ]);

    const claudeGroup = candidatesEl.querySelector('[data-group="claude"]');
    expect(claudeGroup.querySelector('summary').textContent).toContain('Claude (1)');

    const linearGroup = candidatesEl.querySelector('[data-group="linear"]');
    expect(linearGroup.querySelector('summary').textContent).toContain('Linear (0)');
    expect(linearGroup.querySelector('li').textContent).toBe('none this scan');
  });

  it('clicking Probe calls probeSessionTools and opens the panel with the raw result', async () => {
    const app = fakeApp({
      probeSessionTools: vi.fn().mockResolvedValue([
        { name: 'mcp__session_info__list_sessions', args: { limit: 3 }, outcome: 'unreachable', error: 'No such tool available', shape: null },
        { name: 'mcp__ccd_session_mgmt__list_sessions', args: { limit: 3 }, outcome: 'ok', error: null, shape: {
          isError: false, hasStructuredContent: true, contentTextType: 'undefined',
          unwrappedType: 'array', unwrappedKeys: null, stringValuedKeys: null,
          payloadPreviews: [], rawJson: '[]',
        } },
      ]),
    });
    mountApp(document, app);
    document.getElementById('jg-probe-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.probeSessionTools).toHaveBeenCalledTimes(1);
    const probeEl = document.getElementById('jg-probe');
    expect(probeEl.hidden).toBe(false);
    expect(probeEl.open).toBe(true); // opened for the user, since they explicitly asked for it
    expect(probeEl.textContent).toContain('No such tool available');
    expect(document.getElementById('jg-status').textContent).toContain('1 succeeded');
  });

  it('the auto-refresh tick never probes — probing deliberately calls tools that may not exist', () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const app = fakeApp();
    mountApp(document, app, { autoRefreshMs: 1000 });
    vi.advanceTimersByTime(5000);
    expect(app.probeSessionTools).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('in offline mode, Probe says so instead of calling a nonexistent bridge', async () => {
    const app = fakeApp();
    mountApp(document, app, { offline: true });
    document.getElementById('jg-probe-btn').click();
    await Promise.resolve();
    expect(app.probeSessionTools).not.toHaveBeenCalled();
    expect(document.getElementById('jg-status').textContent).toContain('no connectors to probe');
  });

  it('in offline mode, refresh does not call the app and says so instead of throwing', async () => {
    const app = fakeApp();
    mountApp(document, app, { offline: true });
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    expect(app.refreshAll).not.toHaveBeenCalled();
    expect(app.discoverNewTasks).not.toHaveBeenCalled();
    expect(document.getElementById('jg-status').textContent).toContain('Local mode');
  });

  it('in offline mode, manual add still works — the list is usable without any bridge', () => {
    const app = fakeApp();
    mountApp(document, app, { offline: true });
    document.getElementById('jg-add-input').value = 'Write the report';
    document.getElementById('jg-add-btn').click();
    expect(app.addManualTask).toHaveBeenCalledWith('Write the report');
  });

  it('a failing connector surfaces an error in the status line instead of taking the list down', async () => {
    const app = fakeApp({ refreshAll: vi.fn().mockRejectedValue(new Error('connector exploded')) });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('jg-status').textContent).toContain('connector exploded');
    expect(document.getElementById('jg-errors').hidden).toBe(false);
    expect(document.getElementById('jg-errors').querySelector('ul').textContent).toContain('connector exploded');
  });

  it('does not auto-refresh when autoRefreshMs is not passed (default off, matches all other tests in this file)', () => {
    vi.useFakeTimers();
    const app = fakeApp();
    mountApp(document, app);
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(app.refreshAll).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('auto-refreshes on the given interval while the document is visible', () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    const app = fakeApp();
    mountApp(document, app, { autoRefreshMs: 1000 });
    vi.advanceTimersByTime(3500);
    expect(app.refreshAll).toHaveBeenCalledTimes(3);
    vi.useRealTimers();
  });

  it('skips the auto-refresh tick when the document is not visible', () => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    const app = fakeApp();
    mountApp(document, app, { autoRefreshMs: 1000 });
    vi.advanceTimersByTime(3500);
    expect(app.refreshAll).not.toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('toggling the view switches between list and card containers', () => {
    const app = fakeApp({ getTasks: vi.fn().mockReturnValue([{ id: '1', title: 'A', status: 'not_started' }]) });
    mountApp(document, app);
    expect(document.getElementById('jg-list').hidden).toBe(false);
    document.getElementById('jg-view-toggle').click();
    expect(document.getElementById('jg-list').hidden).toBe(true);
    expect(document.getElementById('jg-card').hidden).toBe(false);
  });

  it('card view queues tasks in priority order, not insertion order (regression: found live — a blocked task appeared ahead of an actionable one)', () => {
    const app = fakeApp({
      getTasks: vi.fn().mockReturnValue([
        { id: 'blocked', title: 'Blocked', status: 'waiting_ai', ballInUsersCourt: false, estRemaining: 'large' },
        { id: 'actionable', title: 'Actionable', status: 'not_started', ballInUsersCourt: true, estRemaining: 'small' },
      ]),
    });
    mountApp(document, app);
    document.getElementById('jg-view-toggle').click();
    expect(document.querySelector('#jg-card h2').textContent).toBe('Actionable');
  });

  it('clicking a status chip in the list calls cycleStatusManual', () => {
    const app = fakeApp({ getTasks: vi.fn().mockReturnValue([{ id: '1', title: 'A', status: 'not_started' }]) });
    mountApp(document, app);
    document.querySelector('.jg-chip').click();
    expect(app.cycleStatusManual).toHaveBeenCalledWith('1', expect.any(Function));
  });
});
