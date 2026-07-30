import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createApp } from '../src/app.js';
import { nextStatus } from '../src/ui.js';
import { buildSlackRecentQueries } from '../src/discovery.js';
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

  function mockCallMcpTool({ linearIssues = [], todoistTasks = [] } = {}) {
    return vi.fn(async (name) => {
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) {
        return { structuredContent: { issues: linearIssues }, isError: false };
      }
      if (name === TOOL_NAMES.todoistFindTasks) {
        return { structuredContent: { tasks: todoistTasks }, isError: false };
      }
      throw new Error(`unexpected tool call: ${name}`);
    });
  }

  it('never touches Slack — that is runSlackTriage\'s job now, not discoverNewTasks\'', async () => {
    const callMcpTool = mockCallMcpTool();
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    await app.discoverNewTasks();
    expect(callMcpTool).not.toHaveBeenCalledWith(TOOL_NAMES.slackSearch, expect.anything());
    expect(callMcpTool).not.toHaveBeenCalledWith(TOOL_NAMES.slackReadThread, expect.anything());
  });

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

  it('running discoverNewTasks twice does not duplicate candidates', async () => {
    const callMcpTool = mockCallMcpTool({ linearIssues: [{ ...acmeIssue, statusType: 'triage' }] });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    await app.discoverNewTasks();
    const second = await app.discoverNewTasks();
    expect(second.added).toBe(0);
    expect(app.getTasks()).toHaveLength(1);
  });
});

describe('createApp.runSlackTriage', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  const REAL_ISH_SLACK_SEARCH_TEXT = [
    'Channel: #engineering (ID: C01EXAMPLE1)',
    'From: Devin (ID: U03EXAMPLE3)  [BOT]',
    'Permalink: [link](https://acme.slack.com/archives/C01EXAMPLE1/p1784833812477119?thread_ts=1784829904.373009&cid=C01EXAMPLE1)',
  ].join('\n');

  const ONGOING_VERDICT = [{
    threadKey: 'slack:C01EXAMPLE1:1784829904.373009',
    isOngoing: true, ballInUsersCourt: true, waitingOn: 'user',
    status: 'in_progress', summary: 'Devin is waiting on a go/no-go', reason: 'unanswered bot question',
  }];
  const RESOLVED_VERDICT = [{
    threadKey: 'slack:C01EXAMPLE1:1784829904.373009',
    isOngoing: false, ballInUsersCourt: false, waitingOn: null,
    status: 'completed', summary: 'All set, thread resolved', reason: 'thanked and confirmed',
  }];

  function mockCallMcpTool({ rawText = slackThread.rawText } = {}) {
    return vi.fn(async (name, args) => {
      if (name === TOOL_NAMES.slackSearch) {
        return { content: [{ text: REAL_ISH_SLACK_SEARCH_TEXT }], isError: false };
      }
      if (name === TOOL_NAMES.slackReadThread) {
        return { content: [{ text: rawText }], isError: false };
      }
      throw new Error(`unexpected tool call: ${name} ${JSON.stringify(args)}`);
    });
  }

  it('queries Slack with two plain single-clause searches, never a combined OR/paren query', async () => {
    const callMcpTool = mockCallMcpTool();
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT)), toolNames: TOOL_NAMES });
    await app.runSlackTriage({ force: true });
    const searchCalls = callMcpTool.mock.calls.filter(([name]) => name === TOOL_NAMES.slackSearch);
    expect(searchCalls).toHaveLength(2);
    for (const [, args] of searchCalls) {
      expect(args.query).not.toContain('(');
      expect(args.query).not.toContain('OR');
    }
  });

  it('adds a new task from an untracked thread the batch verdict calls ongoing', async () => {
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });

    expect(askClaude).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ scanned: 1, ongoing: 1, added: 1, updated: 0, skippedResolved: 0 });
    const task = app.getTasks()[0];
    expect(task.source).toBe('slack');
    expect(task.sourceRef).toEqual({ channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009', workspaceDomain: 'acme.slack.com' });
    expect(task.summary).toBe('Devin is waiting on a go/no-go');
  });

  it('never adds an untracked thread the batch verdict calls resolved — only already-tracked tasks get marked completed', async () => {
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(RESOLVED_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });

    expect(result).toMatchObject({ scanned: 1, ongoing: 0, added: 0, skippedResolved: 1 });
    expect(app.getTasks()).toHaveLength(0);
  });

  it('patches an already-tracked Slack task in place instead of adding a duplicate', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({
        id: 'existing-slack', source: 'slack',
        sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
        contextHash: 'stale-hash', status: 'not_started',
      }),
    ]));
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(RESOLVED_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });

    expect(result).toMatchObject({ scanned: 1, updated: 1, added: 0, skippedResolved: 0 });
    expect(app.getTasks()).toHaveLength(1);
    const task = app.getTasks()[0];
    expect(task.id).toBe('existing-slack');
    expect(task.status).toBe('completed');
    expect(task.summary).toBe('All set, thread resolved');
  });

  it('does not override status on a patch when userPinnedStatus is true', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({
        id: 'pinned-slack', source: 'slack',
        sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
        contextHash: 'stale-hash', status: 'waiting_other', userPinnedStatus: true,
      }),
    ]));
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.runSlackTriage({ force: true });
    expect(app.getTasks()[0].status).toBe('waiting_other');
    expect(app.getTasks()[0].summary).toBe('Devin is waiting on a go/no-go');
  });

  it('makes zero askClaude calls when a tracked thread\'s content hash is unchanged', async () => {
    const { djb2Hash } = await import('../src/hash.js');
    const { normalizeSlackThread } = await import('../src/normalize.js');
    const matchingHash = djb2Hash(normalizeSlackThread(slackThread.rawText));
    // Slack's stored signal is versioned ("v1:<hash>", see SLACK_JUDGMENT_VERSION
    // in app.js) so a future prompt/criteria change can invalidate every past
    // verdict at once — content-unchanged and verdict-still-valid aren't the
    // same claim. A bare hash here would (correctly) look stale and re-trigger
    // classification, which is exactly what this test is checking does NOT happen.
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({
        id: 'unchanged-slack', source: 'slack',
        sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
        contextHash: `v1:${matchingHash}`,
      }),
    ]));
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });
    expect(askClaude).not.toHaveBeenCalled();
    expect(result.aiCalled).toBe(false);
    expect(result.scanned).toBe(1);
  });

  it('does not re-classify an untracked resolved thread on a second scan (watermarked)', async () => {
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(RESOLVED_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.runSlackTriage({ force: true });
    askClaude.mockClear();
    const second = await app.runSlackTriage({ force: true });
    expect(askClaude).not.toHaveBeenCalled();
    expect(second.aiCalled).toBe(false);
  });

  // The actual bug this locks in: "content unchanged" and "verdict still
  // valid" are different claims. A watermark written under an old judgment
  // version must not be trusted just because the thread's content happens
  // to be identical — otherwise a thread that was ever misjudged (or judged
  // under stale criteria) becomes permanently invisible, even after the
  // classification logic improves.
  it('a watermark written under a stale judgment version is treated as changed, not unchanged, even though the content is identical', async () => {
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(RESOLVED_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.runSlackTriage({ force: true }); // writes a "v1:<hash>" watermark

    // Simulate a judgment-version bump by corrupting the stored watermark to
    // look like it came from a different (older) version, same content hash.
    const marks = JSON.parse(storage.getItem('task-juggler:watermarks:v1'));
    const key = Object.keys(marks).find((k) => k.startsWith('slack:'));
    marks[key] = marks[key].replace(/^v\d+:/, 'v0:');
    storage.setItem('task-juggler:watermarks:v1', JSON.stringify(marks));

    askClaude.mockClear();
    const second = await app.runSlackTriage({ force: true });
    expect(askClaude).toHaveBeenCalledTimes(1); // re-classified despite unchanged content
    expect(second.aiCalled).toBe(true);
  });

  it('an already-tracked thread patched under a stale judgment version is re-classified, not skipped as unchanged', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({
        id: 'stale-version-slack', source: 'slack',
        sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
        contextHash: 'v0:some-old-hash-format', // wrong version prefix, regardless of hash value
      }),
    ]));
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });
    expect(askClaude).toHaveBeenCalledTimes(1);
    expect(result.updated).toBe(1);
  });

  it('a newly-added Slack task is stored with a real contextHash, not null, so the very next scan does not needlessly re-classify it', async () => {
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.runSlackTriage({ force: true });

    const added = app.getTasks().find((t) => t.source === 'slack');
    expect(added.contextHash).not.toBeNull();

    askClaude.mockClear();
    const second = await app.runSlackTriage({ force: true });
    expect(askClaude).not.toHaveBeenCalled();
    expect(second.aiCalled).toBe(false);
  });

  it('leaves a thread the model dropped from its response untouched, without watermarking it (so it is retried, not stuck)', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({
        id: 'dropped-slack', source: 'slack',
        sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
        contextHash: 'stale-hash', status: 'not_started', summary: 'old summary',
      }),
    ]));
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify([])); // model returned an empty array — dropped the one thread
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });
    expect(result.unparsed).toBe(1);
    expect(app.getTasks()[0].summary).toBe('old summary');

    askClaude.mockClear();
    askClaude.mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const second = await app.runSlackTriage({ force: true });
    expect(askClaude).toHaveBeenCalledTimes(1); // retried, not permanently skipped
    expect(second.updated).toBe(1);
  });

  it('is debounced independently from refreshAll: a second call within 30s without force is skipped', async () => {
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    await app.runSlackTriage({ force: true });
    callMcpTool.mockClear();
    const second = await app.runSlackTriage();
    expect(second.skipped).toBe(true);
    expect(callMcpTool).not.toHaveBeenCalled();
  });

  it('refreshOne on a tracked Slack task routes through the same batch classifier as a single-item batch', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({
        id: 'refresh-one-slack', source: 'slack',
        sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
        contextHash: 'stale-hash',
      }),
    ]));
    const callMcpTool = mockCallMcpTool();
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify(ONGOING_VERDICT));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const { task, aiCalled } = await app.refreshOne('refresh-one-slack');
    expect(aiCalled).toBe(true);
    expect(task.summary).toBe('Devin is waiting on a go/no-go');
    expect(callMcpTool).not.toHaveBeenCalledWith(TOOL_NAMES.slackSearch, expect.anything());
  });
});

// A live probe against a real Slack/Linear/Todoist connector found that an
// "invalidated, needs reconnect" connector rejects the callMcpTool call
// outright (not a normal {isError:true} response) — these tests lock in
// that one source failing this way must never take the others down with it.
describe('createApp resilience — one failing connector must not block the others', () => {
  let storage;
  beforeEach(() => { storage = fakeStorage(); });

  it('one Linear workspace throwing does not block issues from another workspace, and reports its own error', async () => {
    const TWO_WORKSPACE_TOOL_NAMES = {
      ...TOOL_NAMES,
      linearWorkspaces: { Acme: 'mcp__linearacme__', Globex: 'mcp__linearglobex__' },
    };
    const callMcpTool = vi.fn(async (name) => {
      if (name === 'mcp__linearacme__list_issues') {
        throw new Error('connector invalidated, needs reconnect');
      }
      if (name === 'mcp__linearglobex__list_issues') {
        return { structuredContent: { issues: [{ ...acmeIssue, id: 'GLBX-1', statusType: 'triage' }] }, isError: false };
      }
      if (name === TOOL_NAMES.todoistFindTasks) {
        return { structuredContent: { tasks: [] }, isError: false };
      }
      throw new Error(`unexpected tool call: ${name}`);
    });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TWO_WORKSPACE_TOOL_NAMES });
    const { added, errors } = await app.discoverNewTasks();

    expect(added).toBe(1);
    expect(app.getTasks()[0].sourceRef.issueId).toBe('GLBX-1');
    expect(errors).toEqual(['Linear (Acme): connector invalidated, needs reconnect']);
  });

  it('Todoist throwing does not block Linear, and reports its own error', async () => {
    const callMcpTool = vi.fn(async (name) => {
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) {
        return { structuredContent: { issues: [{ ...acmeIssue, statusType: 'triage' }] }, isError: false };
      }
      if (name === TOOL_NAMES.todoistFindTasks) {
        throw new Error('connector invalidated, needs reconnect');
      }
      throw new Error(`unexpected tool call: ${name}`);
    });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: TOOL_NAMES });
    const { added, errors } = await app.discoverNewTasks();

    expect(added).toBe(1);
    expect(app.getTasks()[0].source).toBe('linear');
    expect(errors).toEqual(['Todoist: connector invalidated, needs reconnect']);
  });

  it('the Claude session list call throwing reports its own error without blocking Linear/Todoist', async () => {
    const sessionToolNames = { ...TOOL_NAMES, sessionList: 'mcp__ccd__list_sessions', sessionEvents: 'mcp__ccd__list_events' };
    const callMcpTool = vi.fn(async (name) => {
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) return { structuredContent: { issues: [] }, isError: false };
      if (name === TOOL_NAMES.todoistFindTasks) return { structuredContent: { tasks: [] }, isError: false };
      if (name === 'mcp__ccd__list_sessions') throw new Error('connector invalidated, needs reconnect');
      throw new Error(`unexpected tool call: ${name}`);
    });
    const app = createApp({ storage, callMcpTool, askClaude: vi.fn(), toolNames: sessionToolNames });
    const { errors } = await app.discoverNewTasks();
    expect(errors).toEqual(['Claude sessions: connector invalidated, needs reconnect']);
  });

  it('one session\'s event-tail fetch throwing only skips that session, not the rest of the batch', async () => {
    const sessionToolNames = { ...TOOL_NAMES, sessionList: 'mcp__ccd__list_sessions', sessionEvents: 'mcp__ccd__list_events' };
    const goodSession = { sessionId: 'good', title: 'Good session', cwd: '/x', isArchived: false, isRunning: false, lastActivityAt: '2026-07-25T04:41:50.813Z' };
    const badSession = { sessionId: 'bad', title: 'Bad session', cwd: '/x', isArchived: false, isRunning: false, lastActivityAt: '2026-07-25T04:41:50.813Z' };
    const callMcpTool = vi.fn(async (name, args) => {
      if (name === `${TOOL_NAMES.linearWorkspaces.Acme}list_issues`) return { structuredContent: { issues: [] }, isError: false };
      if (name === TOOL_NAMES.todoistFindTasks) return { structuredContent: { tasks: [] }, isError: false };
      if (name === 'mcp__ccd__list_sessions') return { structuredContent: [goodSession, badSession], isError: false };
      if (name === 'mcp__ccd__list_events' && args.session_id === 'bad') throw new Error('transcript read failed');
      if (name === 'mcp__ccd__list_events') return { content: [{ text: 'Real progress, but needs you: click Add Tax Info.' }], isError: false };
      throw new Error(`unexpected tool call: ${name}`);
    });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify({ needsAttention: true, waitingOn: 'user', reason: 'needs input' }));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: sessionToolNames, now: () => new Date('2026-07-25T12:00:00Z') });
    const { added, errors } = await app.discoverNewTasks();

    expect(added).toBe(1);
    expect(app.getTasks()[0].sourceRef.sessionId).toBe('good');
    expect(errors).toEqual([]); // a per-session skip isn't surfaced as a source-level error
  });

  it('a Linear task refresh throwing is reported per-task without blocking other tasks in the same refreshAll batch', async () => {
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([
      linearTask({ id: 'broken', contextHash: 'stale', title: 'Broken Linear task' }),
      { ...linearTask({ id: 'manual-task' }), source: 'manual', sourceRef: {}, title: 'Unrelated manual task' },
    ]));
    const callMcpTool = vi.fn(async () => { throw new Error('connector invalidated, needs reconnect'); });
    const askClaude = vi.fn();
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const { results, errors } = await app.refreshAll({ force: true });

    expect(errors).toEqual(['Broken Linear task: connector invalidated, needs reconnect']);
    const broken = results.find((r) => r.task.id === 'broken');
    expect(broken.aiCalled).toBe(false);
    expect(broken.task.summary).toBe(''); // untouched, not corrupted
    expect(app.getTasks().find((t) => t.id === 'manual-task').title).toBe('Unrelated manual task');
  });

  it('one Slack search query throwing does not block the other query or already-tracked threads, and reports its own error', async () => {
    const REAL_ISH_SLACK_SEARCH_TEXT = [
      'Channel: #engineering (ID: C01EXAMPLE1)',
      'Permalink: [link](https://acme.slack.com/archives/C01EXAMPLE1/p1784833812477119?thread_ts=1784829904.373009&cid=C01EXAMPLE1)',
    ].join('\n');
    const callMcpTool = vi.fn(async (name, args) => {
      if (name === TOOL_NAMES.slackSearch && args.query.includes('to:me')) {
        throw new Error('connector invalidated, needs reconnect');
      }
      if (name === TOOL_NAMES.slackSearch) {
        return { content: [{ text: REAL_ISH_SLACK_SEARCH_TEXT }], isError: false };
      }
      if (name === TOOL_NAMES.slackReadThread) {
        return { content: [{ text: slackThread.rawText }], isError: false };
      }
      throw new Error(`unexpected tool call: ${name}`);
    });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify([{
      threadKey: 'slack:C01EXAMPLE1:1784829904.373009', isOngoing: true, ballInUsersCourt: true,
      waitingOn: 'user', status: 'in_progress', summary: 'still open', reason: 'unanswered',
    }]));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });

    expect(result.added).toBe(1); // the from:me query's result still made it through
    const [toMeQuery] = buildSlackRecentQueries(new Date());
    expect(result.errors).toEqual([`Slack search ("${toMeQuery}"): connector invalidated, needs reconnect`]);
  });

  it('one Slack thread fetch throwing does not block the other threads in the same triage batch', async () => {
    const trackedGood = linearTask({
      id: 'tracked-good', source: 'slack',
      sourceRef: { channelId: 'C01EXAMPLE1', threadTs: '1784829904.373009' },
      contextHash: 'stale-good',
    });
    const trackedBad = linearTask({
      id: 'tracked-bad', source: 'slack',
      sourceRef: { channelId: 'C02EXAMPLE2', threadTs: '1784900000.100000' },
      contextHash: 'stale-bad',
    });
    storage.setItem('task-juggler:tasks:v1', JSON.stringify([trackedGood, trackedBad]));
    const callMcpTool = vi.fn(async (name, args) => {
      if (name === TOOL_NAMES.slackReadThread && args.channel_id === 'C02EXAMPLE2') {
        throw new Error('connector invalidated, needs reconnect');
      }
      if (name === TOOL_NAMES.slackReadThread) {
        return { content: [{ text: slackThread.rawText }], isError: false };
      }
      throw new Error(`unexpected tool call: ${name}`);
    });
    const askClaude = vi.fn().mockResolvedValue(JSON.stringify([{
      threadKey: 'slack:C01EXAMPLE1:1784829904.373009', isOngoing: true, ballInUsersCourt: true,
      waitingOn: 'user', status: 'in_progress', summary: 'still open', reason: 'unanswered',
    }]));
    const app = createApp({ storage, callMcpTool, askClaude, toolNames: TOOL_NAMES });
    const result = await app.runSlackTriage({ force: true });

    expect(result.updated).toBe(1);
    expect(app.getTasks().find((t) => t.id === 'tracked-good').summary).toBe('still open');
    expect(app.getTasks().find((t) => t.id === 'tracked-bad').summary).toBe(''); // untouched, not corrupted
  });
});
