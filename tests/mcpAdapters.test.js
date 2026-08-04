import { describe, it, expect, vi } from 'vitest';
import { unwrapMcpResult, fetchRawContext, slackThreadText, normalizeLinearWorkspace } from '../src/mcpAdapters.js';
import acmeIssue from './fixtures/linear-acme-issue.json' with { type: 'json' };
import slackThread from './fixtures/slack-thread.json' with { type: 'json' };

describe('unwrapMcpResult', () => {
  it('prefers structuredContent when present (Linear shape)', () => {
    const result = { content: [{ text: '{}' }], structuredContent: acmeIssue, isError: false };
    expect(unwrapMcpResult(result)).toEqual(acmeIssue);
  });

  it('falls back to content[0].text as plain text when the text is not JSON', () => {
    const result = { content: [{ text: slackThread.rawText }], isError: false };
    expect(unwrapMcpResult(result)).toBe(slackThread.rawText);
  });

  it('parses a JSON-encoded Slack envelope into an object — the behavior that made a bare-string assumption fail against real data', () => {
    const payload = { messages: slackThread.rawText, pagination_info: slackThread.paginationInfo };
    const result = { content: [{ text: JSON.stringify(payload) }], isError: false };
    expect(unwrapMcpResult(result)).toEqual(payload);
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

// Regression guard for a real production bug: slack_read_thread returns an
// ENVELOPE — {messages, pagination_info} — which unwrapMcpResult turns into an
// object. Code that assumed a bare string treated every real thread as
// unfetchable ("fetch-failed" for all of them), while the old bare-blob test
// fixture passed, because a non-JSON blob fails JSON.parse and falls through
// to a string. Reality always parses.
describe('slackThreadText', () => {
  it('extracts .messages from the real {messages, pagination_info} envelope', () => {
    const envelope = { messages: slackThread.rawText, pagination_info: slackThread.paginationInfo };
    expect(slackThreadText(envelope)).toBe(slackThread.rawText);
  });

  it('passes a bare string straight through (tolerates a simpler connector shape)', () => {
    expect(slackThreadText(slackThread.rawText)).toBe(slackThread.rawText);
  });

  it('returns null when there is no usable thread text, rather than an object that silently fails downstream', () => {
    expect(slackThreadText(null)).toBeNull();
    expect(slackThreadText({})).toBeNull();
    expect(slackThreadText({ pagination_info: 'x' })).toBeNull();
    expect(slackThreadText({ messages: 42 })).toBeNull();
  });

  it('composes with unwrapMcpResult on the exact real response, via both transports', () => {
    const payload = { messages: slackThread.rawText, pagination_info: slackThread.paginationInfo };
    const asText = { content: [{ text: JSON.stringify(payload) }], isError: false };
    const asStructured = { structuredContent: payload, isError: false };
    expect(slackThreadText(unwrapMcpResult(asText))).toBe(slackThread.rawText);
    expect(slackThreadText(unwrapMcpResult(asStructured))).toBe(slackThread.rawText);
  });
});

describe('fetchRawContext', () => {
  const toolNames = {
    slackReadThread: 'mcp__slack__slack_read_thread',
    linearWorkspaces: { Acme: 'mcp__plugin_linear_linear__' },
  };

  it('fetches a Slack thread and unwraps the real envelope down to its text', async () => {
    const callMcpTool = vi.fn().mockResolvedValue({
      content: [{ text: JSON.stringify({ messages: slackThread.rawText, pagination_info: slackThread.paginationInfo }) }],
      isError: false,
    });
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

describe('normalizeLinearWorkspace', () => {
  const workspaces = { Acme: 'mcp__la__', 'Global Corp': 'mcp__lg__' };

  it('returns the canonical label when the input matches a configured label exactly', () => {
    expect(normalizeLinearWorkspace('Acme', workspaces)).toBe('Acme');
  });

  it('returns the canonical label when input differs only in case', () => {
    expect(normalizeLinearWorkspace('acme', workspaces)).toBe('Acme');
    expect(normalizeLinearWorkspace('ACME', workspaces)).toBe('Acme');
  });

  it('returns the canonical label for a multi-word workspace matching case-insensitively', () => {
    expect(normalizeLinearWorkspace('global corp', workspaces)).toBe('Global Corp');
    expect(normalizeLinearWorkspace('GLOBAL CORP', workspaces)).toBe('Global Corp');
  });

  it('returns the input unchanged when no workspace matches', () => {
    expect(normalizeLinearWorkspace('UnknownWorkspace', workspaces)).toBe('UnknownWorkspace');
    expect(normalizeLinearWorkspace('other', workspaces)).toBe('other');
  });

  it('returns the input unchanged when the workspaces map is null or empty', () => {
    expect(normalizeLinearWorkspace('Acme', null)).toBe('Acme');
    expect(normalizeLinearWorkspace('Acme', {})).toBe('Acme');
  });

  it('handles undefined and null labels gracefully', () => {
    expect(normalizeLinearWorkspace(undefined, workspaces)).toBe(undefined);
    expect(normalizeLinearWorkspace(null, workspaces)).toBe(null);
  });
});
