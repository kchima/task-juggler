import { describe, it, expect } from 'vitest';
// Pointed at the LIVE app module (app/public/scoring.js) — the original
// artifact module (src/scoring.js) is frozen legacy and never ships.
import { scoreTask, tierOf, sortTasks, completedTasks, prioritize } from '../app/public/scoring.js';

const NOW = new Date('2026-07-23T12:00:00Z');

function makeTask(overrides) {
  return {
    id: overrides.id ?? 'x',
    status: 'not_started',
    ballInUsersCourt: false,
    estRemaining: 'medium',
    dueDate: null,
    sourcePriority: null,
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('tierOf', () => {
  it('tiers not_started and in_progress as actionable (0)', () => {
    expect(tierOf(makeTask({ status: 'not_started' }))).toBe(0);
    expect(tierOf(makeTask({ status: 'in_progress' }))).toBe(0);
  });

  it('tiers waiting_other and waiting_ai as blocked (1)', () => {
    expect(tierOf(makeTask({ status: 'waiting_other' }))).toBe(1);
    expect(tierOf(makeTask({ status: 'waiting_ai' }))).toBe(1);
  });

  it('tiers the live waiting_for_* vocabulary as blocked (1)', () => {
    expect(tierOf(makeTask({ status: 'waiting_for_other' }))).toBe(1);
    expect(tierOf(makeTask({ status: 'waiting_for_ai' }))).toBe(1);
  });

  it('tiers completed as 2', () => {
    expect(tierOf(makeTask({ status: 'completed' }))).toBe(2);
  });
});

describe('scoreTask', () => {
  it('boosts ballInUsersCourt', () => {
    const withBall = scoreTask(makeTask({ ballInUsersCourt: true }), NOW);
    const withoutBall = scoreTask(makeTask({ ballInUsersCourt: false }), NOW);
    expect(withBall).toBeGreaterThan(withoutBall);
  });

  it('boosts small estRemaining over large (finishing bias)', () => {
    const small = scoreTask(makeTask({ estRemaining: 'small' }), NOW);
    const large = scoreTask(makeTask({ estRemaining: 'large' }), NOW);
    expect(small).toBeGreaterThan(large);
  });

  it('boosts an overdue due date over a far-future one', () => {
    const overdue = scoreTask(makeTask({ dueDate: '2026-07-20T00:00:00Z' }), NOW);
    const future = scoreTask(makeTask({ dueDate: '2026-12-01T00:00:00Z' }), NOW);
    expect(overdue).toBeGreaterThan(future);
  });

  it('boosts urgent sourcePriority over low', () => {
    const urgent = scoreTask(makeTask({ sourcePriority: 'urgent' }), NOW);
    const low = scoreTask(makeTask({ sourcePriority: 'low' }), NOW);
    expect(urgent).toBeGreaterThan(low);
  });

  it('handles a null dueDate and null sourcePriority without throwing', () => {
    expect(() => scoreTask(makeTask({ dueDate: null, sourcePriority: null }), NOW)).not.toThrow();
  });
});

describe('sortTasks — the finishing-bias acceptance case', () => {
  it('ranks a small, ball-in-users-court task above a high-priority task waiting on an AI', () => {
    const smallActionable = makeTask({
      id: 'small-actionable',
      status: 'in_progress',
      ballInUsersCourt: true,
      estRemaining: 'small',
      sourcePriority: null,
    });
    const bigBlockedUrgent = makeTask({
      id: 'blocked-urgent',
      status: 'waiting_ai',
      ballInUsersCourt: false,
      estRemaining: 'large',
      sourcePriority: 'urgent',
    });
    const sorted = sortTasks([bigBlockedUrgent, smallActionable], NOW);
    expect(sorted.map((t) => t.id)).toEqual(['small-actionable', 'blocked-urgent']);
  });

  it('excludes completed tasks entirely', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b', status: 'completed' })];
    expect(sortTasks(tasks, NOW).map((t) => t.id)).toEqual(['a']);
  });

  // Real divergence from ARCHITECTURE.md §4.2: the old client-side prioritize()
  // (since removed) gave an in-progress/urgent/overdue task score 170 and a
  // small, ball-in-your-court, not-started task 100, inverting the product.
  it('ranks a small ball-in-court not-started task above an in-progress urgent overdue task not in your court', () => {
    const a = makeTask({ id: 'a', status: 'not_started', ballInUsersCourt: true, estRemaining: 'small' });
    const b = makeTask({ id: 'b', status: 'in_progress', ballInUsersCourt: false, estRemaining: 'medium', sourcePriority: 'urgent', dueDate: '2026-07-20T00:00:00Z' });
    expect(scoreTask(a, NOW)).toBe(130);
    expect(scoreTask(b, NOW)).toBeLessThan(130);
    expect(prioritize([b, a], NOW).map((t) => t.id)).toEqual(['a', 'b']);
  });
});

describe('completedTasks', () => {
  it('returns only completed tasks', () => {
    const tasks = [makeTask({ id: 'a' }), makeTask({ id: 'b', status: 'completed' })];
    expect(completedTasks(tasks).map((t) => t.id)).toEqual(['b']);
  });
});
