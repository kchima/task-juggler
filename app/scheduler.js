// Classification scheduler — makes the OpenRouter pipeline actually run.
//
// The scan→ingest service enqueues classification jobs, but nothing processed
// them automatically before this module: the built-in pipeline was inert unless
// someone hand-curl'd POST /api/classify/run. This module drains the durable
// queue on an interval and immediately after a scan, always single-flight, and
// never spends past the daily budget. It is safe by construction: when OpenRouter
// isn't configured (no key / disabled), tick() is a no-op.

import { processNextJobs, enqueueDueJobs } from './ai/classification.js';
import { getAiConfig, isAiConfigured } from './ai/openRouterClient.js';
import { getTodayCompletedCostUsd } from './database.js';
import { keepAliveAllMcpGrants } from './connector/mcpOAuthClient.js';

let _timer = null;
let _busy = false;

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Process a bounded batch of pending classification jobs, respecting the daily
 * budget. Never runs concurrently with itself. Safe no-op when AI is unconfigured.
 */
export async function tick({ config = getAiConfig(), batchSize } = {}) {
  if (_busy) return { ok: false, reason: 'busy', processed: 0 };

  // Keep OAuth grants from expiring while the app is running, even when no
  // scan triggers. This is what avoids "re-authorize every day".
  let keepAlive = null;
  try { keepAlive = await keepAliveAllMcpGrants(); } catch {}

  if (!config.enabled) return { ok: false, reason: 'disabled', processed: 0, keepAlive };
  if (!isAiConfigured(config)) return { ok: false, reason: 'not_configured', processed: 0, keepAlive };

  _busy = true;
  try {
    await enqueueDueJobs();
    const remaining = budgetRemainingUsd(config);
    if (remaining <= 0) return { ok: false, reason: 'daily_budget_exhausted', processed: 0, remaining, keepAlive };

    const size = Math.max(1, Math.min(batchSize || Number(process.env.TASK_JUGGLER_CLASSIFY_BATCH || 5), 20));
    const processed = await processNextJobs({ limit: size, config });
    return { ok: processed.ok, processed: processed.processed, outcomes: processed.outcomes, remaining, keepAlive };
  } finally {
    _busy = false;
  }
}

/**
 * How much daily OpenRouter budget remains, in USD.
 */
export function budgetRemainingUsd(config = getAiConfig()) {
  const spent = getTodayCompletedCostUsd();
  const cap = Number.isFinite(config.maxDailyUsd) ? config.maxDailyUsd : Infinity;
  return Math.max(0, cap - spent);
}

/**
 * Start the recurring classification loop. Returns { started, intervalMs }.
 * intervalMs <= 0 (or env TASK_JUGGLER_CLASSIFY_INTERVAL_MS=0) disables the timer;
 * tick() can still be invoked explicitly (e.g. after a scan).
 */
export function startScheduler({ intervalMs } = {}) {
  stopScheduler();
  const ms = intervalMs ?? Number(process.env.TASK_JUGGLER_CLASSIFY_INTERVAL_MS || DEFAULT_INTERVAL_MS);
  if (!(ms > 0)) return { started: false, intervalMs: 0, reason: 'disabled' };
  // One immediate attempt, then recurring.
  void tick().catch(() => {});
  _timer = setInterval(() => { void tick().catch(() => {}); }, ms);
  if (typeof _timer.unref === 'function') _timer.unref();
  return { started: true, intervalMs: ms };
}

export function stopScheduler() {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

/** @private for tests */
export function __isBusy() { return _busy; }
