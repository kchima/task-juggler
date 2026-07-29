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
  extractSlackThreadRefs, buildSlackRecentQueries, buildSlackBatchPrompt, parseSlackBatchVerdicts,
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

// Sources with no per-task refresh adapter — created via manual add or
// deep-scan, then user-managed. `slack` is here too even though it does get
// refreshed: it's handled exclusively by the batch triage pipeline below,
// never by the per-task refreshTask/canonicalize path.
const NO_REFRESH_ADAPTER_SOURCES = new Set([
  'manual', 'url', 'todoist', 'devin', 'claude_code_session', 'claude_session', 'slack',
]);

function canonicalize(task, rawContext) {
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
  // Independent from lastRefreshAt on purpose: main.js's runRefreshAndDiscover
  // calls refreshAll() and runSlackTriage() together in one Promise.all, and
  // both are synchronous up to their first await — a single shared timestamp
  // would make the second call see the first's just-set value and skip
  // itself on every legitimate refresh, not just rapid repeats.
  let lastSlackTriageAt = 0;

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
    if (task.source === 'slack') {
      const refsByKey = new Map([[sourceRefKey(task), task.sourceRef]]);
      const result = await slackTriageForRefs(refsByKey, new Map([[sourceRefKey(task), task]]));
      const updated = getTasks().find((t) => t.id === id) ?? task;
      return { task: updated, aiCalled: result.aiCalled };
    }
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

  // Fetches, hashes, and classifies a set of Slack threads (keyed by
  // sourceRefKey) in ONE batched AI call, then applies the verdicts:
  //   - already tracked (present in trackedByKey)         -> patch in place
  //   - not tracked, verdict.isOngoing === true            -> new task
  //   - not tracked, verdict.isOngoing === false            -> never added
  //   - no verdict returned for a thread (model dropped it) -> left alone,
  //     no watermark, so it's retried on the next scan rather than either
  //     guessed at or permanently skipped.
  // Shared by both the full deep-scan (runSlackTriage) and a single-task
  // manual refresh (refreshOne) — a "batch" of one thread is still a valid
  // batch, so there's exactly one Slack classification code path.
  async function slackTriageForRefs(refsByKey, trackedByKey) {
    const scanned = refsByKey.size;
    if (scanned === 0) {
      return { scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, newTasks: [] };
    }

    const fetched = await mapWithConcurrency([...refsByKey.entries()], CONCURRENCY, async ([key, ref]) => {
      const threadResult = await callMcpTool(toolNames.slackReadThread, {
        channel_id: ref.channelId, message_ts: ref.threadTs,
      });
      const rawText = unwrapMcpResult(threadResult);
      if (typeof rawText !== 'string') return null;
      return { key, ref, rawText, hash: djb2Hash(normalizeSlackThread(rawText)) };
    });

    const watermarks = loadWatermarks(storage);
    const toClassify = fetched.filter((entry) => {
      if (!entry) return false;
      const tracked = trackedByKey.get(entry.key);
      const priorHash = tracked ? tracked.contextHash : watermarks[entry.key];
      return priorHash !== entry.hash; // unchanged since last look -> nothing to do
    });

    if (toClassify.length === 0) {
      return { scanned, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, newTasks: [] };
    }

    const rawVerdicts = await askClaude(
      buildSlackBatchPrompt(toClassify.map((e) => ({ threadKey: e.key, rawText: e.rawText }))),
      []
    );
    const verdicts = parseSlackBatchVerdicts(rawVerdicts);

    let ongoing = 0, updated = 0, added = 0, skippedResolved = 0, unparsed = 0;
    const newTasks = [];

    for (const entry of toClassify) {
      const verdict = verdicts?.get(entry.key);
      if (!verdict) { unparsed++; continue; }

      const tracked = trackedByKey.get(entry.key);
      if (tracked) {
        const patch = {
          summary: verdict.summary,
          waitingOn: verdict.waitingOn,
          ballInUsersCourt: verdict.ballInUsersCourt,
          lastAiRunAt: now().toISOString(),
          contextHash: entry.hash,
        };
        if (!tracked.userPinnedStatus) patch.status = verdict.status;
        patchTask(tracked.id, patch, storage);
        updated++;
        if (verdict.isOngoing) ongoing++;
      } else if (verdict.isOngoing) {
        newTasks.push(blankTask({
          title: verdict.summary || `Slack thread in ${entry.ref.channelId}`,
          source: 'slack',
          sourceRef: entry.ref,
          ballInUsersCourt: verdict.ballInUsersCourt,
          now: now(),
          summary: verdict.summary,
          waitingOn: verdict.waitingOn,
        }));
        added++;
        ongoing++;
      } else {
        skippedResolved++;
      }

      // Watermark every thread that got a real verdict, whichever way it
      // went, so a resolved-and-skipped thread isn't re-fetched and
      // re-classified forever. Unparsed threads are deliberately excluded
      // (see the `unparsed` branch above) so they get retried, not stuck.
      setWatermark(entry.key, entry.hash, storage);
    }

    return { scanned, ongoing, updated, added, skippedResolved, unparsed, aiCalled: true, newTasks };
  }

  // Slack discovery + refresh, batched: one AI call classifies every thread
  // that's new or changed, instead of one call per thread. Gathers three
  // deduped sets — recently-active threads, currently-unread threads (a
  // documented gap, not faked — see below), and already-tracked Slack tasks
  // (this doubles as their status refresh) — fetches each, and only sends
  // the ones whose content actually changed since last time to the model.
  async function runSlackTriage({ force = false } = {}) {
    const nowMs = now().getTime();
    if (!force && nowMs - lastSlackTriageAt < REFRESH_DEBOUNCE_MS) {
      return { skipped: true, scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, unreadCheckAvailable: false };
    }
    lastSlackTriageAt = nowMs;

    if (!toolNames.slackReadThread) {
      return { skipped: false, scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, unreadCheckAvailable: false };
    }

    const dismissedKeys = new Set(loadDismissedKeys(storage));
    const trackedSlackTasks = getTasks().filter((t) => t.source === 'slack');
    const trackedByKey = new Map(trackedSlackTasks.map((t) => [sourceRefKey(t), t]));

    const refsByKey = new Map();
    if (toolNames.slackSearch) {
      for (const query of buildSlackRecentQueries(now())) {
        const searchResult = await callMcpTool(toolNames.slackSearch, { query, limit: 20 });
        const unwrapped = unwrapMcpResult(searchResult);
        const searchText = typeof unwrapped === 'string' ? unwrapped : (unwrapped?.results ?? '');
        for (const ref of extractSlackThreadRefs(searchText)) {
          const key = sourceRefKey({ source: 'slack', sourceRef: ref });
          if (!refsByKey.has(key)) refsByKey.set(key, ref);
        }
      }
    }
    // No unread/mentions MCP tool is exposed here, so "currently unread"
    // coverage is a real gap rather than something to fake — surfaced via
    // unreadCheckAvailable below instead of silently pretending full
    // coverage of the spec's third source.
    for (const task of trackedSlackTasks) {
      const key = sourceRefKey(task);
      if (!refsByKey.has(key)) refsByKey.set(key, task.sourceRef);
    }
    for (const key of dismissedKeys) refsByKey.delete(key);

    const { newTasks, ...summary } = await slackTriageForRefs(refsByKey, trackedByKey);

    if (newTasks.length) {
      const existing = getTasks();
      saveTasks(mergeSeedTasks(existing, newTasks, [...dismissedKeys]), storage);
    }

    return { skipped: false, ...summary, unreadCheckAvailable: false };
  }

  // Coded against the live-verified ccd_session_mgmt shape only:
  // { sessionId, title, cwd, isArchived, isRunning, lastActivityAt } arrays.
  // Cowork has been observed exposing a *different* server (session_info)
  // with a prose response and none of those fields — deliberately NOT
  // supported here. Rather than silently returning zero candidates against
  // an unrecognized shape (indistinguishable from "nothing to report"),
  // this surfaces the mismatch as an explicit error so it doesn't masquerade
  // as "no in-flight sessions." Wiring up session_info itself needs a fresh
  // probe from within Cowork first — see the plugin skill notes.
  async function discoverClaudeSessionCandidates(blockedKeys, watermarks) {
    if (!toolNames.sessionList) return { candidates: [], error: null };

    const result = await callMcpTool(toolNames.sessionList, { limit: 25 });
    const sessions = unwrapMcpResult(result);
    const list = Array.isArray(sessions) ? sessions : (Array.isArray(sessions?.sessions) ? sessions.sessions : null);

    if (list === null) {
      return {
        candidates: [],
        error: `list_sessions returned an unrecognized shape (expected an array or {sessions: [...]}, got ${typeof sessions}) — Claude session ingestion is coded against ccd_session_mgmt only and will not guess at a different server's format.`,
      };
    }

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

    return { candidates: classified.filter(Boolean), error: null };
  }

  // Known minor gap, not a correctness issue: unlike refreshAll/runSlackTriage,
  // this has no debounce of its own, so rapid repeated calls re-run the
  // Linear/Todoist fetches each time. Harmless in practice — mergeSeedTasks
  // prevents duplicates — but worth fixing if this gets called on a tighter
  // loop than the current 5-minute auto-refresh interval. Slack is handled
  // entirely by runSlackTriage now, not here.
  async function discoverNewTasks() {
    const dismissedKeys = loadDismissedKeys(storage);
    const watermarks = loadWatermarks(storage);
    // Anything already tracked or explicitly dismissed is blocked from even
    // being fetched again, let alone re-judged by an LLM.
    const blockedKeys = new Set([...getTasks().map(sourceRefKey), ...dismissedKeys]);

    const [linearCandidates, todoistCandidates, sessionResult] = await Promise.all([
      discoverLinearCandidates(),
      discoverTodoistCandidates(),
      discoverClaudeSessionCandidates(blockedKeys, watermarks),
    ]);

    const candidateTasks = [
      ...linearCandidates, ...todoistCandidates, ...sessionResult.candidates,
    ].map((c) => blankTask({
      title: c.title, source: c.source, sourceRef: c.sourceRef,
      ballInUsersCourt: c.ballInUsersCourt ?? false, now: now(),
      sourcePriority: c.sourcePriority ?? null, dueDate: c.dueDate ?? null,
      summary: c.summary ?? '', waitingOn: c.waitingOn ?? null,
    }));

    const existing = getTasks();
    const merged = mergeSeedTasks(existing, candidateTasks, dismissedKeys);
    saveTasks(merged, storage);
    return { added: merged.length - existing.length, sessionDiscoveryError: sessionResult.error };
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
    getTasks, refreshAll, refreshOne, discoverNewTasks, runSlackTriage,
    addManualTask, addByLink, cycleStatusManual, reopen, remove, undismissAll,
  };
}
