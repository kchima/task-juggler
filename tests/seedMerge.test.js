import { describe, it, expect } from 'vitest';
import { mergeSeedTasks, readSeedFromDocument } from '../src/seedMerge.js';

describe('mergeSeedTasks', () => {
  it('adds a seed task not already present', () => {
    const existing = [{ id: '1', source: 'manual', title: 'a' }];
    const seed = [{ id: '2', source: 'url', sourceRef: { url: 'https://example.com/x' }, title: 'b' }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(2);
  });

  it('dedups a Slack seed task against an existing one by channelId+threadTs', () => {
    const existing = [{ id: '1', source: 'slack', sourceRef: { channelId: 'C1', threadTs: '111.222' } }];
    const seed = [{ id: 'seed-1', source: 'slack', sourceRef: { channelId: 'C1', threadTs: '111.222' } }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(1);
  });

  it('dedups a Linear seed task against an existing one by workspaceLabel+issueId', () => {
    const existing = [{ id: '1', source: 'linear', sourceRef: { workspaceLabel: 'acme', issueId: 'ACME-1' } }];
    const seed = [{ id: 'seed-1', source: 'linear', sourceRef: { workspaceLabel: 'acme', issueId: 'ACME-1' } }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(1);
  });

  it('dedups a url seed task by url', () => {
    const existing = [{ id: '1', source: 'url', sourceRef: { url: 'https://x.com' } }];
    const seed = [{ id: 'seed-1', source: 'url', sourceRef: { url: 'https://x.com' } }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(1);
  });

  it('dedups a devin seed task by url', () => {
    const existing = [{ id: '1', source: 'devin', sourceRef: { url: 'https://app.devin.ai/sessions/abc' } }];
    const seed = [{ id: 'seed-1', source: 'devin', sourceRef: { url: 'https://app.devin.ai/sessions/abc' } }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(1);
  });

  it('dedups a todoist seed task by taskId', () => {
    const existing = [{ id: '1', source: 'todoist', sourceRef: { taskId: 'T1', projectId: 'P1' } }];
    const seed = [{ id: 'seed-1', source: 'todoist', sourceRef: { taskId: 'T1', projectId: 'P1' } }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(1);
  });

  it('dedups a claude_code_session seed task by sessionId', () => {
    const existing = [{ id: '1', source: 'claude_code_session', sourceRef: { sessionId: 'S1', pid: 123, cwd: '/x' } }];
    const seed = [{ id: 'seed-1', source: 'claude_code_session', sourceRef: { sessionId: 'S1', pid: 456, cwd: '/y' } }];
    expect(mergeSeedTasks(existing, seed)).toHaveLength(1);
  });

  it('does not mutate the existing array', () => {
    const existing = [{ id: '1', source: 'manual' }];
    mergeSeedTasks(existing, [{ id: '2', source: 'manual' }]);
    expect(existing).toHaveLength(1);
  });
});

describe('readSeedFromDocument', () => {
  it('reads and parses a #juggler-seed script tag', () => {
    document.body.innerHTML = '<script id="juggler-seed" type="application/json">[{"id":"1"}]</script>';
    expect(readSeedFromDocument(document)).toEqual([{ id: '1' }]);
  });

  it('returns an empty array when the tag is absent', () => {
    document.body.innerHTML = '';
    expect(readSeedFromDocument(document)).toEqual([]);
  });

  it('returns an empty array for malformed JSON instead of throwing', () => {
    document.body.innerHTML = '<script id="juggler-seed" type="application/json">not json</script>';
    expect(readSeedFromDocument(document)).toEqual([]);
  });
});
