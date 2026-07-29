import { describe, it, expect } from 'vitest';
import {
  passesTodoistGate,
  todoistCandidateToTask,
  isUnresolvedLinearIssue,
  linearCandidateToTask,
  buildSlackRecentQueries,
  buildSlackBatchPrompt,
  parseSlackBatchVerdicts,
  extractSlackThreadRefs,
} from '../src/discovery.js';
import acmeIssue from './fixtures/linear-acme-issue.json' with { type: 'json' };

const NOW = new Date('2026-07-25T12:00:00Z');

describe('passesTodoistGate — real captured Todoist items', () => {
  it('excludes a p2 chore due months out ("Cancel the unused subscription", real item)', () => {
    expect(passesTodoistGate({ priority: 'p2', dueDate: '2026-10-15' }, NOW)).toBe(false);
  });

  it('excludes a p4 chore with a due date today isn\'t enough to override... actually due-today DOES pass regardless of priority', () => {
    // "Water the plants" is real: p4, recurring, due 2026-07-06 (in the past relative to NOW)
    expect(passesTodoistGate({ priority: 'p4', dueDate: '2026-07-06' }, NOW)).toBe(true);
  });

  it('includes a p1 item with no due date at all ("Renew the annual service plan" is p1, real item)', () => {
    expect(passesTodoistGate({ priority: 'p1', dueDate: null }, NOW)).toBe(true);
  });

  it('excludes a p2 item with a due date in the future ("Quarterly access review", real item, due 2026-07-27)', () => {
    expect(passesTodoistGate({ priority: 'p2', dueDate: '2026-07-27' }, NOW)).toBe(false);
  });

  it('includes an item with no priority field but an overdue due date', () => {
    expect(passesTodoistGate({ priority: null, dueDate: '2020-01-01' }, NOW)).toBe(true);
  });

  it('excludes an item with neither a due date nor p1', () => {
    expect(passesTodoistGate({ priority: 'p3', dueDate: null }, NOW)).toBe(false);
  });
});

describe('todoistCandidateToTask', () => {
  it('shapes a real Todoist item into a candidate task', () => {
    const real = {
      id: 'TD00000000000001',
      content: 'Renew the annual service plan before it lapses',
      priority: 'p1',
      dueDate: '2027-06-01',
      projectId: 'PJ00000000000001',
    };
    const task = todoistCandidateToTask(real);
    expect(task.source).toBe('todoist');
    expect(task.title).toBe(real.content);
    expect(task.sourceRef).toEqual({ taskId: 'TD00000000000001', projectId: 'PJ00000000000001' });
    expect(task.sourcePriority).toBe('urgent');
    expect(task.dueDate).toBe('2027-06-01');
  });

  it('leaves sourcePriority null for a non-p1 item', () => {
    const task = todoistCandidateToTask({ id: 'x', content: 'x', priority: 'p2', dueDate: null, projectId: 'p' });
    expect(task.sourcePriority).toBeNull();
  });
});

describe('isUnresolvedLinearIssue — real captured statusTypes', () => {
  it('treats "triage" as unresolved (real: ACME-3913)', () => {
    expect(isUnresolvedLinearIssue({ statusType: 'triage' })).toBe(true);
  });

  it('treats "backlog" as unresolved (real: GLBX-47)', () => {
    expect(isUnresolvedLinearIssue({ statusType: 'backlog' })).toBe(true);
  });

  it('treats "started" as unresolved', () => {
    expect(isUnresolvedLinearIssue({ statusType: 'started' })).toBe(true);
  });

  it('treats "completed" as resolved (real: ACME-3903)', () => {
    expect(isUnresolvedLinearIssue({ statusType: 'completed' })).toBe(false);
  });

  it('treats "canceled" as resolved', () => {
    expect(isUnresolvedLinearIssue({ statusType: 'canceled' })).toBe(false);
  });
});

describe('linearCandidateToTask', () => {
  it('shapes a real captured Linear issue into a candidate task', () => {
    const task = linearCandidateToTask(acmeIssue, 'acme');
    expect(task.source).toBe('linear');
    expect(task.title).toBe(acmeIssue.title);
    expect(task.sourceRef).toEqual({ workspaceLabel: 'acme', issueId: 'ACME-3913', url: acmeIssue.url });
    expect(task.sourcePriority).toBe('no priority');
  });
});

describe('buildSlackRecentQueries', () => {
  it('produces two plain single-clause queries, never a combined OR/paren query', () => {
    const queries = buildSlackRecentQueries(new Date('2026-07-29T12:00:00Z'));
    expect(queries).toEqual(['is:thread to:me after:2026-07-28', 'is:thread from:me after:2026-07-28']);
    for (const q of queries) {
      expect(q).not.toContain('(');
      expect(q).not.toContain('OR');
    }
  });
});

describe('buildSlackBatchPrompt', () => {
  it('embeds every thread keyed by threadKey and demands a JSON array', () => {
    const prompt = buildSlackBatchPrompt([
      { threadKey: 'slack:C01:111.111', rawText: 'Devin: should I ship this?' },
      { threadKey: 'slack:C02:222.222', rawText: 'Priya: thanks, all set' },
    ]);
    expect(prompt).toContain('slack:C01:111.111');
    expect(prompt).toContain('Devin: should I ship this?');
    expect(prompt).toContain('slack:C02:222.222');
    expect(prompt).toContain('Priya: thanks, all set');
    expect(prompt.toLowerCase()).toContain('json array');
  });
});

describe('parseSlackBatchVerdicts', () => {
  const validEntry = {
    threadKey: 'slack:C01:111.111',
    isOngoing: true,
    ballInUsersCourt: true,
    waitingOn: 'user',
    status: 'in_progress',
    summary: 'Devin is waiting on a go/no-go',
    reason: 'unanswered question from a bot counterpart',
  };

  it('parses a clean array response into a Map keyed by threadKey', () => {
    const verdicts = parseSlackBatchVerdicts(JSON.stringify([validEntry]));
    expect(verdicts.get('slack:C01:111.111')).toEqual({
      isOngoing: true,
      ballInUsersCourt: true,
      waitingOn: 'user',
      status: 'in_progress',
      summary: 'Devin is waiting on a go/no-go',
      reason: 'unanswered question from a bot counterpart',
    });
  });

  it('strips a code fence around the array', () => {
    const fenced = '```json\n' + JSON.stringify([validEntry]) + '\n```';
    expect(parseSlackBatchVerdicts(fenced).size).toBe(1);
  });

  it('drops an individual malformed entry without discarding the rest of the batch', () => {
    const resolvedEntry = { ...validEntry, threadKey: 'slack:C02:222.222', isOngoing: false, status: 'completed' };
    const malformed = { threadKey: 'slack:C03:333.333' }; // missing isOngoing/status
    const verdicts = parseSlackBatchVerdicts(JSON.stringify([validEntry, malformed, resolvedEntry]));
    expect(verdicts.size).toBe(2);
    expect(verdicts.has('slack:C03:333.333')).toBe(false);
    expect(verdicts.get('slack:C02:222.222').isOngoing).toBe(false);
  });

  it('rejects an unrecognized status value', () => {
    const verdicts = parseSlackBatchVerdicts(JSON.stringify([{ ...validEntry, status: 'archived' }]));
    expect(verdicts.size).toBe(0);
  });

  it('normalizes waitingOn to null when neither "user" nor "them"', () => {
    const verdicts = parseSlackBatchVerdicts(JSON.stringify([{ ...validEntry, waitingOn: 'someone_else' }]));
    expect(verdicts.get('slack:C01:111.111').waitingOn).toBeNull();
  });

  it('returns null for a response that is not a JSON array at all', () => {
    expect(parseSlackBatchVerdicts('not json')).toBeNull();
    expect(parseSlackBatchVerdicts(JSON.stringify({ threadKey: 'x' }))).toBeNull();
  });
});

describe('extractSlackThreadRefs — real captured Slack search result text', () => {
  const REAL_SEARCH_TEXT = [
    '# Search Results for: is:thread after:2026-06-01',
    '## Messages (5 results)',
    '### Result 1 of 5',
    'Channel: #engineering (ID: C01EXAMPLE1)',
    'From: Priya Nair <priya@acme.example> (ID: U02EXAMPLE2)',
    'Message_ts: 1784833918.152799',
    'Permalink: [link](https://acme.slack.com/archives/C01EXAMPLE1/p1784833918152799?thread_ts=1784829904.373009&cid=C01EXAMPLE1)',
    'Text: aside Dana I think we will need to do a frontend deploy as well',
    '### Result 3 of 5',
    'Channel: #engineering (ID: C01EXAMPLE1)',
    'From: Devin (ID: U03EXAMPLE3)  [BOT]',
    'Permalink: [link](https://acme.slack.com/archives/C01EXAMPLE1/p1784833812477119?thread_ts=1784829904.373009&cid=C01EXAMPLE1)',
  ].join('\n');

  it('extracts the parent thread_ts from real permalinks, not the individual message p-digits', () => {
    const refs = extractSlackThreadRefs(REAL_SEARCH_TEXT);
    expect(refs).toContainEqual({
      channelId: 'C01EXAMPLE1',
      threadTs: '1784829904.373009',
      // Captured so a clickable permalink can be rebuilt later — it appears
      // nowhere else in the response.
      workspaceDomain: 'acme.slack.com',
    });
  });

  it('dedups multiple messages from the same real thread into one ref', () => {
    const refs = extractSlackThreadRefs(REAL_SEARCH_TEXT);
    expect(refs).toHaveLength(1);
  });

  it('returns an empty array for text with no permalinks', () => {
    expect(extractSlackThreadRefs('no links here')).toEqual([]);
  });
});
