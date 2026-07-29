import { describe, it, expect, vi, beforeEach } from 'vitest';
import { nextStatus, renderList, renderCard } from '../src/ui.js';

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
