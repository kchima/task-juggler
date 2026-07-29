import {
  loadTasks, saveTasks, patchTask, addTask, deleteTask,
  loadDismissedKeys, addDismissedKey, clearDismissedKeys, loadWatermarks, setWatermark,
} from './storage.js';
import { fetchRawContext, unwrapMcpResult } from './mcpAdapters.js';
import { normalizeLinearIssue, normalizeSlackThread } from './normalize.js';
import { djb2Hash } from './hash.js';
import { refreshTaskViaAi } from './aiClient.js';
import { parseLink } from './urlParser.js';
import { generateId } from './id.js';
import { mergeSeedTasks } from './seedMerge.js';
import { sourceRefKey } from './taskKey.js';
import {
  passesTodoistGate, todoistCandidateToTask,
  isUnresolvedLinearIssue, linearCandidateToTask,
  buildSlackJudgmentPrompt, parseSlackJudgment, extractSlackThreadRefs,
  isCandidateClaudeSession, claudeSessionCandidateToTask,
  buildSessionJudgmentPrompt, parseSessionJudgment,
  changeSignalFor, isUnchangedSinceLastScan,
} from './discovery.js';

const REFRESH_DEBOUNCE_MS = 30_000;
const CONCURRENCY = 3;

// How many trailing transcript messages to send when judging a session.
// Deliberately small: the tail is where the open question lives, and this is
// the single biggest lever on per-scan token cost.
const SESSION_TAIL_MESSAGES = 6;

// Sources with no automated refresh adapter yet — created via manual add or
// deep-scan, then user-managed. Not a gap: these are intentionally out of
// scope for this increment; each gets created via discovery, then the user
// manages its status directly until a real refresh adapter exists for it.
const NO_REFRESH_ADAPTER_SOURCES = new Set([
  'manual', 'url', 'todoist', 'devin', 'claude_code_session', 'claude_session',
]);

function canonicalize(task, rawContext) {
  if (task.source === 'slack') return normalizeSlackThread(rawContext);
  if (task.source === 'linear') return normalizeLinearIssue(rawContext ?? {});
  return '';
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function blankTask({
  title, source, sourceRef, ballInUsersCourt, now,
  sourcePriority = null, dueDate = null, summary = '', waitingOn = null,
}) {
  return {
    id: generateId(), title, source, sourceRef,
    status: 'not_started', summary, nextAction: '', waitingOn,
    ballInUsersCourt, estRemaining: 'medium', dueDate,
    sourcePriority, priorityScore: 0, contextHash: null, lastAiRunAt: null,
    userPinnedStatus: false, createdAt: now.toISOString(), updatedAt: now.toISOString(),
  };
}

export function createApp({ storage, callMcpTool, askClaude, toolNames, now = () => new Date() }) {
  let lastRefreshAt = 0;

  function getTasks() {
    return loadTasks(storage);
  }

  async function refreshTask(task) {
    if (NO_REFRESH_ADAPTER_SOURCES.has(task.source)) {
      return { task, aiCalled: false };
    }

    const raw = await fetchRawContext(task, callMcpTool, toolNames);
    if (raw == null) return { task, aiCalled: false };

    const canonical = canonicalize(task, raw);
    const newHash = djb2Hash(canonical);
    if (newHash === task.contextHash) return { task, aiCalled: false };

    const aiResult = await refreshTaskViaAi(task, canonical, askClaude);
    if (!aiResult) return { task, aiCalled: true, parseFailed: true };

    const patch = {
      summary: aiResult.summary,
      nextAction: aiResult.nextAction,
      waitingOn: aiResult.waitingOn,
      ballInUsersCourt: aiResult.ballInUsersCourt,
      estRemaining: aiResult.estRemaining,
      lastAiRunAt: now().toISOString(),
      contextHash: newHash,
    };
    if (!task.userPinnedStatus) {
      patch.status = aiResult.done ? 'completed' : aiResult.status;
    }

    const updated = patchTask(task.id, patch, storage);
    return { task: updated, aiCalled: true, parseFailed: false };
  }

  async function refreshAll({ force = false } = {}) {
    const nowMs = now().getTime();
    if (!force && nowMs - lastRefreshAt < REFRESH_DEBOUNCE_MS) {
      return { skipped: true, results: [] };
    }
    lastRefreshAt = nowMs;
    const tasks = getTasks().filter((t) => t.status !== 'completed');
    const results = await mapWithConcurrency(tasks, CONCURRENCY, refreshTask);
    return { skipped: false, results };
  }

  async function refreshOne(id) {
    const task = getTasks().find((t) => t.id === id);
    if (!task) return null;
    return refreshTask(task);
  }

  async function discoverLinearCandidates() {
    const candidates = [];
    for (const [workspaceLabel, prefix] of Object.entries(toolNames.linearWorkspaces ?? {})) {
      const result = await callMcpTool(`${prefix}list_issues`, { assignee: 'me' });
      const issues = unwrapMcpResult(result)?.issues ?? [];
      for (const issue of issues) {
        if (isUnresolvedLinearIssue(issue)) candidates.push(linearCandidateToTask(issue, workspaceLabel));
      }
    }
    return candidates;
  }

  async function discoverTodoistCandidates() {
    if (!toolNames.todoistFindTasks) return [];
    const result = await callMcpTool(toolNames.todoistFindTasks, { filter: 'today | overdue | p1', limit: 50 });
    const items = unwrapMcpResult(result)?.tasks ?? [];
    return items.filter((t) => passesTodoistGate(t, now())).map(todoistCandidateToTask);
  }

  async function discoverSlackCandidates(blockedKeys, watermarks) {
    if (!toolNames.slackSearch) return [];

    const searchResult = await callMcpTool(toolNames.slackSearch, { query: 'is:thread (to:me OR from:me)', limit: 10 });
    const unwrapped = unwrapMcpResult(searchResult);
    const searchText = typeof unwrapped === 'string' ? unwrapped : (unwrapped?.results ?? '');

    const refs = extractSlackThreadRefs(searchText).filter((ref) => {
      const key = sourceRefKey({ source: 'slack', sourceRef: ref });
      if (blockedKeys.has(key)) return false;
      // The thread's own ts is its change signal here: a thread we've already
      // judged at this exact ts has nothing new in it, so skip before we ever
      // fetch or classify it.
      return !isUnchangedSinceLastScan(key, changeSignalFor('slack', ref), watermarks);
    });

    const classified = await mapWithConcurrency(refs, CONCURRENCY, async (ref) => {
      const key = sourceRefKey({ source: 'slack', sourceRef: ref });
      const threadResult = await callMcpTool(toolNames.slackReadThread, {
        channel_id: ref.channelId, message_ts: ref.threadTs,
      });
      const rawText = unwrapMcpResult(threadResult);
      if (typeof rawText !== 'string') return null;

      const judgment = parseSlackJudgment(await askClaude(buildSlackJudgmentPrompt(rawText), []));
      // Record the watermark either way — a "no, this is resolved" verdict is
      // exactly as expensive as a "yes", and just as wasteful to repeat.
      setWatermark(key, changeSignalFor('slack', ref), storage);
      if (!judgment?.needsAttention) return null;

      return {
        title: judgment.reason || `Slack thread in ${ref.channelId}`,
        source: 'slack',
        sourceRef: { channelId: ref.channelId, threadTs: ref.threadTs, workspaceDomain: ref.workspaceDomain },
      };
    });

    return classified.filter(Boolean);
  }

  async function discoverClaudeSessionCandidates(blockedKeys, watermarks) {
    if (!toolNames.sessionList) return [];

    const result = await callMcpTool(toolNames.sessionList, { limit: 25 });
    const sessions = unwrapMcpResult(result);
    const list = Array.isArray(sessions) ? sessions : (sessions?.sessions ?? []);

    const candidates = list.filter((s) => {
      if (!isCandidateClaudeSession(s, now())) return false;
      const key = sourceRefKey({ source: 'claude_session', sourceRef: { sessionId: s.sessionId } });
      if (blockedKeys.has(key)) return false;
      return !isUnchangedSinceLastScan(key, changeSignalFor('claude_session', s), watermarks);
    });

    const classified = await mapWithConcurrency(candidates, CONCURRENCY, async (session) => {
      const key = sourceRefKey({ source: 'claude_session', sourceRef: { sessionId: session.sessionId } });
      const eventsResult = await callMcpTool(toolNames.sessionEvents, {
        session_id: session.sessionId, limit: SESSION_TAIL_MESSAGES,
      });
      const tail = unwrapMcpResult(eventsResult);

      setWatermark(key, changeSignalFor('claude_session', session), storage);
      if (typeof tail !== 'string' || !tail.trim()) return null;

      const judgment = parseSessionJudgment(await askClaude(buildSessionJudgmentPrompt(session, tail), []));
      if (!judgment?.needsAttention) return null;
      return claudeSessionCandidateToTask(session, judgment);
    });

    return classified.filter(Boolean);
  }

  // Known minor gap, not a correctness issue: unlike refreshAll, this has no
  // debounce of its own, so rapid repeated calls re-run the Linear/Todoist/
  // Slack-search fetches each time. Harmless in practice — mergeSeedTasks
  // prevents duplicates, and the existingSlackRefs pre-filter in
  // discoverSlackCandidates already prevents re-classifying (re-billing AI
  // for) threads already tracked — but worth fixing if this gets called on
  // a tighter loop than the current 5-minute auto-refresh interval.
  async function discoverNewTasks() {
    const dismissedKeys = loadDismissedKeys(storage);
    const watermarks = loadWatermarks(storage);
    // Anything already tracked or explicitly dismissed is blocked from even
    // being fetched again, let alone re-judged by an LLM.
    const blockedKeys = new Set([...getTasks().map(sourceRefKey), ...dismissedKeys]);

    const [linearCandidates, todoistCandidates, slackCandidates, sessionCandidates] = await Promise.all([
      discoverLinearCandidates(),
      discoverTodoistCandidates(),
      discoverSlackCandidates(blockedKeys, watermarks),
      discoverClaudeSessionCandidates(blockedKeys, watermarks),
    ]);

    const candidateTasks = [
      ...linearCandidates, ...todoistCandidates, ...slackCandidates, ...sessionCandidates,
    ].map((c) => blankTask({
      title: c.title, source: c.source, sourceRef: c.sourceRef,
      ballInUsersCourt: c.ballInUsersCourt ?? false, now: now(),
      sourcePriority: c.sourcePriority ?? null, dueDate: c.dueDate ?? null,
      summary: c.summary ?? '', waitingOn: c.waitingOn ?? null,
    }));

    const existing = getTasks();
    const merged = mergeSeedTasks(existing, candidateTasks, dismissedKeys);
    saveTasks(merged, storage);
    return { added: merged.length - existing.length };
  }

  function addManualTask(title) {
    return addTask(blankTask({ title, source: 'manual', sourceRef: {}, ballInUsersCourt: true, now: now() }), storage);
  }

  function addByLink(url) {
    const parsed = parseLink(url);
    return addTask(blankTask({
      title: url, source: parsed.source, sourceRef: parsed.sourceRef,
      ballInUsersCourt: false, now: now(),
    }), storage);
  }

  function cycleStatusManual(id, nextStatusFn) {
    const task = getTasks().find((t) => t.id === id);
    if (!task) return null;
    return patchTask(id, { status: nextStatusFn(task.status), userPinnedStatus: true }, storage);
  }

  function reopen(id) {
    return patchTask(id, { status: 'not_started', userPinnedStatus: true }, storage);
  }

  // "Remove" is a dismissal, not just a delete: the task's identity goes on
  // the dismissed list so discovery can never resurface it. Without this,
  // deleting an auto-detected task is meaningless — the next scan just adds
  // it straight back.
  function remove(id) {
    const task = getTasks().find((t) => t.id === id);
    if (task) addDismissedKey(sourceRefKey(task), storage);
    deleteTask(id, storage);
  }

  function undismissAll() {
    clearDismissedKeys(storage);
  }

  return {
    getTasks, refreshAll, refreshOne, discoverNewTasks,
    addManualTask, addByLink, cycleStatusManual, reopen, remove, undismissAll,
  };
}
