import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mountApp, readToolConfig, validateToolConfig } from '../src/main.js';

function domFixture() {
  document.body.innerHTML = `
    <details id="jg-errors" hidden><summary></summary><ul></ul></details>
    <details id="jg-candidates">
      <summary></summary>
      <details data-group="slack"><summary></summary><ul></ul></details>
      <details data-group="claude"><summary></summary><ul></ul></details>
      <details data-group="linear"><summary></summary><ul></ul></details>
      <details data-group="todoist"><summary></summary><ul></ul></details>
    </details>
    <input id="jg-add-input" />
    <button id="jg-add-btn"></button>
    <button id="jg-view-toggle"></button>
    <label id="jg-lookback-label" for="jg-lookback-input"></label>
    <input type="date" id="jg-lookback-input" />
    <button id="jg-refresh-btn"></button>
    <button id="jg-copy-debug-btn"></button>
    <span id="jg-status"></span>
    <textarea id="jg-debug-fallback" readonly hidden></textarea>
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
    getSlackLookbackDate: vi.fn().mockReturnValue(null),
    setSlackLookbackDate: vi.fn(),
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
        detected: { linear: [], todoist: [] },
      }),
    });
    mountApp(document, app);
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();

    const candidatesEl = document.getElementById('jg-candidates');
    expect(candidatesEl.hidden).toBe(false);
    // 2 Slack + 1 Claude (always shown) + 0 Linear + 0 Todoist = 3
    expect(candidatesEl.querySelector(':scope > summary').textContent).toContain('3');

    const slackGroup = candidatesEl.querySelector('[data-group="slack"]');
    expect(slackGroup.querySelector('summary').textContent).toContain('Slack (2)');
    const slackItems = [...slackGroup.querySelectorAll('li')].map((li) => li.textContent);
    expect(slackItems).toEqual([
      '[added] Priya asked Dana to review pricing copy',
      '[skipped-resolved] thanks, all set',
    ]);

    // Claude discovery never runs from the artifact (see SKILL.md) — this
    // group always shows a fixed pointer to the chat-driven flow instead of
    // a live per-scan result, regardless of what discoverNewTasks returns.
    const claudeGroup = candidatesEl.querySelector('[data-group="claude"]');
    expect(claudeGroup.querySelector('summary').textContent).toContain('Claude (1)');
    expect(claudeGroup.querySelector('li').textContent).toContain('scan my Claude sessions');

    const linearGroup = candidatesEl.querySelector('[data-group="linear"]');
    expect(linearGroup.querySelector('summary').textContent).toContain('Linear (0)');
    expect(linearGroup.querySelector('li').textContent).toBe('none this scan');

    const todoistGroup = candidatesEl.querySelector('[data-group="todoist"]');
    expect(todoistGroup.querySelector('summary').textContent).toContain('Todoist (0)');
    expect(todoistGroup.querySelector('li').textContent).toBe('none this scan');
  });

  it('populates the lookback input from the stored override on mount', () => {
    const app = fakeApp({ getSlackLookbackDate: vi.fn().mockReturnValue('2026-07-20') });
    mountApp(document, app);
    expect(document.getElementById('jg-lookback-input').value).toBe('2026-07-20');
  });

  it('leaves the lookback input blank on mount when there is no stored override', () => {
    const app = fakeApp();
    mountApp(document, app);
    expect(document.getElementById('jg-lookback-input').value).toBe('');
  });

  it('saves the lookback date on change, without triggering a refresh as a side effect', () => {
    const app = fakeApp();
    mountApp(document, app);
    const input = document.getElementById('jg-lookback-input');
    input.value = '2026-07-20';
    input.dispatchEvent(new Event('change'));
    expect(app.setSlackLookbackDate).toHaveBeenCalledWith('2026-07-20');
    expect(app.refreshAll).not.toHaveBeenCalled();
  });

  it('clearing the lookback input saves an empty string, not the previous value', () => {
    const app = fakeApp({ getSlackLookbackDate: vi.fn().mockReturnValue('2026-07-20') });
    mountApp(document, app);
    const input = document.getElementById('jg-lookback-input');
    input.value = '';
    input.dispatchEvent(new Event('change'));
    expect(app.setSlackLookbackDate).toHaveBeenCalledWith('');
  });

  it('sets max to today so picking a future date is not offered, even in offline mode', () => {
    const app = fakeApp();
    mountApp(document, app, { offline: true });
    const input = document.getElementById('jg-lookback-input');
    expect(input.max).toBe(new Date().toISOString().slice(0, 10));
  });

  describe('Copy Debug Info', () => {
    afterEach(() => {
      delete navigator.clipboard;
    });

    it('copies the snapshot to the clipboard when the API is available, and never shows the fallback textarea', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined);
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const app = fakeApp({ getSlackLookbackDate: vi.fn().mockReturnValue('2026-07-20') });
      mountApp(document, app);

      document.getElementById('jg-copy-debug-btn').click();
      await Promise.resolve();
      await Promise.resolve();

      expect(writeText).toHaveBeenCalledTimes(1);
      expect(writeText.mock.calls[0][0]).toContain('Slack lookback override: 2026-07-20');
      expect(document.getElementById('jg-status').textContent).toContain('copied to clipboard');
      expect(document.getElementById('jg-debug-fallback').hidden).toBe(true);
    });

    it('falls back to a visible, selected textarea when the clipboard API is unavailable — the artifact sandbox is unverified, not assumed to work', async () => {
      // No navigator.clipboard defined at all — jsdom's default, and exactly
      // what an artifact iframe blocking clipboard access would look like.
      const app = fakeApp();
      mountApp(document, app);

      document.getElementById('jg-copy-debug-btn').click();
      await Promise.resolve();
      await Promise.resolve();

      const fallback = document.getElementById('jg-debug-fallback');
      expect(fallback.hidden).toBe(false);
      expect(fallback.value).toContain('Task Juggler debug snapshot');
      expect(document.getElementById('jg-status').textContent).toContain('Clipboard unavailable');
    });

    it('falls back the same way when the clipboard API exists but writeText itself rejects', async () => {
      const writeText = vi.fn().mockRejectedValue(new Error('permission denied'));
      Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
      const app = fakeApp();
      mountApp(document, app);

      document.getElementById('jg-copy-debug-btn').click();
      await Promise.resolve();
      await Promise.resolve();

      expect(document.getElementById('jg-debug-fallback').hidden).toBe(false);
    });

    it('includes the errors dropdown and candidates panel verbatim in the snapshot', async () => {
      const app = fakeApp({
        discoverNewTasks: vi.fn().mockResolvedValue({ added: 0, errors: ['Linear (Acme): connector error'] }),
      });
      mountApp(document, app);
      document.getElementById('jg-refresh-btn').click();
      await Promise.resolve();
      await Promise.resolve();

      document.getElementById('jg-copy-debug-btn').click();
      await Promise.resolve();

      const fallback = document.getElementById('jg-debug-fallback');
      expect(fallback.value).toContain('Linear (Acme): connector error');
    });
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

  it('in AI-unavailable mode, refresh still calls discoverNewTasks and runSlackTriage', async () => {
    const app = fakeApp({
      refreshAll: vi.fn().mockResolvedValue({ skipped: false, results: [] }),
      discoverNewTasks: vi.fn().mockResolvedValue({ added: 1 }),
      runSlackTriage: vi.fn().mockResolvedValue({
        skipped: false, scanned: 2, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false,
      }),
    });
    mountApp(document, app, { aiUnavailable: true });
    document.getElementById('jg-refresh-btn').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(app.refreshAll).toHaveBeenCalled();
    expect(app.discoverNewTasks).toHaveBeenCalled();
    expect(app.runSlackTriage).toHaveBeenCalled();
    const status = document.getElementById('jg-status').textContent;
    expect(status).toContain('AI unavailable');
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

describe('tool config resolution', () => {
  describe('readToolConfig', () => {
    it('returns null when the config element is absent', () => {
      const doc = { getElementById: () => null };
      expect(readToolConfig(doc)).toBeNull();
    });

    it('returns null when the config element exists but has no content', () => {
      const configEl = { textContent: '' };
      const doc = { getElementById: (id) => (id === 'juggler-tool-config' ? configEl : null) };
      expect(readToolConfig(doc)).toBeNull();
    });

    it('returns null for whitespace-only content', () => {
      const configEl = { textContent: '   \n  ' };
      const doc = { getElementById: (id) => (id === 'juggler-tool-config' ? configEl : null) };
      expect(readToolConfig(doc)).toBeNull();
    });

    it('returns null for invalid JSON', () => {
      const configEl = { textContent: '{invalid}' };
      const doc = { getElementById: (id) => (id === 'juggler-tool-config' ? configEl : null) };
      expect(readToolConfig(doc)).toBeNull();
    });

    it('returns null when JSON is a non-object (array)', () => {
      const configEl = { textContent: '["a", "b"]' };
      const doc = { getElementById: (id) => (id === 'juggler-tool-config' ? configEl : null) };
      expect(readToolConfig(doc)).toBeNull();
    });

    it('returns the parsed object for valid JSON', () => {
      const configEl = { textContent: '{"slackReadThread":"mcp__x__read"}' };
      const doc = { getElementById: (id) => (id === 'juggler-tool-config' ? configEl : null) };
      expect(readToolConfig(doc)).toEqual({ slackReadThread: 'mcp__x__read' });
    });
  });

  describe('validateToolConfig', () => {
    it('returns complete defaults when passed incomplete valid config', () => {
      const result = validateToolConfig({ slackReadThread: 'mcp__x__read' });
      expect(result).toEqual({
        slackReadThread: 'mcp__x__read',
        slackSearch: '',
        linearWorkspaces: {},
        todoistFindTasks: '',
      });
    });

    it('returns complete defaults for null/undefined input', () => {
      expect(validateToolConfig(null)).toBeNull();
      expect(validateToolConfig(undefined)).toBeNull();
    });

    it('returns complete defaults when config string fields have wrong types', () => {
      const result = validateToolConfig({ slackReadThread: 42, slackSearch: true });
      expect(result.slackReadThread).toBe('');
      expect(result.slackSearch).toBe('');
    });

    it('filters out non-string linear workspace labels and prefixes', () => {
      const result = validateToolConfig({
        linearWorkspaces: { Acme: 'mcp__acme__', BadLabel: null, GoodLabel: 'mcp__good__' },
      });
      expect(result.linearWorkspaces).toEqual({ Acme: 'mcp__acme__', GoodLabel: 'mcp__good__' });
    });

    it('returns linearWorkspaces as empty object when input is an array instead of object', () => {
      const result = validateToolConfig({ linearWorkspaces: [] });
      expect(result.linearWorkspaces).toEqual({});
    });

    it('handles a fully valid complete config', () => {
      const result = validateToolConfig({
        slackReadThread: 'mcp__x__read',
        slackSearch: 'mcp__x__search',
        todoistFindTasks: 'mcp__x__todoist',
        linearWorkspaces: { Acme: 'mcp__acme__' },
      });
      expect(result).toEqual({
        slackReadThread: 'mcp__x__read',
        slackSearch: 'mcp__x__search',
        todoistFindTasks: 'mcp__x__todoist',
        linearWorkspaces: { Acme: 'mcp__acme__' },
      });
    });

    it('ignores unrecognised fields', () => {
      const result = validateToolConfig({ slackReadThread: 't', unknownField: 'should be ignored' });
      expect(result.unknownField).toBeUndefined();
    });
  });
});
