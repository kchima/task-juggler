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

export function buildSlackJudgmentPrompt(threadRawText) {
  return [
    "You are triaging a Slack thread to decide if it's an open loop that still needs the user's attention.",
    'Respond with STRICT JSON ONLY — no prose, no markdown code fences — matching exactly:',
    '{"needsAttention": true, "reason": "one short sentence"}',
    "A thread needs attention if its last substantive message is a question or request directed at the user, or the thread is otherwise clearly unresolved.",
    'A thread does NOT need attention if it looks resolved (thanks / done / merged, a completion reaction) or the last message was purely informational with no open question.',
    `Thread:\n${threadRawText}`,
  ].join('\n');
}

// Named distinctly from aiClient.js's identical private helper — this build
// concatenates all files into one flat script scope with no module
// isolation, so two same-named top-level declarations across files is a
// hard SyntaxError, not just a shadowing concern (see the build's
// assertNoDuplicateTopLevelNames guard in build/inline.mjs).
function stripSlackJsonCodeFences(text) {
  return text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
}

export function parseSlackJudgment(rawText) {
  try {
    const parsed = JSON.parse(stripSlackJsonCodeFences(rawText));
    if (typeof parsed.needsAttention !== 'boolean') return null;
    return { needsAttention: parsed.needsAttention, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
  } catch {
    return null;
  }
}

export function slackCandidateToTask({ channelId, threadTs, title }) {
  return {
    title,
    source: 'slack',
    sourceRef: { channelId, threadTs },
  };
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
