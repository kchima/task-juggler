import { describe, it, expect, vi } from 'vitest';
import { unwrapMcpResult, fetchRawContext } from '../src/mcpAdapters.js';
import acmeIssue from './fixtures/linear-acme-issue.json' with { type: 'json' };
import slackThread from './fixtures/slack-thread.json' with { type: 'json' };

describe('unwrapMcpResult', () => {
  it('prefers structuredContent when present (Linear shape)', () => {
    const result = { content: [{ text: '{}' }], structuredContent: acmeIssue, isError: false };
    expect(unwrapMcpResult(result)).toEqual(acmeIssue);
  });

  it('falls back to content[0].text as plain text when there is no structuredContent (Slack shape)', () => {
    const result = { content: [{ text: slackThread.rawText }], isError: false };
    expect(unwrapMcpResult(result)).toBe(slackThread.rawText);
  });

  it('parses content[0].text as JSON when it looks like JSON', () => {
    const result = { content: [{ text: JSON.stringify(acmeIssue) }], isError: false };
    expect(unwrapMcpResult(result)).toEqual(acmeIssue);
  });

  it('returns null when isError is true', () => {
    expect(unwrapMcpResult({ isError: true, content: [{ text: 'boom' }] })).toBeNull();
  });

  it('returns null for a missing/malformed result', () => {
    expect(unwrapMcpResult(null)).toBeNull();
    expect(unwrapMcpResult({})).toBeNull();
  });
});

describe('fetchRawContext', () => {
  const toolNames = {
    slackReadThread: 'mcp__slack__slack_read_thread',
    linearWorkspaces: { Acme: 'mcp__plugin_linear_linear__' },
  };

  it('fetches a Slack thread as raw text', async () => {
    const callMcpTool = vi.fn().mockResolvedValue({ content: [{ text: slackThread.rawText }], isError: false });
    const task = { source: 'slack', sourceRef: { channelId: slackThread.channelId, threadTs: slackThread.threadTs } };
    const raw = await fetchRawContext(task, callMcpTool, toolNames);
    expect(callMcpTool).toHaveBeenCalledWith('mcp__slack__slack_read_thread', {
      channel_id: slackThread.channelId,
      message_ts: slackThread.threadTs,
    });
    expect(raw).toBe(slackThread.rawText);
  });

  it('fetches a Linear issue via the correct workspace-prefixed tool', async () => {
    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const task = { source: 'linear', sourceRef: { workspaceLabel: 'Acme', issueId: 'ACME-3913' } };
    const raw = await fetchRawContext(task, callMcpTool, toolNames);
    expect(callMcpTool).toHaveBeenCalledWith('mcp__plugin_linear_linear__get_issue', { id: 'ACME-3913' });
    expect(raw).toEqual(acmeIssue);
  });

  it('fetches a Linear issue when workspaceLabel is a lowercase URL slug but the connector map uses the team\'s display casing (regression: found live via a real add-by-link Linear URL, e.g. "acme" vs "Acme")', async () => {
    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const task = { source: 'linear', sourceRef: { workspaceLabel: 'acme', issueId: 'ACME-3913' } };
    const raw = await fetchRawContext(task, callMcpTool, toolNames);
    expect(callMcpTool).toHaveBeenCalledWith('mcp__plugin_linear_linear__get_issue', { id: 'ACME-3913' });
    expect(raw).toEqual(acmeIssue);
  });

  it('returns null for an unconnected Linear workspace instead of throwing', async () => {
    const callMcpTool = vi.fn();
    const task = { source: 'linear', sourceRef: { workspaceLabel: 'SomeOtherWorkspace', issueId: 'X-1' } };
    const raw = await fetchRawContext(task, callMcpTool, toolNames);
    expect(raw).toBeNull();
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('returns null for manual/url sources without calling any tool', async () => {
    const callMcpTool = vi.fn();
    expect(await fetchRawContext({ source: 'manual' }, callMcpTool, toolNames)).toBeNull();
    expect(await fetchRawContext({ source: 'url' }, callMcpTool, toolNames)).toBeNull();
    expect(callMcpTool).not.toHaveBeenCalled();
  });
});
