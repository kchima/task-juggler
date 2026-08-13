// Tests for source_items + classification_jobs durable stores.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initTestDb, closeDb, upsertSourceItem, getSourceItemByKey, getAllSourceItems,
  dismissSourceItem, removeDismissSourceItem, linkSourceItemToTask, setHumanFields,
  enqueueClassificationJob, claimJobs, completeJob, failJob, getJobStates, getPendingJobCount,
  createTask, getSchemaVersion,
} from '../app/database.js';

describe('source_items', () => {
  beforeEach(() => initTestDb());
  afterEach(() => closeDb());

  it('upserts an item and reports creation on first insert', () => {
    const { created, sourceItem } = upsertSourceItem({ id: 's', sourceType: 'linear', key: 'linear:1', title: 'Fix' });
    expect(created).toBe(true);
    expect(sourceItem.key).toBe('linear:1');
    expect(upsertSourceItem({ sourceType: 'linear', key: 'linear:1', title: 'Fix 2' }).created).toBe(false);
    expect(getAllSourceItems().length).toBe(1);
    expect(getAllSourceItems()[0].title).toBe('Fix 2');
  });

  it('excludes dismissed items by default', () => {
    upsertSourceItem({ sourceType: 'todoist', key: 'todoist:1', title: 'A' });
    dismissSourceItem('todoist:1');
    expect(getAllSourceItems().length).toBe(0);
    expect(getAllSourceItems({ includeDismissed: true }).length).toBe(1);
    removeDismissSourceItem('todoist:1');
    expect(getAllSourceItems().length).toBe(1);
  });

  it('links to a task and pins human fields for AI overrides', () => {
    upsertSourceItem({ sourceType: 'linear', key: 'linear:1', title: 'Fix' });
    const task = createTask({ id: 't1', title: 'Linked' });
    expect(task.id).toBe('t1');
    linkSourceItemToTask('linear:1', 't1');
    expect(getSourceItemByKey('linear:1').linkedTaskId).toBe('t1');
    setHumanFields('linear:1', ['status']);
    expect(getSourceItemByKey('linear:1').humanFields).toContain('status');
  });

  it('reports schema version for migrations', () => {
    expect(getSchemaVersion()).toBeGreaterThanOrEqual(3);
  });
});

describe('classification_jobs', () => {
  beforeEach(() => initTestDb());
  afterEach(() => closeDb());

  it('enqueues idempotently and claims with a lease', () => {
    expect(enqueueClassificationJob({ sourceType: 'linear', sourceKey: 'k', contentHash: 'h' }).created).toBe(true);
    expect(enqueueClassificationJob({ sourceType: 'linear', sourceKey: 'k', contentHash: 'h' }).created).toBe(false);
    const claimed = claimJobs(5, { now: new Date() });
    expect(claimed.length).toBe(1);
    expect(claimed[0].state).toBe('leased');
  });

  it('transitions to succeeded on complete and terminal_failed on exhaust', () => {
    enqueueClassificationJob({ sourceType: 'linear', sourceKey: 'k', contentHash: 'h' });
    const [job] = claimJobs(1, { now: new Date() });
    completeJob(job.id, { verdict: { actionable: true }, servedModel: 'deepseek/deepseek-v4-flash-0731', inputTokens: 10, outputTokens: 5, costUsd: 0.0001 });
    expect(getJobStates().succeeded).toBe(1);

    enqueueClassificationJob({ sourceType: 'todoist', sourceKey: 'k2', contentHash: 'h2' });
    const [j2] = claimJobs(1, { now: new Date() });
    failJob(j2.id, { attempts: 5, maxAttempts: 5 });
    expect(getJobStates().terminal_failed).toBe(1);
    expect(getPendingJobCount()).toBe(0);
  });
});