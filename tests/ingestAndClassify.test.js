// Tests for the scan→ingest bridge and OpenRouter classification module.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initTestDb, closeDb, upsertSourceItem, getAllSourceItems, getTaskById,
} from '../app/database.js';
import { ingestScanResults, normalizeItem, contentHash } from '../app/ingestService.js';
import {
  parseVerdict, applyVerdict, buildSystemPrompt, buildUserPrompt, enqueueDueJobs,
  processNextJobs, markUserFields, CLASSIFICATION_SCHEMA,
} from '../app/ai/classification.js';

describe('ingestService', () => {
  beforeEach(() => initTestDb());
  afterEach(() => closeDb());

  it('ingests scanner results into source_items with stable hashes', () => {
    const summary = ingestScanResults({
      linear: { status: 'ok', items: [
        { key: 'linear:1', label: 'Fix bug', url: 'http://x' },
        { key: 'linear:2', title: 'Ship feature', status: 'started' },
      ] },
      todoist: { status: 'ok', items: [{ key: 'todoist:9', label: 'Call bank', isUrgent: true }] },
    });
    expect(summary.linear.ingested).toBe(2);
    expect(summary.todoist.ingested).toBe(1);
    const items = getAllSourceItems();
    expect(items.find((i) => i.key === 'todoist:9').priority).toBe('high');
    expect(items.every((i) => !!i.contentHash)).toBe(true);
  });

  it('normalizes stable content hashes for identical content', () => {
    const a = contentHash(normalizeItem('linear', { key: 'k', label: 'same' }));
    const b = contentHash(normalizeItem('linear', { key: 'k', label: 'same' }));
    expect(a).toBe(b);
  });
});

describe('classification', () => {
  beforeEach(() => initTestDb());
  afterEach(() => closeDb());

  it('builds a bounded prompt and valid schema', () => {
    const sys = buildSystemPrompt();
    expect(sys.length).toBeGreaterThan(100);
    const item = { sourceType: 'linear', title: 'T', description: 'D', status: 'started', priority: 'high', raw: { a: 1 } };
    const prompt = buildUserPrompt(item);
    expect(prompt).toContain('linear');
    expect(CLASSIFICATION_SCHEMA.schema.required).toContain('actionable');
  });

  it('parses a valid verdict and rejects malformed output', () => {
    const v = parseVerdict(JSON.stringify({ actionable: true, status: 'in_progress', ballInUsersCourt: true, summary: 's', reason: 'r', priority: 'high' }));
    expect(v.status).toBe('in_progress');
    expect(() => parseVerdict('not json')).toThrow(/JSON/);
    expect(() => parseVerdict(JSON.stringify({ actionable: true, status: 'bogus', ballInUsersCourt: false, summary: '', reason: '', priority: 'medium' }))).toThrow(/Unknown status/);
  });

  it('creates a task when an actionable item is promoted', async () => {
    upsertSourceItem({ sourceType: 'linear', key: 'linear:1', title: 'Fix the widget', contentHash: 'h' });
    const item = getAllSourceItems()[0];
    const verdict = { actionable: true, status: 'in_progress', ballInUsersCourt: true, summary: 'Fix the widget', reason: 'It is broken', priority: 'high' };
    const out = await applyVerdict(item, verdict);
    expect(out.created).toBe(true);
    const task = getTaskById(out.taskId);
    expect(task.title).toBe('Fix the widget');
    expect(task.sourceType).toBe('linear');
    expect(task.status).toBe('in_progress');
  });

  it('respects human-pinned fields and never overwrites them', async () => {
    upsertSourceItem({ sourceType: 'linear', key: 'linear:1', title: 'Original', contentHash: 'h' });
    let item = getAllSourceItems()[0];
    const first = await applyVerdict(item, { actionable: true, status: 'in_progress', ballInUsersCourt: true, summary: 'Original', reason: 'r', priority: 'medium' });
    // User edits the title → pins it.
    markUserFields('linear:1', ['title']);
    item = getAllSourceItems()[0];
    const second = await applyVerdict(item, { actionable: true, status: 'in_progress', ballInUsersCourt: true, summary: 'AI Wants This Title', reason: 'r2', priority: 'high' });
    const task = getTaskById(first.taskId);
    expect(task.title).toBe('Original'); // pinned — AI title rejected
    expect(task.priority).toBe('high'); // not pinned — AI priority applied
    expect(second.created).toBe(false);
  });

  it('enqueues due jobs only when configured', async () => {
    upsertSourceItem({ sourceType: 'linear', key: 'linear:1', title: 'T', contentHash: 'h' });
    const without = await enqueueDueJobs();
    expect(without.ok).toBe(false); // no OPENROUTER_API_KEY
    expect(without.enqueued).toBe(0);
    const processed = await processNextJobs({ config: { enabled: false, apiKey: null }, now: new Date() });
    expect(processed.ok).toBe(false);
  });
});