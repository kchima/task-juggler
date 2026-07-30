import { describe, it, expect, vi } from 'vitest';
import { unwrapMcpResult, fetchRawContext, slackThreadText, summarizeMcpShape, probeTool } from '../src/mcpAdapters.js';
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

describe('summarizeMcpShape / probeTool', () => {
  it('names the envelope keys, which is the question a shape description keeps getting wrong', () => {
    const payload = { messages: slackThread.rawText, pagination_info: slackThread.paginationInfo };
    const shape = summarizeMcpShape({ content: [{ text: JSON.stringify(payload) }], isError: false });
    expect(shape.unwrappedType).toBe('object');
    expect(shape.unwrappedKeys).toEqual(['messages', 'pagination_info']);
    // Both values are strings here, so this points straight at the candidates
    // for "where does the actual payload live".
    expect(shape.stringValuedKeys).toEqual(['messages', 'pagination_info']);
    expect(shape.hasStructuredContent).toBe(false);
    expect(shape.contentTextType).toBe('string');
  });

  it('reports a bare prose response as a string with no envelope, distinguishing it from an enveloped one', () => {
    const prose = 'Sessions (3 of 195, most recent first)\n - abc "Some title" (idle, cwd: /x, is_child: false)\n';
    const shape = summarizeMcpShape({ content: [{ text: prose }], isError: false });
    expect(shape.unwrappedType).toBe('string');
    expect(shape.unwrappedKeys).toBeNull();
    expect(shape.rawJson).toContain('is_child');
  });

  // The rawJson dump escapes newlines, so a prose payload collapses to one
  // unreadable line there — useless for the case the probe exists to serve.
  // These previews keep the real line breaks.
  it('exposes a prose payload with its real line breaks, not JSON-escaped', () => {
    const prose = 'Sessions (3 of 195)\n - abc "Some title" (idle, cwd: /x, is_child: false)\n';
    const shape = summarizeMcpShape({ content: [{ text: prose }], isError: false });
    expect(shape.payloadPreviews).toEqual([{ key: '(whole response)', text: prose }]);
    expect(shape.payloadPreviews[0].text).toContain('\n'); // a real newline
    expect(shape.rawJson).toContain('\\n');                // escaped in the dump
  });

  it('exposes each string-valued envelope key separately, so the payload key is obvious', () => {
    const prose = 'Sessions (3 of 195)\n - abc "T" (idle, cwd: /x, is_child: false)\n';
    const shape = summarizeMcpShape({ content: [{ text: JSON.stringify({ sessions: prose, pagination_info: 'end' }) }], isError: false });
    expect(shape.payloadPreviews).toEqual([
      { key: 'sessions', text: prose },
      { key: 'pagination_info', text: 'end' },
    ]);
  });

  it('has no string payloads to preview for an array response', () => {
    const shape = summarizeMcpShape({ structuredContent: [{ sessionId: 's1' }], isError: false });
    expect(shape.payloadPreviews).toEqual([]);
  });

  it('reports an array response (the verified ccd_session_mgmt shape) as an array, not an object', () => {
    const sessions = [{ sessionId: 's1', title: 'T', cwd: '/x', isArchived: false, isRunning: false, lastActivityAt: '2026-07-25T04:41:50.813Z' }];
    const shape = summarizeMcpShape({ structuredContent: sessions, isError: false });
    expect(shape.unwrappedType).toBe('array');
    expect(shape.hasStructuredContent).toBe(true);
  });

  it('probeTool reports an unreachable tool as a result rather than throwing — "not exposed here" is the answer, not an error', async () => {
    const callMcpTool = vi.fn().mockRejectedValue(new Error('No such tool available'));
    const report = await probeTool(callMcpTool, 'mcp__session_info__list_sessions', { limit: 3 });
    expect(report.reachable).toBe(false);
    expect(report.error).toBe('No such tool available');
    expect(report.shape).toBeNull();
    expect(report.name).toBe('mcp__session_info__list_sessions');
  });

  it('probeTool returns the shape summary for a reachable tool', async () => {
    const callMcpTool = vi.fn().mockResolvedValue({ content: [{ text: 'Sessions (0 of 0)' }], isError: false });
    const report = await probeTool(callMcpTool, 'mcp__x__list_sessions', { limit: 3 });
    expect(report.reachable).toBe(true);
    expect(report.shape.unwrappedType).toBe('string');
    expect(callMcpTool).toHaveBeenCalledWith('mcp__x__list_sessions', { limit: 3 });
  });

  it('truncates a huge response instead of dumping an unbounded blob into the UI', () => {
    const huge = { content: [{ text: 'x'.repeat(20000) }], isError: false };
    expect(summarizeMcpShape(huge).rawJson.length).toBeLessThanOrEqual(4000);
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
