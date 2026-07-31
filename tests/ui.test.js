import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextStatus, renderList, renderCard, renderErrors, renderCandidates, buildDebugSnapshot } from '../src/ui.js';

function noopHandlers() {
  return {
    onCycleStatus: vi.fn(),
    onDelete: vi.fn(),
    onReopen: vi.fn(),
    onRefreshOne: vi.fn(),
    onSkip: vi.fn(),
  };
}

beforeEach(() => {
  document.body.innerHTML = '<div id="root"></div>';
});

describe('renderErrors', () => {
  function errorsFixture() {
    document.body.innerHTML = '<details id="jg-errors" hidden><summary></summary><ul></ul></details>';
    return document.getElementById('jg-errors');
  }

  it('stays hidden and empty when there are no errors', () => {
    const container = errorsFixture();
    renderErrors(container, []);
    expect(container.hidden).toBe(true);
    expect(container.querySelector('ul').children).toHaveLength(0);
  });

  it('shows the count and every message when there are errors', () => {
    const container = errorsFixture();
    renderErrors(container, ['Linear (Acme): connector error', 'Todoist: connector error']);
    expect(container.hidden).toBe(false);
    expect(container.querySelector('summary').textContent).toContain('2 issues');
    const items = [...container.querySelectorAll('li')].map((li) => li.textContent);
    expect(items).toEqual(['Linear (Acme): connector error', 'Todoist: connector error']);
  });

  it('uses singular "issue" for exactly one error', () => {
    const container = errorsFixture();
    renderErrors(container, ['Todoist: connector error']);
    expect(container.querySelector('summary').textContent).toContain('1 issue');
    expect(container.querySelector('summary').textContent).not.toContain('1 issues');
  });

  it('re-hides and clears the list on a later call with zero errors (recovered on retry)', () => {
    const container = errorsFixture();
    renderErrors(container, ['Todoist: connector error']);
    renderErrors(container, []);
    expect(container.hidden).toBe(true);
    expect(container.querySelector('ul').children).toHaveLength(0);
  });
});

describe('renderCandidates', () => {
  function candidatesFixture() {
    document.body.innerHTML = `
      <details id="jg-candidates">
        <summary></summary>
        <details data-group="slack"><summary></summary><ul></ul></details>
        <details data-group="claude"><summary></summary><ul></ul></details>
        <details data-group="linear"><summary></summary><ul></ul></details>
      </details>
    `;
    return document.getElementById('jg-candidates');
  }

  it('never hides, even with zero candidates — "found nothing" is itself worth confirming', () => {
    const container = candidatesFixture();
    renderCandidates(container, {});
    expect(container.hidden).toBe(false);
    expect(container.querySelector(':scope > summary').textContent).toContain('0');
  });

  it('shows "none this scan" per empty group instead of an empty list', () => {
    const container = candidatesFixture();
    renderCandidates(container, {});
    for (const group of ['slack', 'claude', 'linear']) {
      const el = container.querySelector(`[data-group="${group}"]`);
      expect(el.querySelector('li').textContent).toBe('none this scan');
    }
  });

  it('splits detected items into their own group with outcome-prefixed labels', () => {
    const container = candidatesFixture();
    renderCandidates(container, {
      slack: [
        { key: 'slack:C1:1', label: 'Priya asked Dana to review pricing copy', outcome: 'added' },
        { key: 'slack:C2:2', label: 'thanks, all set', outcome: 'unchanged' },
      ],
      claude: [{ key: 'claude_session:s1', label: 'Payments webhook retry backoff', outcome: 'added' }],
      linear: [],
    });

    expect(container.querySelector(':scope > summary').textContent).toContain('3');

    const slackGroup = container.querySelector('[data-group="slack"]');
    expect(slackGroup.querySelector('summary').textContent).toBe('Slack (2)');
    expect([...slackGroup.querySelectorAll('li')].map((li) => li.textContent)).toEqual([
      '[added] Priya asked Dana to review pricing copy',
      '[unchanged] thanks, all set',
    ]);

    const claudeGroup = container.querySelector('[data-group="claude"]');
    expect(claudeGroup.querySelector('summary').textContent).toBe('Claude (1)');

    const linearGroup = container.querySelector('[data-group="linear"]');
    expect(linearGroup.querySelector('summary').textContent).toBe('Linear (0)');
    expect(linearGroup.querySelector('li').textContent).toBe('none this scan');
  });

  it('clears a previously-populated group back to "none this scan" on the next call', () => {
    const container = candidatesFixture();
    renderCandidates(container, { slack: [{ key: 'slack:C1:1', label: 'x', outcome: 'added' }] });
    renderCandidates(container, {});
    const slackGroup = container.querySelector('[data-group="slack"]');
    expect(slackGroup.querySelectorAll('li')).toHaveLength(1);
    expect(slackGroup.querySelector('li').textContent).toBe('none this scan');
  });
});

describe('buildDebugSnapshot', () => {
  function fullFixture() {
    document.body.innerHTML = `
      <span id="jg-status">Refreshed (1 AI call, 3 new)</span>
      <input type="date" id="jg-lookback-input" value="2026-07-20" />
      <details id="jg-errors"><summary>⚠ 1 issue</summary><ul><li>Linear (Acme): connector error</li></ul></details>
      <details id="jg-candidates">
        <summary>Detected this scan (2)</summary>
        <details data-group="slack"><summary>Slack (1)</summary><ul><li>[added] Priya asked Dana to review pricing copy</li></ul></details>
        <details data-group="claude"><summary>Claude (0)</summary><ul><li class="jg-candidate-empty">none this scan</li></ul></details>
        <details data-group="linear"><summary>Linear (1)</summary><ul><li>[already-tracked] [Acme] Fix flaky checkout retry logic</li></ul></details>
      </details>
    `;
    return document;
  }

  it('includes the status line and lookback value verbatim', () => {
    const text = buildDebugSnapshot(fullFixture());
    expect(text).toContain('Status: Refreshed (1 AI call, 3 new)');
    expect(text).toContain('Slack lookback override: 2026-07-20');
  });

  it('includes every error message', () => {
    const text = buildDebugSnapshot(fullFixture());
    expect(text).toContain('Linear (Acme): connector error');
  });

  it('includes every candidate group, even the empty one', () => {
    const text = buildDebugSnapshot(fullFixture());
    expect(text).toContain('[added] Priya asked Dana to review pricing copy');
    expect(text).toContain('none this scan');
    expect(text).toContain('[already-tracked] [Acme] Fix flaky checkout retry logic');
  });

  it('reports "(none)" for errors and the default lookback note when both are in their default state', () => {
    document.body.innerHTML = `
      <span id="jg-status"></span>
      <input type="date" id="jg-lookback-input" />
      <details id="jg-errors" hidden><summary></summary><ul></ul></details>
      <details id="jg-candidates"><summary></summary>
        <details data-group="slack"><summary></summary><ul></ul></details>
        <details data-group="claude"><summary></summary><ul></ul></details>
        <details data-group="linear"><summary></summary><ul></ul></details>
      </details>
    `;
    const text = buildDebugSnapshot(document);
    expect(text).toContain('(none)');
    expect(text).toContain('(default — last 24h)');
  });
});

describe('nextStatus', () => {
  it('cycles through the full status list and wraps around', () => {
    expect(nextStatus('not_started')).toBe('in_progress');
    expect(nextStatus('in_progress')).toBe('waiting_other');
    expect(nextStatus('waiting_other')).toBe('waiting_ai');
    expect(nextStatus('waiting_ai')).toBe('completed');
    expect(nextStatus('completed')).toBe('not_started');
  });
});

describe('renderList', () => {
  it('renders actionable tasks sorted above blocked tasks', () => {
    const container = document.getElementById('root');
    const tasks = [
      { id: 'blocked', title: 'Blocked', status: 'waiting_ai', ballInUsersCourt: false, estRemaining: 'large' },
      { id: 'actionable', title: 'Actionable', status: 'in_progress', ballInUsersCourt: true, estRemaining: 'small' },
    ];
    renderList(container, tasks, noopHandlers());
    const rows = [...container.querySelectorAll('.jg-row:not(.jg-row-completed)')];
    expect(rows.map((r) => r.dataset.taskId)).toEqual(['actionable', 'blocked']);
  });

  it('renders completed tasks in a separate struck-through section at the bottom with a Reopen button', () => {
    const container = document.getElementById('root');
    const tasks = [
      { id: 'a', title: 'A', status: 'not_started' },
      { id: 'b', title: 'B', status: 'completed' },
    ];
    renderList(container, tasks, noopHandlers());
    const completedRow = container.querySelector('.jg-row-completed');
    expect(completedRow.dataset.taskId).toBe('b');
    expect(completedRow.querySelector('.jg-reopen')).not.toBeNull();
    expect(completedRow.querySelector('.jg-delete')).toBeNull();
  });

  it('clicking a status chip calls onCycleStatus with the task id', () => {
    const container = document.getElementById('root');
    const handlers = noopHandlers();
    renderList(container, [{ id: 'a', title: 'A', status: 'not_started' }], handlers);
    container.querySelector('.jg-chip').click();
    expect(handlers.onCycleStatus).toHaveBeenCalledWith('a');
  });

  it('renders a distinct waiting-on-user badge', () => {
    const container = document.getElementById('root');
    renderList(container, [{ id: 'a', title: 'A', status: 'waiting_other', waitingOn: 'user' }], noopHandlers());
    const badge = container.querySelector('.jg-badge');
    expect(badge.textContent).toContain('user');
    expect(badge.classList.contains('jg-badge-user')).toBe(true);
  });

  it('renders a linked, visually distinct title for a task with a real source', () => {
    const container = document.getElementById('root');
    const task = {
      id: 'a', title: 'Fix flaky checkout', status: 'not_started',
      source: 'linear', sourceRef: { workspaceLabel: 'acme', issueId: 'ACME-4001' },
    };
    renderList(container, [task], noopHandlers());
    const titleEl = container.querySelector('.jg-title');
    expect(titleEl.tagName).toBe('A');
    expect(titleEl.href).toBe('https://linear.app/acme/issue/ACME-4001');
    expect(titleEl.classList.contains('jg-title-linked')).toBe(true);
    expect(titleEl.target).toBe('jg-linear-a');
  });

  it('renders a plain (non-anchor) title for a manual task with no source', () => {
    const container = document.getElementById('root');
    const task = { id: 'm', title: 'Write the report', status: 'not_started', source: 'manual', sourceRef: {} };
    renderList(container, [task], noopHandlers());
    const titleEl = container.querySelector('.jg-title');
    expect(titleEl.tagName).toBe('SPAN');
    expect(titleEl.classList.contains('jg-title-linked')).toBe(false);
  });

  it('clicking delete calls onDelete with the task id', () => {
    const container = document.getElementById('root');
    const handlers = noopHandlers();
    renderList(container, [{ id: 'a', title: 'A', status: 'not_started' }], handlers);
    container.querySelector('.jg-delete').click();
    expect(handlers.onDelete).toHaveBeenCalledWith('a');
  });
});

describe('renderCard', () => {
  it('renders title, summary, next action, and a source link', () => {
    const container = document.getElementById('root');
    const task = {
      id: 'a', title: 'Ship it', summary: 'Almost done', nextAction: 'Merge PR',
      sourceRef: { url: 'https://example.com/pr/1' },
    };
    renderCard(container, task, noopHandlers());
    expect(container.querySelector('h2').textContent).toBe('Ship it');
    expect(container.textContent).toContain('Almost done');
    expect(container.textContent).toContain('Merge PR');
    expect(container.querySelector('a').href).toBe('https://example.com/pr/1');
  });

  it('shows a placeholder when there is no task', () => {
    const container = document.getElementById('root');
    renderCard(container, null, noopHandlers());
    expect(container.textContent).toContain('No tasks');
  });

  it('clicking skip calls onSkip with the task id', () => {
    const container = document.getElementById('root');
    const handlers = noopHandlers();
    renderCard(container, { id: 'a', title: 'A' }, handlers);
    container.querySelector('.jg-skip').click();
    expect(handlers.onSkip).toHaveBeenCalledWith('a');
  });
});
