import {
  loadTasks, saveTasks, patchTask, addTask, deleteTask,
  loadDismissedKeys, addDismissedKey, clearDismissedKeys, loadWatermarks, setWatermark,
} from './storage.js';
import { fetchRawContext, unwrapMcpResult, slackThreadText, probeTool, isAllowlistError } from './mcpAdapters.js';
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

// "Content unchanged since last look" and "judgment still valid" are NOT the
// same claim, and treating them as one is a real bug: a thread's watermark
// is written on ANY verdict (including a wrong one, or one that's since
// become outdated by a prompt/criteria change), and content-hash comparison
// alone can never tell the difference between "still correct" and "content
// happens to be identical to what got a stale verdict." Bump this whenever
// buildSlackBatchPrompt's classification criteria changes in a way that
// could change past verdicts — it invalidates every existing Slack
// watermark and tracked contextHash at once, forcing one fresh look at
// everything (tracked or not) on the next scan, regardless of whether the
// thread's content itself changed.
const SLACK_JUDGMENT_VERSION = 'v1';
function slackChangeSignal(hash) {
  return `${SLACK_JUDGMENT_VERSION}:${hash}`;
}

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

// A real bridge failure ("Argument 'prompt' ... failed to pass validation")
// was observed on the batch Slack classification call. Its most likely
// cause is size — the batch concatenates every changed thread's full raw
// text into one prompt with no cap — but there's no confirmed limit to
// guess at, and it could just as easily be one thread's content the
// validator rejects regardless of size. Rather than pick an arbitrary
// character budget, back off: on failure, split the batch in half and
// retry each half independently. That survives a size-triggered failure
// without needing to know the real limit, and correctly isolates a single
// bad thread (retrying down to size 1 and still failing) as a per-thread
// error instead of taking the whole scan down with it.
async function classifySlackBatch(entries, askClaude) {
  if (entries.length === 0) return { verdicts: new Map(), errors: [] };
  try {
    const raw = await askClaude(
      buildSlackBatchPrompt(entries.map((e) => ({ threadKey: e.key, rawText: e.rawText }))),
      []
    );
    return { verdicts: parseSlackBatchVerdicts(raw) ?? new Map(), errors: [] };
  } catch (err) {
    if (entries.length === 1) {
      return { verdicts: new Map(), errors: [`Slack classification (${entries[0].key}): ${err?.message ?? 'AI call failed'}`] };
    }
    const mid = Math.ceil(entries.length / 2);
    const [a, b] = await Promise.all([
      classifySlackBatch(entries.slice(0, mid), askClaude),
      classifySlackBatch(entries.slice(mid), askClaude),
    ]);
    return { verdicts: new Map([...a.verdicts, ...b.verdicts]), errors: [...a.errors, ...b.errors] };
  }
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

// Best-effort human-readable label for the "detected candidates" debug
// panel — skips the raw thread's header lines to surface the actual first
// message, falling back to the channel id when there's nothing to show yet
// (fetch failed, or not fetched at all).
function threadLabel(rawText, ref) {
  if (typeof rawText !== 'string') return `#${ref.channelId}`;
  const firstContentLine = rawText.split('\n').find((line) => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('=== ') && !trimmed.startsWith('From:') && !trimmed.startsWith('Time:') && !trimmed.startsWith('Message TS:');
  });
  const snippet = (firstContentLine ?? '').trim().slice(0, 80);
  return snippet || `#${ref.channelId}`;
}

function blankTask({
  title, source, sourceRef, ballInUsersCourt, now,
  sourcePriority = null, dueDate = null, summary = '', waitingOn = null, contextHash = null,
}) {
  return {
    id: generateId(), title, source, sourceRef,
    status: 'not_started', summary, nextAction: '', waitingOn,
    ballInUsersCourt, estRemaining: 'medium', dueDate,
    sourcePriority, priorityScore: 0, contextHash, lastAiRunAt: null,
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

  // Wrapped end-to-end: a thrown/rejected callMcpTool (connector invalidated,
  // network error, etc.) must degrade to "this one task didn't refresh," not
  // take down every other task in the same refreshAll batch — mapWithConcurrency
  // runs each worker's tasks sequentially within itself, so one uncaught
  // rejection here would kill that worker's remaining queue too.
  async function refreshTask(task) {
    if (NO_REFRESH_ADAPTER_SOURCES.has(task.source)) {
      return { task, aiCalled: false };
    }

    try {
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
    } catch (err) {
      return { task, aiCalled: false, error: `${task.title}: ${err?.message ?? 'connector error'}` };
    }
  }

  async function refreshAll({ force = false } = {}) {
    const nowMs = now().getTime();
    if (!force && nowMs - lastRefreshAt < REFRESH_DEBOUNCE_MS) {
      return { skipped: true, results: [], errors: [] };
    }
    lastRefreshAt = nowMs;
    const tasks = getTasks().filter((t) => t.status !== 'completed');
    const results = await mapWithConcurrency(tasks, CONCURRENCY, refreshTask);
    return { skipped: false, results, errors: results.filter((r) => r.error).map((r) => r.error) };
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

  // Each workspace is caught individually: a live probe found a connector
  // can go into an "invalidated, needs reconnect" state that rejects the
  // call outright (not a normal {isError:true} response) — one workspace in
  // that state must not skip every other workspace's issues too.
  async function discoverLinearCandidates() {
    const candidates = [];
    const errors = [];
    const detected = [];
    for (const [workspaceLabel, prefix] of Object.entries(toolNames.linearWorkspaces ?? {})) {
      try {
        const result = await callMcpTool(`${prefix}list_issues`, { assignee: 'me' });
        const issues = unwrapMcpResult(result)?.issues ?? [];
        for (const issue of issues) {
          if (isUnresolvedLinearIssue(issue)) {
            candidates.push(linearCandidateToTask(issue, workspaceLabel));
            // outcome (added vs. already-tracked) isn't knowable here — this
            // function doesn't see the existing task list — so discoverNewTasks
            // fills it in afterward by checking sourceRefKey membership.
            detected.push({ key: `linear:${workspaceLabel}:${issue.id}`, label: `[${workspaceLabel}] ${issue.title}`, outcome: 'candidate' });
          }
        }
      } catch (err) {
        errors.push(`Linear (${workspaceLabel}): ${err?.message ?? 'connector error'}`);
      }
    }
    return { candidates, errors, detected };
  }

  async function discoverTodoistCandidates() {
    if (!toolNames.todoistFindTasks) return { candidates: [], error: null };
    try {
      const result = await callMcpTool(toolNames.todoistFindTasks, { filter: 'today | overdue | p1', limit: 50 });
      const items = unwrapMcpResult(result)?.tasks ?? [];
      return { candidates: items.filter((t) => passesTodoistGate(t, now())).map(todoistCandidateToTask), error: null };
    } catch (err) {
      return { candidates: [], error: `Todoist: ${err?.message ?? 'connector error'}` };
    }
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
      return { scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, newTasks: [], detected: [], errors: [] };
    }

    const fetched = await mapWithConcurrency([...refsByKey.entries()], CONCURRENCY, async ([key, ref]) => {
      try {
        const threadResult = await callMcpTool(toolNames.slackReadThread, {
          channel_id: ref.channelId, message_ts: ref.threadTs,
        });
        const rawText = slackThreadText(unwrapMcpResult(threadResult));
        if (typeof rawText !== 'string') return null;
        return { key, ref, rawText, hash: djb2Hash(normalizeSlackThread(rawText)) };
      } catch {
        return null; // one thread's fetch failure must not block the rest of the batch
      }
    });
    const fetchedByKey = new Map(fetched.filter(Boolean).map((e) => [e.key, e]));

    // Built up as every ref is looked at (not just the ones that end up
    // classified) so the debug panel can show the full picture: what was
    // found, and what happened to each thing — unchanged, fetch-failed,
    // classified-and-X, or never classified at all.
    const detected = new Map();
    const watermarks = loadWatermarks(storage);
    const toClassify = [];
    for (const [key, ref] of refsByKey) {
      const entry = fetchedByKey.get(key);
      const label = threadLabel(entry?.rawText, ref);
      if (!entry) {
        detected.set(key, { key, label, outcome: 'fetch-failed' });
        continue;
      }
      const tracked = trackedByKey.get(key);
      const priorSignal = tracked ? tracked.contextHash : watermarks[key];
      if (priorSignal === slackChangeSignal(entry.hash)) {
        detected.set(key, { key, label, outcome: 'unchanged' });
      } else {
        toClassify.push(entry);
        detected.set(key, { key, label, outcome: 'pending' });
      }
    }

    if (toClassify.length === 0) {
      return { scanned, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, newTasks: [], detected: [...detected.values()], errors: [] };
    }

    const { verdicts, errors: classifyErrors } = await classifySlackBatch(toClassify, askClaude);

    let ongoing = 0, updated = 0, added = 0, skippedResolved = 0, unparsed = 0;
    const newTasks = [];

    for (const entry of toClassify) {
      const verdict = verdicts?.get(entry.key);
      const prior = detected.get(entry.key);
      if (!verdict) { unparsed++; detected.set(entry.key, { ...prior, outcome: 'unparsed' }); continue; }

      const signal = slackChangeSignal(entry.hash);
      const tracked = trackedByKey.get(entry.key);
      if (tracked) {
        const patch = {
          summary: verdict.summary,
          waitingOn: verdict.waitingOn,
          ballInUsersCourt: verdict.ballInUsersCourt,
          lastAiRunAt: now().toISOString(),
          contextHash: signal,
        };
        if (!tracked.userPinnedStatus) patch.status = verdict.status;
        patchTask(tracked.id, patch, storage);
        updated++;
        if (verdict.isOngoing) ongoing++;
        detected.set(entry.key, { ...prior, outcome: verdict.isOngoing ? 'updated-ongoing' : 'updated-resolved' });
      } else if (verdict.isOngoing) {
        newTasks.push(blankTask({
          title: verdict.summary || `Slack thread in ${entry.ref.channelId}`,
          source: 'slack',
          sourceRef: entry.ref,
          ballInUsersCourt: verdict.ballInUsersCourt,
          now: now(),
          summary: verdict.summary,
          waitingOn: verdict.waitingOn,
          contextHash: signal, // avoids a pointless re-classification of a brand-new, unchanged task on the very next scan
        }));
        added++;
        ongoing++;
        detected.set(entry.key, { ...prior, outcome: 'added' });
      } else {
        skippedResolved++;
        detected.set(entry.key, { ...prior, outcome: 'skipped-resolved' });
      }

      // Watermark every thread that got a real verdict, whichever way it
      // went, so a resolved-and-skipped thread isn't re-fetched and
      // re-classified forever. Unparsed threads are deliberately excluded
      // (see the `unparsed` branch above) so they get retried, not stuck.
      // The signal is versioned (see SLACK_JUDGMENT_VERSION) — bumping that
      // constant invalidates this watermark even though the content itself
      // hasn't changed, which is exactly the point: "content unchanged" and
      // "verdict still valid" are different claims.
      setWatermark(entry.key, signal, storage);
    }

    return { scanned, ongoing, updated, added, skippedResolved, unparsed, aiCalled: true, newTasks, detected: [...detected.values()], errors: classifyErrors };
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
      return { skipped: true, scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, unreadCheckAvailable: false, errors: [], detected: [] };
    }
    lastSlackTriageAt = nowMs;

    if (!toolNames.slackReadThread) {
      return { skipped: false, scanned: 0, ongoing: 0, updated: 0, added: 0, skippedResolved: 0, unparsed: 0, aiCalled: false, unreadCheckAvailable: false, errors: [], detected: [] };
    }

    const dismissedKeys = new Set(loadDismissedKeys(storage));
    const trackedSlackTasks = getTasks().filter((t) => t.source === 'slack');
    const trackedByKey = new Map(trackedSlackTasks.map((t) => [sourceRefKey(t), t]));

    const refsByKey = new Map();
    const errors = [];
    const configNotes = [];
    if (!toolNames.slackSearch) {
      // Tracked threads still get refreshed below; only *discovery* of new
      // ones is off. Worth saying out loud rather than looking like "nothing
      // is happening in Slack."
      configNotes.push({ key: 'slack:not-configured', label: 'no search tool configured (slackSearch is unset) — only already-tracked threads are refreshed', outcome: 'not-configured' });
    }
    if (toolNames.slackSearch) {
      for (const query of buildSlackRecentQueries(now())) {
        try {
          const searchResult = await callMcpTool(toolNames.slackSearch, { query, limit: 20 });
          const unwrapped = unwrapMcpResult(searchResult);
          const searchText = typeof unwrapped === 'string' ? unwrapped : (unwrapped?.results ?? '');
          for (const ref of extractSlackThreadRefs(searchText)) {
            const key = sourceRefKey({ source: 'slack', sourceRef: ref });
            if (!refsByKey.has(key)) refsByKey.set(key, ref);
          }
        } catch (err) {
          // One query failing must not block the other query or the
          // already-tracked-threads fallback below.
          errors.push(`Slack search ("${query}"): ${err?.message ?? 'connector error'}`);
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

    const { newTasks, detected, errors: classifyErrors, ...summary } = await slackTriageForRefs(refsByKey, trackedByKey);

    if (newTasks.length) {
      const existing = getTasks();
      saveTasks(mergeSeedTasks(existing, newTasks, [...dismissedKeys]), storage);
    }

    return {
      skipped: false, ...summary,
      detected: [...configNotes, ...detected],
      unreadCheckAvailable: false,
      errors: [...errors, ...classifyErrors],
    };
  }

  // Session-listing tools seen in the wild, tried in order. Claude Code
  // exposes ccd_session_mgmt (verified: a real array of
  // {sessionId,title,cwd,isArchived,isRunning,lastActivityAt}); Cowork has
  // been reported to expose session_info with a prose response instead.
  // Extra names can be added via toolNames.sessionProbeNames without a
  // rebuild, since a probe whose candidate list is hardcoded goes stale the
  // moment a host renames something.
  const KNOWN_SESSION_TOOL_NAMES = [
    'mcp__session_info__list_sessions',
    'mcp__ccd_session_mgmt__list_sessions',
  ];

  // A bare "400" from a tool that IS allowlisted usually means the arguments
  // are wrong, not that the tool is unusable — so try a few plausible shapes
  // rather than reporting one failure and stopping. Small limits throughout:
  // this is a shape probe, not a data pull, and a 195-session dump would bury
  // the structure being read.
  const SESSION_PROBE_ARG_VARIANTS = [{ limit: 3 }, {}, { limit: '3' }];

  // Runs on demand (never on the auto-refresh tick — it deliberately calls
  // tools that may not exist). Answers the two questions no amount of
  // describing a response can: can this tool be called from inside the
  // artifact's sandbox, and what does it *literally* return here.
  async function probeSessionTools() {
    const names = [...new Set([
      ...(toolNames.sessionList ? [toolNames.sessionList] : []),
      ...(toolNames.sessionProbeNames ?? []),
      ...KNOWN_SESSION_TOOL_NAMES,
    ])];

    const reports = [];
    for (const name of names) {
      for (const args of SESSION_PROBE_ARG_VARIANTS) {
        const report = await probeTool(callMcpTool, name, args);
        reports.push(report);
        if (report.outcome === 'ok') break; // found a working signature
        // An allowlist refusal is about the tool, not the arguments — more
        // variants would just produce identical noise.
        if (isAllowlistError(report.error)) break;
        if (report.outcome === 'unreachable') break;
      }
    }
    return reports;
  }

  // Coded against the live-verified ccd_session_mgmt shape only:
  // { sessionId, title, cwd, isArchived, isRunning, lastActivityAt } arrays.
  // Cowork has been observed exposing a *different* server (session_info)
  // with a prose response and none of those fields — deliberately NOT
  // supported here. Rather than silently returning zero candidates against
  // an unrecognized shape (indistinguishable from "nothing to report"),
  // this surfaces the mismatch as an explicit error so it doesn't masquerade
  // as "no in-flight sessions." Wiring up session_info itself needs a real
  // probe from inside the artifact — that's what probeSessionTools is for.
  async function discoverClaudeSessionCandidates(blockedKeys, watermarks) {
    // An unset tool name is the single most likely reason this source shows
    // zero, and a bare "0" is indistinguishable from "looked, found nothing."
    // Say which it is.
    if (!toolNames.sessionList) {
      return {
        candidates: [], error: null,
        detected: [{ key: 'claude:not-configured', label: 'no session-list tool configured (sessionList is unset)', outcome: 'not-configured' }],
      };
    }

    let result;
    try {
      result = await callMcpTool(toolNames.sessionList, { limit: 25 });
    } catch (err) {
      return { candidates: [], error: `Claude sessions: ${err?.message ?? 'connector error'}`, detected: [] };
    }
    const sessions = unwrapMcpResult(result);
    const list = Array.isArray(sessions) ? sessions : (Array.isArray(sessions?.sessions) ? sessions.sessions : null);

    if (list === null) {
      return {
        candidates: [],
        error: `list_sessions returned an unrecognized shape (expected an array or {sessions: [...]}, got ${typeof sessions}) — Claude session ingestion is coded against ccd_session_mgmt only and will not guess at a different server's format.`,
        detected: [],
      };
    }

    // Stale/archived sessions are excluded before the debug view even sees
    // them — with up to 25 sessions in play, showing every ancient one would
    // bury the signal, and "too old to matter" is a settled, cheap filter.
    const detected = [];
    const candidates = list.filter((s) => {
      if (!isCandidateClaudeSession(s, now())) return false;
      const key = sourceRefKey({ source: 'claude_session', sourceRef: { sessionId: s.sessionId } });
      if (blockedKeys.has(key)) return false; // dismissed — permanently invisible by design
      const unchanged = isUnchangedSinceLastScan(key, changeSignalFor('claude_session', s), watermarks);
      if (unchanged) detected.push({ key, label: s.title, outcome: 'unchanged' });
      return !unchanged;
    });

    const classified = await mapWithConcurrency(candidates, CONCURRENCY, async (session) => {
      const key = sourceRefKey({ source: 'claude_session', sourceRef: { sessionId: session.sessionId } });
      try {
        const eventsResult = await callMcpTool(toolNames.sessionEvents, {
          session_id: session.sessionId, limit: SESSION_TAIL_MESSAGES,
        });
        const tail = unwrapMcpResult(eventsResult);

        setWatermark(key, changeSignalFor('claude_session', session), storage);
        if (typeof tail !== 'string' || !tail.trim()) {
          detected.push({ key, label: session.title, outcome: 'no-transcript' });
          return null;
        }

        const judgment = parseSessionJudgment(await askClaude(buildSessionJudgmentPrompt(session, tail), []));
        if (!judgment?.needsAttention) {
          detected.push({ key, label: session.title, outcome: 'not-needed' });
          return null;
        }
        detected.push({ key, label: session.title, outcome: 'added' });
        return claudeSessionCandidateToTask(session, judgment);
      } catch {
        detected.push({ key, label: session.title, outcome: 'fetch-failed' });
        return null; // one session's failure must not block the rest of the batch
      }
    });

    return { candidates: classified.filter(Boolean), error: null, detected };
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

    const [linearResult, todoistResult, sessionResult] = await Promise.all([
      discoverLinearCandidates(),
      discoverTodoistCandidates(),
      discoverClaudeSessionCandidates(blockedKeys, watermarks),
    ]);

    const candidateTasks = [
      ...linearResult.candidates, ...todoistResult.candidates, ...sessionResult.candidates,
    ].map((c) => blankTask({
      title: c.title, source: c.source, sourceRef: c.sourceRef,
      ballInUsersCourt: c.ballInUsersCourt ?? false, now: now(),
      sourcePriority: c.sourcePriority ?? null, dueDate: c.dueDate ?? null,
      summary: c.summary ?? '', waitingOn: c.waitingOn ?? null,
    }));

    const existing = getTasks();
    const existingKeys = new Set(existing.map(sourceRefKey));
    const merged = mergeSeedTasks(existing, candidateTasks, dismissedKeys);
    saveTasks(merged, storage);

    const errors = [
      ...linearResult.errors,
      ...(todoistResult.error ? [todoistResult.error] : []),
      ...(sessionResult.error ? [sessionResult.error] : []),
    ];
    // Linear can't know "added vs. already-tracked" for itself — it doesn't
    // see the existing task list — so that's resolved here instead.
    const linearDetected = linearResult.detected.map((d) => ({
      ...d, outcome: existingKeys.has(d.key) ? 'already-tracked' : 'added',
    }));
    return {
      added: merged.length - existing.length,
      errors,
      detected: { linear: linearDetected, claude: sessionResult.detected },
    };
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
    getTasks, refreshAll, refreshOne, discoverNewTasks, runSlackTriage, probeSessionTools,
    addManualTask, addByLink, cycleStatusManual, reopen, remove, undismissAll,
  };
}
