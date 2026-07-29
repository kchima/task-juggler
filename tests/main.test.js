import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mountApp } from '../src/main.js';

function domFixture() {
  document.body.innerHTML = `
    <input id="jg-add-input" />
    <button id="jg-add-btn"></button>
    <button id="jg-view-toggle"></button>
    <button id="jg-refresh-btn"></button>
    <span id="jg-status"></span>
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

  it('surfaces a disabled-Claude-session-ingestion note when discoverNewTasks reports a shape mismatch, without hiding the rest of the status', async () => {
    const app = fakeApp({
      discoverNewTasks: vi.fn().mockResolvedValue({ added: 0, sessionDiscoveryError: 'list_sessions returned an unrecognized shape' }),
    });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();
    expect(document.getElementById('jg-status').textContent).toContain('Claude session ingestion disabled');
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
