// Fixtures for the mock window.cowork runtime, wrapped in the documented
// { content, structuredContent, isError } envelope. Real captured data — see
// tests/fixtures/*.json for provenance notes.
// No session-related names here — the artifact never calls a session tool
// at all (Claude session discovery only runs via the juggler skill's
// chat-driven deep-scan flow; see SKILL.md).
export const MOCK_TOOL_NAMES = {
  slackReadThread: 'mcp__mockslack__slack_read_thread',
  slackSearch: 'mcp__mockslack__slack_search',
  todoistFindTasks: 'mcp__mocktodoist__find-tasks',
  linearWorkspaces: {
    Acme: 'mcp__mocklinearacme__',
    Globex: 'mcp__mocklinearglobex__',
  },
};

// A second, not-yet-tracked Linear issue and Slack thread + a Todoist item,
// for exercising discoverNewTasks() live in the harness.
export const MOCK_LINEAR_DISCOVERY_ISSUE = {
  id: 'ACME-4001',
  title: 'Fix flaky checkout retry logic',
  status: 'In Progress', statusType: 'started', assignee: 'dev@acme.example',
  priority: { value: 2, name: 'High' }, dueDate: null,
  labels: ['Backend'], updatedAt: '2026-07-24T10:00:00.000Z',
  url: 'https://linear.app/acme/issue/ACME-4001/fix-flaky-checkout-retry-logic',
};

export const MOCK_TODOIST_DISCOVERY_ITEM = {
  id: 'T4001', content: 'Ship the release notes doc', priority: 'p1',
  dueDate: null, projectId: 'P1',
};

export const MOCK_SLACK_DISCOVERY_THREAD = {
  channelId: 'C02EXAMPLE2', threadTs: '1784900000.100000',
  searchSnippet: 'Permalink: [link](https://acme.slack.com/archives/C02EXAMPLE2/p1784900000100000?thread_ts=1784900000.100000&cid=C02EXAMPLE2)',
  rawText: [
    '=== THREAD PARENT MESSAGE ===',
    'From: Priya (U02EXAMPLE2)',
    'Dana, can you review the pricing copy before we ship it?',
  ].join('\n'),
};

export const MOCK_SLACK_THREAD_V1 = {
  channelId: 'C01EXAMPLE1',
  threadTs: '1784829904.373009',
  rawText: [
    '=== THREAD PARENT MESSAGE ===',
    'From: Dana (U01EXAMPLE1)',
    'Devin acme-backend: create a pr to merge dev into main, fixing any merge conflicts',
    '',
    '=== THREAD REPLIES (2 total) ===',
    '--- Reply 1 of 2 ---',
    'From: Devin (U03EXAMPLE3)',
    'On it — creating a dev to main PR for acme-backend.',
    '--- Reply 2 of 2 ---',
    'From: Devin (U03EXAMPLE3)',
    'Created PR #1534. Want me to add this release to the changelog?',
  ].join('\n'),
};

export const MOCK_LINEAR_ISSUE = {
  id: 'ACME-3913',
  title: "Invalid 'upgrade' upsell configs silently disable plan Save button",
  status: 'Triage', statusType: 'triage', assignee: 'dev@acme.example',
  priority: { value: 0, name: 'No priority' }, dueDate: null,
  labels: ['Backend', 'frontend', 'Bug'], updatedAt: '2026-07-23T17:41:17.045Z',
};
