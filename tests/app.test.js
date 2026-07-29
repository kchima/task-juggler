import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { nextStatus } from '../src/ui.js';
import acmeIssue from './fixtures/linear-acme-issue.json' with { type: 'json' };
import slackThread from './fixtures/slack-thread.json' with { type: 'json' };

const TOOL_NAMES = {
  slackReadThread: 'mcp__slack__slack_read_thread',
  slackSearch: 'mcp__slack__slack_search_public_and_private',
  linearWorkspaces: { Acme: 'mcp__plugin_linear_linear__' },
  todoistFindTasks: 'mcp__todoist__find-tasks',
};

function fakeStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => map.set(k, v),
  };
}

function linearTask(overrides = {}) {
  return {
    id: 'linear-task', title: acmeIssue.title, source: 'linear',
    sourceRef: { workspaceLabel: 'Acme', issueId: 'ACME-3913' },
    status: 'not_started', summary: '', nextAction: '', waitingOn: null,
    ballInUsersCourt: false, estRemaining: 'medium', dueDate: null,
    sourcePriority: null, priorityScore: 0, contextHash: null, lastAiRunAt: null,
    userPinnedStatus: false, createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z', ...overrides,
  };
}

const AI_RESPONSE = JSON.stringify({
  status: 'in_progress', summary: 'Backend fix in triage', nextAction: 'Decide backfill approach',
  waitingOn: 'user', ballInUsersCourt: true, estRemaining: 'medium', done: false,
});

describe('createApp.refreshAll', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  it('makes zero askClaude calls when the fetched context hash matches contextHash', async () => {
    const { djb2Hash } = await import('../src/hash.js');
    const { normalizeLinearIssue } = await import('../src/normalize.js');
    const matchingHash = djb2Hash(normalizeLinearIssue(acmeIssue));
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([linearTask({ contextHash: matchingHash })]));

    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });

    const { results } = await app.refreshAll({ force: true });
    expect(callMcpTool).toHaveBeenCalledTimes(1);
    expect(askClaude).not.toHaveBeenCalled();
    expect(results[0].aiCalled).toBe(false);
  });

  it('makes exactly one askClaude call and updates only that task when context changed', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({ id: 'changed', contextHash: 'stale-hash' }),
      { ...linearTask({ id: 'manual-task' }), source: 'manual', sourceRef: {}, title: 'Unrelated manual task' },
    ]));

    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const askClaude = vi.fn().mockResolvedValue(AI_RESPONSE);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });

    await app.refreshAll({ force: true });
    expect(askClaude).toHaveBeenCalledTimes(1);

    const tasks = app.getTasks();
    const changed = tasks.find((t) => t.id === 'changed');
    const untouched = tasks.find((t) => t.id === 'manual-task');
    expect(changed.status).toBe('in_progress');
    expect(changed.summary).toBe('Backend fix in triage');
    expect(untouched.title).toBe('Unrelated manual task');
  });

  it('skips manual, url, todoist, devin, and claude_code_session tasks entirely (no fetch, no AI call)', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      { ...linearTask({ id: 'm' }), source: 'manual', sourceRef: {} },
      { ...linearTask({ id: 'u' }), source: 'url', sourceRef: { url: 'https://x.com' } },
      { ...linearTask({ id: 't' }), source: 'todoist', sourceRef: { taskId: 'T1', projectId: 'P1' } },
      { ...linearTask({ id: 'd' }), source: 'devin', sourceRef: { url: 'https://app.devin.ai/sessions/abc' } },
      { ...linearTask({ id: 'c' }), source: 'claude_code_session', sourceRef: { sessionId: 'S1', pid: 1, cwd: '/x' } },
    ]));
    const callMcpTool = vi.fn();
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.refreshAll({ force: true });
    expect(callMcpTool).not.toHaveBeenCalled();
    expect(askClaude).not.toHaveBeenCalled();
  });

  it('does not override status when userPinnedStatus is true', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({ id: 'pinned', contextHash: 'stale', userPinnedStatus: true, status: 'waiting_other' }),
    ]));
    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const askClaude = vi.fn().mockResolvedValue(AI_RESPONSE);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.refreshAll({ force: true });
    expect(app.getTasks()[0].status).toBe('waiting_other');
    expect(app.getTasks()[0].summary).toBe('Backend fix in triage');
  });

  it('keeps previous fields and does not persist a new contextHash when the AI response fails to parse', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({ id: 'x', contextHash: 'stale', summary: 'old summary' }),
    ]));
    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const askClaude = vi.fn().mockResolvedValue('not valid json');
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.refreshAll({ force: true });
    const task = app.getTasks()[0];
    expect(task.summary).toBe('old summary');
    expect(task.contextHash).toBe('stale');
  });

  it('is debounced: a second call within 30s without force is skipped', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([linearTask({ id: 'x' })]));
    const callMcpTool = vi.fn().mockResolvedValue({ structuredContent: acmeIssue, isError: false });
    const askClaude = vi.fn().mockResolvedValue(AI_RESPONSE);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.refreshAll({ force: true });
    callMcpTool.mockClear();
    const second = await app.refreshAll();
    expect(second.skipped).toBe(true);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('limits concurrency to 3 in-flight fetches at a time', async () => {
    const tasks = Array.from({ length: 6 }, (_, i) => linearTask({ id: `t${i}`, contextHash: `stale-${i}` }));
    storage.setItem('task-juggler:tasks:v1', JSON.stringify(tasks));
    let inFlight = 0;
    let maxInFlight = 0;
    const callMcpTool = vi.fn(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { structuredContent: acmeIssue, isError: false };
    });
    const askClaude = vi.fn().mockResolvedValue(AI_RESPONSE);
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.refreshAll({ force: true });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });
});

describe('createApp manual operations', () => {
  let storage, app;
  beforeEach(() => {
    storage = fakeStorage();
    app = createApp({ storage, callMcpTool: vi.fn(), askClaude: vi.fn(), toolNames: TOOL_NAMES });
  });

  it('addManualTask creates a not_started manual task', () => {
    const task = app.addManualTask('Write the quarterly report');
    expect(task.source).toBe('manual');
    expect(task.status).toBe('not_started');
    expect(app.getTasks()).toHaveLength(1);
  });

  it('addByLink recognizes a real Slack permalink and creates a slack task', () => {
    const url = 'https://acme.slack.com/archives/C01EXAMPLE1/p1784829904373009?thread_ts=1784829904.373009&cid=C01EXAMPLE1';
    const task = app.addByLink(url);
    expect(task.source).toBe('slack');
    expect(task.sourceRef.threadTs).toBe(slackThread.threadTs);
  });

  it('cycleStatusManual sets userPinnedStatus', () => {
    const task = app.addManualTask('x');
    const updated = app.cycleStatusManual(task.id, nextStatus);
    expect(updated.userPinnedStatus).toBe(true);
    expect(updated.status).toBe('in_progress');
  });

  it('reopen resets a completed task to not_started and pins it', () => {
    const task = app.addManualTask('x');
    app.cycleStatusManual(task.id, () => 'completed');
    const reopened = app.reopen(task.id);
    expect(reopened.status).toBe('not_started');
    expect(reopened.userPinnedStatus).toBe(true);
  });

  it('remove deletes the task', () => {
    const task = app.addManualTask('x');
    app.remove(task.id);
    expect(app.getTasks()).toHaveLength(0);
  });
});

describe('createApp.discoverNewTasks', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  const REAL_ISH_SLACK_SEARCH_TEXT = [
    'Channel: #engineering (ID: C01EXAMPLE1)',
    'From: Devin (ID: U03EXAMPLE3)  [BOT]',
    'Permalink: [link](https://acme.slack.com/archives/C01EXAMPLE1/p1784833812477119?thread_ts=1784829904.373009&cid=C01EXAMPLE1)',
  ].join('\n');

  function mockCallMcpTool({ linearIssues = [], todoistTasks = [], slackSearchText = '' } = {}) {
    return vi.fn(async (name) => {
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) {
        return { structuredContent: { issues: linearIssues }, isError: false };
      }
      if (name === TOOL_NAMES.todoistFindTasks) {
        return { structuredContent: { tasks: todoistTasks }, isError: false };
      }
      if (name === TOOL_NAMES.slackSearch) {
        return { content: [{ text: slackSearchText }], isError: false };
      }
      if (name === TOOL_NAMES.slackReadThread) {
        return { content: [{ text: slackThread.rawText }], isError: false };
      }
      throw new Error(`unexpected tool call: ${name}`);
    });
  }

  it('adds an unresolved Linear issue assigned to me as a candidate task', async () => {
    const callMcpTool = mockCallMcpTool({ linearIssues: [{ ...acmeIssue, statusType: 'triage' }] });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(1);
    const task = app.getTasks()[0];
    expect(task.source).toBe('linear');
    expect(task.sourceRef).toEqual({ workspaceLabel: 'Acme', issueId: 'ACME-3913', url: acmeIssue.url });
  });

  it('does not add a resolved (completed) Linear issue', async () => {
    const callMcpTool = mockCallMcpTool({ linearIssues: [{ ...acmeIssue, statusType: 'completed' }] });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(0);
  });

  it('adds a Todoist item that passes the judgment gate (p1) but not one that fails it (p3, no due date)', async () => {
    const callMcpTool = mockCallMcpTool({
      todoistTasks: [
        { id: 'T1', content: 'Renew the line', priority: 'p1', dueDate: null, projectId: 'P1' },
        { id: 'T2', content: 'Water the plants', priority: 'p3', dueDate: null, projectId: 'P1' },
      ],
    });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(1);
    expect(app.getTasks()[0].sourceRef.taskId).toBe('T1');
  });

  it('adds a Slack thread only when the AI judgment says it needs attention', async () => {
    const callMcpTool = mockCallMcpTool({ slackSearchText: REAL_ISH_SLACK_SEARCH_TEXT });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify({ needsAttention: true, reason: 'Devin asked a question' }));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(1);
    const task = app.getTasks()[0];
    expect(task.source).toBe('slack');
    expect(task.sourceRef).toEqual({
      channelId: 'C01EXAMPLE1',
      threadTs: '1784829904.373009',
      workspaceDomain: 'acme.slack.com',
    });
    expect(task.title).toBe('Devin asked a question');
  });

  it('does not add a Slack thread the AI judges as not needing attention', async () => {
    const callMcpTool = mockCallMcpTool({ slackSearchText: REAL_ISH_SLACK_SEARCH_TEXT });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify({ needsAttention: false, reason: 'already resolved' }));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const { added } = await app.discoverNewTasks();
    expect(added).toBe(0);
  });

  it('does not re-classify (no askClaude call) a Slack thread already tracked', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({ id: 'existing-slack', source: 'slack', sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' } }),
    ]));
    const callMcpTool = mockCallMcpTool({ slackSearchText: REAL_ISH_SLACK_SEARCH_TEXT });
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.discoverNewTasks();
    expect(askClaude).not.toHaveBeenCalled();
  });

  it('running discoverNewTasks twice does not duplicate candidates', async () => {
    const callMcpTool = mockCallMcpTool({ linearIssues: [{ ...acmeIssue, statusType: 'triage' }] });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    await app.discoverNewTasks();
    const second = await app.discoverNewTasks();
    expect(second.added).toBe(0);
    expect(app.getTasks()).toHaveLength(1);
  });
});
