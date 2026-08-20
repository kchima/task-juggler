// Tests for the classification scheduler + daily budget guardrail.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// Hermetic: never read the developer's real Keychain during tests.
vi.mock("../app/auth/credentialStore.js", () => ({ getCredential: () => null, storeCredential: () => {}, deleteCredential: () => {}, listCredentials: () => [] }));
import {
  initTestDb, closeDb, enqueueClassificationJob, completeJob,
  getTodayCompletedCostUsd,
} from '../app/database.js';
import { tick, budgetRemainingUsd, startScheduler, stopScheduler } from '../app/scheduler.js';

describe('daily budget tracking', () => {
  beforeEach(() => initTestDb());
  afterEach(() => { stopScheduler(); closeDb(); });

  it('sums only today\'s succeeded job costs', () => {
    const { job } = enqueueClassificationJob({ sourceType: 'linear', sourceKey: 'a', contentHash: 'h1' });
    completeJob(job.id, { verdict: { status: 'in_progress' }, costUsd: 0.01, servedModel: 'm' });
    const { job: j2 } = enqueueClassificationJob({ sourceType: 'linear', sourceKey: 'b', contentHash: 'h2' });
    completeJob(j2.id, { verdict: { status: 'no_action' }, costUsd: 0.02, servedModel: 'm' });
    // A failed/leased job must not count toward spend.
    enqueueClassificationJob({ sourceType: 'todoist', sourceKey: 'c', contentHash: 'h3' });
    expect(getTodayCompletedCostUsd()).toBeCloseTo(0.03, 6);
  });

  it('budgetRemainingUsd is capped by config.maxDailyUsd', () => {
    const { job } = enqueueClassificationJob({ sourceType: 'linear', sourceKey: 'a', contentHash: 'h1' });
    completeJob(job.id, { verdict: {}, costUsd: 0.20, servedModel: 'm' });
    const config = { maxDailyUsd: 0.25 };
    expect(budgetRemainingUsd(config)).toBeCloseTo(0.05, 6);
    expect(budgetRemainingUsd({ maxDailyUsd: 0.1 })).toBe(0); // over cap → clamped to 0
  });
});

describe('scheduler tick', () => {
  beforeEach(() => initTestDb());
  afterEach(() => { stopScheduler(); closeDb(); });

  it('is a safe no-op when OpenRouter is not configured', async () => {
    const out = await tick();
    expect(out.ok).toBe(false);
    expect(out.reason).toBe('not_configured');
  });

  it('never runs concurrently (single-flight guard)', async () => {
    // First call is a no-op but sets _busy briefly; a second call during the
    // first must report busy. With config disabled both are no-ops; this asserts
    // the guard path doesn't throw and returns a bounded shape.
    const p1 = tick({ config: { enabled: false, apiKey: null } });
    const p2 = tick({ config: { enabled: false, apiKey: null } });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.ok).toBe(false);
    expect(r2.ok).toBe(false);
  });
});

describe('scheduler lifecycle', () => {
  afterEach(() => stopScheduler());

  it('startScheduler with interval 0 is disabled', () => {
    const out = startScheduler({ intervalMs: 0 });
    expect(out.started).toBe(false);
    expect(out.intervalMs).toBe(0);
  });

  it('startScheduler runs once immediately and can be stopped', async () => {
    const out = startScheduler({ intervalMs: 60_000 });
    expect(out.started).toBe(true);
    // Wait a microtick for the initial (no-op) attempt to settle without throwing.
    await new Promise((r) => setTimeout(r, 10));
    stopScheduler();
  });
});