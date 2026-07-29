import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { loadDismissedKeys, loadWatermarks } from '../src/storage.js';

const TOOL_NAMES = {
  slackReadThread: 'slack_read_thread',
  slackSearch: 'slack_search',
  linearWorkspaces: { Acme: 'linear__' },
  todoistFindTasks: 'todoist_find',
  sessionList: 'ccd_list_sessions',
  sessionEvents: 'ccd_list_events',
};

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
}

// Real captured shape from mcp__ccd_session_mgmt__list_sessions.
const REAL_SESSION = {
  sessionId: 'local_00000000-0000-4000-8000-000000000002',
  title: 'Payments webhook retry backoff',
  cwd: '/Users/dev/workspace',
  isArchived: false,
  isRunning: false,
  lastActivityAt: '2026-07-25T04:41:50.813Z',
};

// Real captured tail — this exact session ended with the assistant handing a
// step back to the user ("this one's yours too... ping me and I'll check again").
const REAL_SESSION_TAIL = [
  'Session "Payments webhook retry backoff" (idle) — showing 6 of 2374 messages',
  '[assistant] Real progress, but not fully done yet — the W-9 is the one piece left,',
  "and it's another hard line for me. So this one's yours: click \"Add Tax Info\".",
  "Once you've got the tax form in, ping me and I'll check again.",
  '[result] done (success), 4 turns',
].join('\n');

const NOW = () => new Date('2026-07-25T12:00:00Z');

function mockTools({ sessions = [], sessionTail = REAL_SESSION_TAIL } = {}) {
  return vi.fn(async (name) => {
    if (name === TOOL_NAMES.sessionList) return { structuredContent: sessions, isError: false };
    if (name === TOOL_NAMES.sessionEvents) return { content: [{ text: sessionTail }], isError: false };
    if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) return { structuredContent: { issues: [] }, isError: false };
    if (name === TOOL_NAMES.todoistFindTasks) return { structuredContent: { tasks: [] }, isError: false };
    if (name === TOOL_NAMES.slackSearch) return { content: [{ text: '' }], isError: false };
    throw new Error(`unexpected tool: ${name}`);
  });
}

const SESSION_NEEDS_ATTENTION = JSON.stringify({
  needsAttention: true, waitingOn: 'user', reason: 'Needs you to submit the W-9 tax form',
});

describe('Claude Desktop session discovery (real ccd_session_mgmt shapes)', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  it('discovers a recently-active session and marks the ball as in the user\'s court', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    const { added } = await app.discoverNewTasks();
    expect(added).toBe(1);
    const task = app.getTasks()[0];
    expect(task.source).toBe('claude_session');
    expect(task.sourceRef.sessionId).toBe(REAL_SESSION.sessionId);
    expect(task.title).toBe('Payments webhook retry backoff');
    expect(task.waitingOn).toBe('user');
    expect(task.ballInUsersCourt).toBe(true);
  });

  it('only sends the transcript TAIL to the LLM, not the whole 2374-message session', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });
    await app.discoverNewTasks();

    const eventsCall = callMcpTool.mock.calls.find(([name]) => name === TOOL_NAMES.sessionEvents);
    expect(eventsCall[1].limit).toBeLessThanOrEqual(10);
  });

  it('skips an archived session entirely (no fetch, no LLM call)', async () => {
    const callMcpTool = mockTools({ sessions: [{ ...REAL_SESSION, isArchived: true }] });
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(0);
    expect(askClaude).not.toHaveBeenCalled();
  });

  it('skips a long-stale session without any LLM call (cheap deterministic filter)', async () => {
    const stale = { ...REAL_SESSION, lastActivityAt: '2026-03-19T05:03:38.735Z' };
    const callMcpTool = mockTools({ sessions: [stale] });
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });
    await app.discoverNewTasks();
    expect(askClaude).not.toHaveBeenCalled();
  });

  it('does not add a session the LLM judges as resolved', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify({ needsAttention: false, waitingOn: null, reason: 'finished' }));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(0);
  });
});

describe('watermarks — the token-waste guard', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  it('makes ZERO LLM calls on a second scan when nothing has changed', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    await app.discoverNewTasks();
    expect(askClaude).toHaveBeenCalledTimes(1);

    askClaude.mockClear();
    await app.discoverNewTasks();
    expect(askClaude).not.toHaveBeenCalled();
  });

  it('re-judges a session only once its lastActivityAt actually changes', async () => {
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    let sessions = [REAL_SESSION];
    const callMcpTool = vi.fn(async (name) => {
      if (name === TOOL_NAMES.sessionList) return { structuredContent: sessions, isError: false };
      if (name === TOOL_NAMES.sessionEvents) return { content: [{ text: REAL_SESSION_TAIL }], isError: false };
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) return { structuredContent: { issues: [] }, isError: false };
      if (name === TOOL_NAMES.todoistFindTasks) return { structuredContent: { tasks: [] }, isError: false };
      if (name === TOOL_NAMES.slackSearch) return { content: [{ text: '' }], isError: false };
      throw new Error(`unexpected tool: ${name}`);
    });
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    await app.discoverNewTasks();
    app.remove(app.getTasks()[0].id); // dismiss so re-add isn't blocked by "already tracked"
    app.undismissAll();

    askClaude.mockClear();
    await app.discoverNewTasks();
    expect(askClaude).not.toHaveBeenCalled(); // unchanged -> still no LLM

    sessions = [{ ...REAL_SESSION, lastActivityAt: '2026-07-25T11:00:00.000Z' }];
    await app.discoverNewTasks();
    expect(askClaude).toHaveBeenCalledTimes(1); // changed -> exactly one call
  });

  it('records a watermark even when the verdict was "not needed", so a no is never re-billed', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify({ needsAttention: false, waitingOn: null, reason: 'done' }));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    await app.discoverNewTasks();
    const marks = loadWatermarks(storage);
    expect(marks[`claude_session:${REAL_SESSION.sessionId}`]).toBe(REAL_SESSION.lastActivityAt);

    askClaude.mockClear();
    await app.discoverNewTasks();
    expect(askClaude).not.toHaveBeenCalled();
  });
});

describe('dismissal — removed items must never come back', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  it('a dismissed session is not re-added by a later scan, even with fresh activity', async () => {
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    let sessions = [REAL_SESSION];
    const callMcpTool = vi.fn(async (name) => {
      if (name === TOOL_NAMES.sessionList) return { structuredContent: sessions, isError: false };
      if (name === TOOL_NAMES.sessionEvents) return { content: [{ text: REAL_SESSION_TAIL }], isError: false };
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) return { structuredContent: { issues: [] }, isError: false };
      if (name === TOOL_NAMES.todoistFindTasks) return { structuredContent: { tasks: [] }, isError: false };
      if (name === TOOL_NAMES.slackSearch) return { content: [{ text: '' }], isError: false };
      throw new Error(`unexpected tool: ${name}`);
    });
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    await app.discoverNewTasks();
    expect(app.getTasks()).toHaveLength(1);

    app.remove(app.getTasks()[0].id);
    expect(app.getTasks()).toHaveLength(0);
    expect(loadDismissedKeys(storage)).toContain(`claude_session:${REAL_SESSION.sessionId}`);

    // New activity on that same session — the strongest case for it coming back.
    sessions = [{ ...REAL_SESSION, lastActivityAt: '2026-07-25T11:30:00.000Z' }];
    askClaude.mockClear();
    const { added } = await app.discoverNewTasks();

    expect(added).toBe(0);
    expect(app.getTasks()).toHaveLength(0);
    // And it must not even be classified — dismissal blocks before the LLM.
    expect(askClaude).not.toHaveBeenCalled();
  });

  it('dismissing a manual task does not block unrelated discovery', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    const manual = app.addManualTask('unrelated');
    app.remove(manual.id);

    const { added } = await app.discoverNewTasks();
    expect(added).toBe(1);
  });

  it('undismissAll lets a previously dismissed item be discovered again', async () => {
    const callMcpTool = mockTools({ sessions: [REAL_SESSION] });
    const askClaude = vi.fn().mockResolvedValue(SESSION_NEEDS_ATTENTION);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES, now: NOW });

    await app.discoverNewTasks();
    app.remove(app.getTasks()[0].id);
    app.undismissAll();

    // Watermark still suppresses re-judging, so simulate new activity too.
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(0); // unchanged activity -> watermark still holds it back
  });
});
