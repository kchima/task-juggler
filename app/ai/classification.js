// Server-native classification: structured prompt, JSON-schema contract,
// parser/semantic validation, and the AI-authority worker that applies verdicts
// to Task Juggler tasks while never overwriting user-pinned fields.

import crypto from 'crypto';
import {
  getSourceItemByKey, getAllSourceItems, getTaskById, createTask, updateTask,
  claimJobs, completeJob, failJob, enqueueClassificationJob, setHumanFields,
  linkSourceItemToTask, resetStaleLeases, getPriorVerdict,
} from '../database.js';
import { classifyItem, getAiConfig, isAiConfigured } from './openRouterClient.js';

export const CLASSIFIER_POLICY_VERSION = 1;
// Bumped because the prompts changed: incremental prior-verdict context was
// added, so previously judged items should be re-evaluated against the new
// prompt. Job uniqueness includes prompt_version, so bumping forces refresh.
export const CLASSIFIER_PROMPT_VERSION = 3;

export const STATUS_INTERNAL = {
  not_started: 'not_started',
  in_progress: 'in_progress',
  waiting_for_other: 'waiting_for_other',
  waiting_for_ai: 'waiting_for_ai',
  completed: 'completed',
  cancelled: 'cancelled',
  no_action: null, // item is resolved/no longer needs a Task Juggler task
};

export const CLASSIFICATION_SCHEMA = {
  name: 'task_verdict',
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['actionable', 'status', 'ballInUsersCourt', 'summary', 'reason', 'priority'],
    properties: {
      actionable: { type: 'boolean' },
      status: {
        type: 'string',
        enum: ['not_started', 'in_progress', 'waiting_for_other', 'waiting_for_ai', 'completed', 'cancelled', 'no_action'],
      },
      ballInUsersCourt: { type: 'boolean' },
      summary: { type: 'string', maxLength: 200 },
      reason: { type: 'string', maxLength: 400 },
      priority: { type: 'string', enum: ['urgent', 'high', 'medium', 'low'] },
    },
  },
};

export function buildSystemPrompt() {
  return [
    'You are the triage brain for a task manager called Task Juggler.',
    'You read a single candidate item from a connected system and decide whether it reflects real,',
    'actionable, in-progress work the user still needs.',
    'Answer ONLY with the exact JSON object described by the schema.',
    'Key rules:',
    '- "actionable" true means this is work the user has in flight (in progress) or that needs a',
    '  decision/follow-up. Prefer actionable for items whose status is "in_progress" or whose',
    '  metadata records active/pending work. Only "no_action" genuinely resolved/finished items.',
    '- status "waiting_for_other" means a human is waiting on someone else;',
    '  "waiting_for_ai" means work is paused waiting on an AI/agent to finish.',
    '- "ballInUsersCourt" true when the user is the responsible human who must act next.',
    '- When the item is done, stale, or a duplicate of finished state, use status "completed"',
    '  or "no_action" and set actionable false.',
    '- summary should be a concise actionable title (<=200 chars).',
    '- priority is one of urgent|high|medium|low.',
  ].join('\n');
}

export function buildUserPrompt(sourceItem) {
  const raw = sourceItem.raw && typeof sourceItem.raw === 'object' ? sourceItem.raw : null;
  const lines = [
    `Source type: ${sourceItem.sourceType}`,
    `Title: ${sourceItem.title}`,
  ];
  if (sourceItem.description) lines.push(`Description: ${sourceItem.description}`);
  if (sourceItem.status) lines.push(`Source status: ${sourceItem.status}`);
  if (sourceItem.priority) lines.push(`Source priority: ${sourceItem.priority}`);
  // Present structured metadata as human-readable signals the model can weigh.
  if (raw) {
    for (const [k, v] of Object.entries(raw)) {
      if (v != null && v !== '' && v !== false && v !== 0) {
        lines.push(`${k.replace(/([A-Z])/g, ' $1').trim()}: ${typeof v === 'string' ? v : JSON.stringify(v)}`);
      }
    }
  } else if (sourceItem.raw) {
    const s = String(sourceItem.raw);
    if (s) lines.push(`Raw context: ${s.slice(0, 2000)}`);
  }
  return lines.filter(Boolean).join('\n');
}

/**
 * Like buildUserPrompt but, when this item content has changed since a prior
 * successful judgment, appends a compact "previous verdict" so the model can
 * confirm-or-update incrementally rather than re-judging from scratch. This is
 * the "send the new message to the existing thread" pattern: we pass the prior
 * conclusion + the current state, not the entire history verbatim.
 */
export function buildUserPromptWithPrior(sourceItem, currentHash) {
  const base = buildUserPrompt(sourceItem);
  let prior;
  try {
    prior = getPriorVerdict(sourceItem.key, currentHash);
  } catch {
    prior = null;
  }
  if (!prior || !prior.verdict) return base;
  const v = prior.verdict;
  const compact = [
    'PREVIOUS VERDICT (from an earlier version of this item — content has since changed):',
    `  actionable: ${v.actionable} | status: ${v.status} | ballInUsersCourt: ${v.ballInUsersCourt}`,
    v.summary ? `  summary: ${v.summary}` : null,
    v.reason ? `  reason: ${v.reason}` : null,
  ].filter(Boolean).join('\n');
  return `${base}\n\n${compact}\n\nRe-evaluate based on the CURRENT content above. If the situation is unchanged, keep the prior verdict; if the changed content is new/more decisive, update it.`;
}

/**
 * Parse and semantically validate the OpenRouter response into a normalized
 * verdict. Throws on malformed/out-of-contract output so callers retry.
 */
export function parseVerdict(content) {
  const text = String(content || '').trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Model sometimes wraps the JSON in prose or other text — find the first
    // balanced {...} and try again.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); }
      catch { throw new Error('Verdict was not valid JSON'); }
    } else {
      throw new Error('Verdict was not valid JSON');
    }
  }
  const verdict = {
    actionable: parsed.actionable === true,
    status: parsed.status ?? 'no_action',
    ballInUsersCourt: parsed.ballInUsersCourt === true,
    summary: typeof parsed.summary === 'string' ? parsed.summary.slice(0, 200) : '',
    reason: typeof parsed.reason === 'string' ? parsed.reason.slice(0, 400) : '',
    priority: ['urgent', 'high', 'medium', 'low'].includes(parsed.priority) ? parsed.priority : 'medium',
  };
  if (!STATUS_INTERNAL.hasOwnProperty(verdict.status)) {
    throw new Error(`Unknown status in verdict: ${verdict.status}`);
  }
  return verdict;
}

/**
 * Apply a verdict to a source item, creating or updating its linked Task
 * Juggler task. Respects user-pinned fields (humanFields) — the AI only writes
 * fields the user has not edited. Returns { taskId, created, status }.
 */
export async function applyVerdict(sourceItem, verdict) {
  // The schema maps statuses to the tasks.status enum; "no_action" yields null
  // (no Task Juggler task needed for this item).
  const internalStatus = STATUS_INTERNAL[verdict.status];
  const human = new Set(Array.isArray(sourceItem.humanFields) ? sourceItem.humanFields : []);

  const linked = sourceItem.linkedTaskId ? getTaskById(sourceItem.linkedTaskId) : null;

  // Not actionable & no linked task yet → nothing to create, item stays as a
  // discovered-but-not-promoted source item.
  if ((!verdict.actionable || internalStatus == null) && !linked) {
    return { taskId: null, created: false, status: 'not_promoted' };
  }

  const title = !human.has('title') && verdict.summary ? verdict.summary : (linked ? linked.title : sourceItem.title || sourceItem.key);
  const status = !human.has('status') && internalStatus != null ? internalStatus : (linked ? linked.status : 'not_started');
  const priority = !human.has('priority') && verdict.priority ? verdict.priority : (linked ? linked.priority : 'medium');
  const description = !human.has('description') && verdict.reason ? verdict.reason : (linked ? linked.description : '');

  if (!linked) {
    if (!verdict.actionable) return { taskId: null, created: false, status: 'not_promoted' };
    const id = crypto.randomUUID();
    const task = createTask({
      id,
      title,
      description,
      status,
      priority,
      ballInUsersCourt: verdict.ballInUsersCourt,
      sourceRef: sourceItem.key,
      sourceUrl: sourceItem.url || null,
      sourceType: sourceItem.sourceType,
    });
    linkSourceItemToTask(sourceItem.key, task.id);
    return { taskId: task.id, created: true, status };
  }

  const updates = {};
  if (!human.has('status') && status !== linked.status) updates.status = status;
  if (!human.has('priority') && priority !== linked.priority) updates.priority = priority;
  if (!human.has('title') && title !== linked.title) updates.title = title;
  if (!human.has('description') && description !== linked.description) updates.description = description;
  if (verdict.ballInUsersCourt !== linked.ballInUsersCourt) updates.ballInUsersCourt = verdict.ballInUsersCourt;

  if (Object.keys(updates).length > 0) {
    updateTask(linked.id, updates);
  }
  return { taskId: linked.id, created: false, status: linked.status };
}

/**
 * Process a bounded number of pending classification jobs. Uses reliable
 * per-item calls (DeepSeek cannot produce structured-array batch output
 * reliably), but runs a small bounded concurrency to clear the backlog faster
 * and still amortize connection overhead.
 */
export async function processNextJobs({ limit = 5, config = getAiConfig(), now, concurrency = 3 } = {}) {
  if (!isAiConfigured(config)) {
    return { ok: false, reason: 'not_configured', processed: 0 };
  }
  // Recover jobs wedged 'leased' by a previous crashed/failed run.
  try { resetStaleLeases(); } catch {}

  const jobs = claimJobs(limit, { now });
  const outcomes = [];
  let idx = 0;

  async function worker() {
    while (idx < jobs.length) {
      const job = jobs[idx++];
      const result = await runSingleJob(job, config);
      outcomes.push(result);
    }
  }

  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, jobs.length)) }, () => worker());
  await Promise.all(workers);

  return { ok: true, processed: outcomes.length, outcomes };
}

/** @private */
async function runSingleJob(job, config) {
  const sourceItem = getSourceItemByKey(job.sourceKey);
  if (!sourceItem) {
    completeJob(job.id, { verdict: { error: 'source item missing' } });
    return { jobId: job.id, status: 'skipped_missing' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.timeoutMs);
    const result = await classifyItem({
      config,
      model: config.model,
      system: buildSystemPrompt(),
      prompt: buildUserPromptWithPrior(sourceItem, job.contentHash),
      schema: { name: CLASSIFICATION_SCHEMA.name, schema: CLASSIFICATION_SCHEMA.schema },
      signal: controller.signal,
    });
    clearTimeout(timer);

    const verdict = parseVerdict(result.content);
    const applied = await applyVerdict(sourceItem, verdict);

    completeJob(job.id, {
      verdict,
      servedModel: result.model,
      generationId: result.generationId,
      inputTokens: result.usage && result.usage.inputTokens,
      outputTokens: result.usage && result.usage.outputTokens,
      costUsd: result.costUsd,
    });
    return { jobId: job.id, status: 'ok', verdict, applied, costUsd: result.costUsd };
  } catch (err) {
    const attempts = job.attemptCount + 1;
    const code = err.code || 'program_error';
    failJob(job.id, { errorCode: code, attempts });
    return { jobId: job.id, status: 'failed', error: err.message, code };
  }
}

/**
 * Scan source items and enqueue classification jobs for any item whose content
 * hash changed since its last classified version (or that has never been
 * classified). Idempotent via the job uniqueness constraint.
 */
export async function enqueueDueJobs({ respectEnabled = true } = {}) {
  const config = getAiConfig();
  if (!isAiConfigured(config)) return { ok: false, reason: 'not_configured', enqueued: 0 };
  // When auto-classification is disabled, don't keep accumulating a queue on
  // every scan — but manual "Classify now" may bypass this via respectEnabled=false.
  if (respectEnabled && !config.enabled) return { ok: false, reason: 'disabled', enqueued: 0 };

  const items = getAllSourceItems({ includeDismissed: false });
  let enqueued = 0;
  let alreadyJudged = 0;
  for (const item of items) {
    const res = enqueueClassificationJob({
      sourceType: item.sourceType,
      sourceKey: item.key,
      contentHash: item.contentHash || '',
      policyVersion: CLASSIFIER_POLICY_VERSION,
      promptVersion: CLASSIFIER_PROMPT_VERSION,
    });
    if (res.created) enqueued++;
    else if (res.alreadyClassified) alreadyJudged++;
  }
  return { ok: true, enqueued, alreadyJudged, candidates: items.length, skippedUnchanged: alreadyJudged };
}

/**
 * Pin a set of fields on a source item as user-edited so AI classification
 * will not overwrite them. `sourceKey` is the item key; `fields` is an array
 * of task field names (title/status/priority/description).
 */
export function markUserFields(sourceKey, fields) {
  if (!sourceKey || !Array.isArray(fields) || fields.length === 0) return null;
  return setHumanFields(sourceKey, fields);
}