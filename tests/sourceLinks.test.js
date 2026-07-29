import { describe, it, expect } from 'vitest';
import { sourceLinkFor, windowNameFor } from '../src/sourceLinks.js';

describe('sourceLinkFor', () => {
  it('prefers a captured url when present (add-by-link case)', () => {
    const task = { source: 'devin', sourceRef: { url: 'https://app.devin.ai/sessions/abc' } };
    expect(sourceLinkFor(task).url).toBe('https://app.devin.ai/sessions/abc');
  });

  it('rebuilds a real Slack permalink from channelId + threadTs + workspace domain', () => {
    const task = {
      source: 'slack',
      sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009', workspaceDomain: 'acme.slack.com' },
    };
    expect(sourceLinkFor(task).url)
      .toBe('https://acme.slack.com/archives/C01EXAMPLE1/p1784829904373009');
  });

  it('returns null for a Slack task with no workspace domain rather than a broken link', () => {
    const task = { source: 'slack', sourceRef: { channelId: 'C1', threadTs: '111.222' } };
    expect(sourceLinkFor(task)).toBeNull();
  });

  it('builds a real Linear issue URL', () => {
    const task = { source: 'linear', sourceRef: { workspaceLabel: 'acme', issueId: 'ACME-3913' } };
    expect(sourceLinkFor(task).url).toBe('https://linear.app/acme/issue/ACME-3913');
  });

  it('builds a Todoist task URL', () => {
    const task = { source: 'todoist', sourceRef: { taskId: 'TD00000000000001' } };
    expect(sourceLinkFor(task).url).toBe('https://app.todoist.com/app/task/TD00000000000001');
  });

  it('returns null for a manual task', () => {
    expect(sourceLinkFor({ source: 'manual', sourceRef: {} })).toBeNull();
  });

  it('returns null for a Claude session by default, since the deep-link path is unverified', () => {
    const task = { source: 'claude_session', sourceRef: { sessionId: 'local_abc' } };
    expect(sourceLinkFor(task)).toBeNull();
  });

  it('builds a Claude session link once a verified template is supplied', () => {
    const task = { source: 'claude_session', sourceRef: { sessionId: 'local_abc' } };
    const link = sourceLinkFor(task, { claudeSessionTemplate: 'claude://session/{sessionId}' });
    expect(link.url).toBe('claude://session/local_abc');
  });

  it('handles a malformed task without throwing', () => {
    expect(sourceLinkFor(null)).toBeNull();
    expect(sourceLinkFor({})).toBeNull();
  });
});

describe('windowNameFor', () => {
  it('is stable for the same task, so re-clicking reuses the tab', () => {
    const task = { id: 'abc', source: 'slack' };
    expect(windowNameFor(task)).toBe(windowNameFor(task));
  });

  it('differs between tasks, so separate tasks get separate tabs', () => {
    expect(windowNameFor({ id: 'a', source: 'slack' })).not.toBe(windowNameFor({ id: 'b', source: 'slack' }));
  });
});
