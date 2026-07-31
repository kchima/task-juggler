// Pure candidate-shaping and judgment logic for auto-detection ("deep scan").
// app.js owns wiring real MCP tools + merging candidates into storage; this
// module only decides "does this count" and "what does the resulting task
// look like," so it's testable without mocking a tool-calling loop.

// Todoist judgment gate: auto-include only when there's a clear, checkable
// urgency signal — a due date today/overdue, or p1. No project/label
// filtering; everything else is left out, full stop. This is a short-term
// in-flight-work surface, not a to-do list — a blanket dump of Todoist would
// defeat the point.
export function passesTodoistGate(todoistTask, now = new Date()) {
  if (todoistTask.priority === 'p1') return true;
  if (!todoistTask.dueDate) return false;
  return new Date(todoistTask.dueDate) <= now;
}

export function todoistCandidateToTask(todoistTask) {
  return {
    title: todoistTask.content,
    source: 'todoist',
    sourceRef: { taskId: todoistTask.id, projectId: todoistTask.projectId },
    sourcePriority: todoistTask.priority === 'p1' ? 'urgent' : null,
    dueDate: todoistTask.dueDate ?? null,
  };
}

const LINEAR_UNRESOLVED_STATUS_TYPES = new Set(['backlog', 'unstarted', 'started', 'triage']);

export function isUnresolvedLinearIssue(issue) {
  return LINEAR_UNRESOLVED_STATUS_TYPES.has(issue.statusType);
}

export function linearCandidateToTask(issue, workspaceLabel) {
  return {
    title: issue.title,
    source: 'linear',
    sourceRef: { workspaceLabel, issueId: issue.id, url: issue.url },
    sourcePriority: (issue.priority?.name ?? '').toLowerCase() || null,
    dueDate: issue.dueDate ?? null,
  };
}

// Named distinctly from aiClient.js's identical private helper — this build
// concatenates all files into one flat script scope with no module
// isolation, so two same-named top-level declarations across files is a
// hard SyntaxError, not just a shadowing concern (see the build's
// assertNoDuplicateTopLevelNames guard in build/inline.mjs).
function stripSlackJsonCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

// --- Slack batch triage ---------------------------------------------------
// One prompt, one AI call for every thread that needs a look, instead of a
// per-thread call. Two things drove this: per-thread calls made failures
// (one throw, one bad-JSON parse) silently drop that single thread with zero
// visibility, and N calls costs N times what a single batched classification
// does for what is fundamentally a classification task, not N independent
// reasoning tasks.

// Slack's search syntax doesn't reliably support parenthesized boolean OR —
// `is:thread (to:me OR from:me)` silently under-returns. Live-probe-verified:
// plain single-clause queries (`is:thread to:me`, `is:thread from:me`) work.
// Two simple queries beat one clever broken one.
// `overrideAfterDate` (a "YYYY-MM-DD" string) is the opt-in widened scope —
// "I know there's a thread from 3 days ago, catch it this time." Omitted or
// null, behavior is unchanged: the default trailing-24h window.
export function buildSlackRecentQueries(now = new Date(), overrideAfterDate = null) {
  // Slack's after: filter is day-granularity, not hour-granularity, so this
  // is an approximate "yesterday onward" window, not a precise trailing 24h
  // one — that imprecision is a known, accepted limitation, not a bug.
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const afterDate = overrideAfterDate || yesterday.toISOString().slice(0, 10);
  return [
    `is:thread to:me after:${afterDate}`,
    `is:thread from:me after:${afterDate}`,
  ];
}

const VALID_SLACK_STATUS = new Set(['not_started', 'in_progress', 'waiting_other', 'waiting_ai', 'completed']);

export function buildSlackBatchPrompt(threads) {
  const body = threads.map((t) => `--- Thread ${t.threadKey} ---\n${t.rawText}`).join('\n\n');
  return [
    'You are triaging a batch of Slack threads. For EACH thread below, decide whether it represents an open loop that still needs attention.',
    'Respond with STRICT JSON ONLY — a JSON array, no prose, no markdown code fences — one object per thread, in exactly this shape:',
    '[{"threadKey":"<the exact key from the thread header>","isOngoing":true,"ballInUsersCourt":true,"waitingOn":"user"|"them"|null,"status":"not_started"|"in_progress"|"waiting_other"|"waiting_ai"|"completed","summary":"one short sentence","reason":"one short sentence"}]',
    'isOngoing is false only if the thread reads as resolved/done (thanks, merged, confirmed, no open question). Otherwise true.',
    'Treat a bot/agent participant (Devin or similar) exactly like a human participant for "waiting on them" purposes — an unanswered question FROM an agent is exactly as actionable as one from a person.',
    'Return exactly one object per thread below, using each threadKey EXACTLY as given in its header — do not invent, merge, or omit keys.',
    `Threads:\n${body}`,
  ].join('\n');
}

// Individual malformed entries are dropped, not the whole batch — one bad
// object from the model must not cost every other thread in the same call
// its verdict. Returns null only if the whole response isn't valid JSON.
export function parseSlackBatchVerdicts(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(stripSlackJsonCodeFences(rawText));
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;

  const verdicts = new Map();
  for (const entry of parsed) {
    if (!entry || typeof entry.threadKey !== 'string') continue;
    if (typeof entry.isOngoing !== 'boolean') continue;
    if (!VALID_SLACK_STATUS.has(entry.status)) continue;
    verdicts.set(entry.threadKey, {
      isOngoing: entry.isOngoing,
      ballInUsersCourt: Boolean(entry.ballInUsersCourt),
      waitingOn: ['user', 'them'].includes(entry.waitingOn) ? entry.waitingOn : null,
      status: entry.status,
      summary: typeof entry.summary === 'string' ? entry.summary : '',
      reason: typeof entry.reason === 'string' ? entry.reason : '',
    });
  }
  return verdicts;
}

// Slack search results come back as a formatted text blob (not structured
// JSON — see the design addendum), with permalinks embedded like:
// https://acme.slack.com/archives/C01EXAMPLE1/p1784833918152799?thread_ts=1784829904.373009&cid=C01EXAMPLE1
// Real, live-captured format — the thread_ts query param is what reliably
// identifies the thread (the bare p-digits are the individual message, not
// necessarily the parent).
const SLACK_PERMALINK_IN_TEXT_RE = /https:\/\/([\w-]+\.slack\.com)\/archives\/([A-Z0-9]+)\/p\d+\?[^)\s]*thread_ts=([\d.]+)/g;

export function extractSlackThreadRefs(searchResultText) {
  const refs = new Map();
  for (const match of searchResultText.matchAll(SLACK_PERMALINK_IN_TEXT_RE)) {
    const [, workspaceDomain, channelId, threadTs] = match;
    const key = `${channelId}:${threadTs}`;
    // Capture the workspace domain here — it's the only place it appears, and
    // without it we can't rebuild a clickable permalink later.
    if (!refs.has(key)) refs.set(key, { channelId, threadTs, workspaceDomain });
  }
  return [...refs.values()];
}

// --- Claude Desktop (CCD) sessions ---------------------------------------
// Live-verified shape from mcp__ccd_session_mgmt__list_sessions:
// { sessionId, title, cwd, isArchived, isRunning, lastActivityAt }

// Sessions the user hasn't touched in a long while aren't "in flight" in any
// useful sense — this is a short-term workflow surface, not an archive. A
// cheap deterministic filter here means those never cost an LLM call at all.
const SESSION_STALE_AFTER_HOURS = 72;

export function isCandidateClaudeSession(session, now = new Date()) {
  if (session.isArchived) return false;
  if (!session.lastActivityAt) return false;
  const hoursSince = (now - new Date(session.lastActivityAt)) / (1000 * 60 * 60);
  return hoursSince <= SESSION_STALE_AFTER_HOURS;
}

export function claudeSessionCandidateToTask(session, judgment) {
  return {
    title: session.title,
    source: 'claude_session',
    sourceRef: { sessionId: session.sessionId, cwd: session.cwd },
    summary: judgment?.reason ?? '',
    waitingOn: judgment?.waitingOn ?? null,
    ballInUsersCourt: judgment?.waitingOn === 'user',
  };
}

export function buildSessionJudgmentPrompt(session, transcriptTail) {
  return [
    "You are triaging the tail of an AI coding/work session transcript to decide if it's an open loop.",
    'Respond with STRICT JSON ONLY — no prose, no markdown code fences — matching exactly:',
    '{"needsAttention": true, "waitingOn": "user|ai|other", "reason": "one short sentence"}',
    'needsAttention is true only if the work is unfinished AND someone still has to act.',
    'waitingOn is "user" if the assistant asked a question, requested a decision, or handed a step back to the human;',
    '"ai" if the assistant was still mid-task; "other" if it is blocked on a third party.',
    'If the session reads as finished and resolved, needsAttention is false.',
    `Session title: ${session.title}`,
    `Transcript tail:\n${transcriptTail}`,
  ].join('\n');
}

export function parseSessionJudgment(rawText) {
  try {
    const parsed = JSON.parse(stripSlackJsonCodeFences(rawText));
    if (typeof parsed.needsAttention !== 'boolean') return null;
    const waitingOn = ['user', 'ai', 'other'].includes(parsed.waitingOn) ? parsed.waitingOn : null;
    return {
      needsAttention: parsed.needsAttention,
      waitingOn,
      reason: typeof parsed.reason === 'string' ? parsed.reason : '',
    };
  } catch {
    return null;
  }
}

// --- Watermarks -----------------------------------------------------------
// The change signal per source: if this string is unchanged since the last
// scan, nothing about the item has changed, so it must not reach an LLM.

export function changeSignalFor(source, item) {
  if (source === 'claude_session') return `${item.lastActivityAt}`;
  if (source === 'linear') return `${item.updatedAt}`;
  if (source === 'slack') return `${item.latestTs ?? item.threadTs}`;
  if (source === 'todoist') return `${item.dueDate ?? ''}:${item.priority ?? ''}`;
  return '';
}

export function isUnchangedSinceLastScan(key, signal, watermarks) {
  return Boolean(signal) && watermarks[key] === signal;
}
