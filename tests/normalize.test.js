import { describe, it, expect } from 'vitest';
import { normalizeLinearIssue, normalizeSlackThread } from '../src/normalize.js';
import acmeIssue from './fixtures/linear-acme-issue.json' with { type: 'json' };
import globexIssue from './fixtures/linear-globex-issue.json' with { type: 'json' };
import slackThread from './fixtures/slack-thread.json' with { type: 'json' };

describe('normalizeLinearIssue', () => {
  it('is deterministic for the same issue', () => {
    expect(normalizeLinearIssue(acmeIssue)).toBe(normalizeLinearIssue(acmeIssue));
  });

  it('differs between two real, differently-shaped issues', () => {
    expect(normalizeLinearIssue(acmeIssue)).not.toBe(normalizeLinearIssue(globexIssue));
  });

  it('changes when status changes', () => {
    const changed = { ...acmeIssue, status: 'In Progress', statusType: 'started' };
    expect(normalizeLinearIssue(changed)).not.toBe(normalizeLinearIssue(acmeIssue));
  });

  it('is stable regardless of label array order', () => {
    const reordered = { ...acmeIssue, labels: [...acmeIssue.labels].reverse() };
    expect(normalizeLinearIssue(reordered)).toBe(normalizeLinearIssue(acmeIssue));
  });

  it('handles a missing priority object gracefully', () => {
    const noPriority = { ...acmeIssue, priority: undefined };
    expect(() => normalizeLinearIssue(noPriority)).not.toThrow();
  });
});

describe('normalizeSlackThread', () => {
  it('is deterministic for the same raw text', () => {
    expect(normalizeSlackThread(slackThread.rawText)).toBe(normalizeSlackThread(slackThread.rawText));
  });

  it('changes when a new reply is appended (real change-detection case)', () => {
    const withNewReply = slackThread.rawText + '\n--- Reply 7 of 7 ---\nFrom: Dana\nSounds good, yes please.\n';
    expect(normalizeSlackThread(withNewReply)).not.toBe(normalizeSlackThread(slackThread.rawText));
  });

  it('returns an empty string for non-string input', () => {
    expect(normalizeSlackThread(undefined)).toBe('');
    expect(normalizeSlackThread(null)).toBe('');
  });
});
