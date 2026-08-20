// Low-level classifier client. API keys live only in the server process
// environment or the macOS Keychain, and are never sent to the browser or
// persisted to the DB/logs.

import { getCredential, storeCredential } from '../auth/credentialStore.js';
import { getSetting, setSetting } from '../database.js';

const BASE_URL = 'https://openrouter.ai/api/v1';

// Classifier preferences persisted in the DB (provider / model / enabled) that
// override environment defaults. Loaded lazily via loadClassifierPrefs() so
// pure config reads in tests never touch the DB.
let _prefs = null;

export function getClassifierPrefs() {
  return _prefs ? { ..._prefs } : null;
}

/** Load persisted classifier prefs from the DB into the in-memory cache. */
export function loadClassifierPrefs() {
  const provider = getSetting('classifier.provider') || undefined;
  const model = getSetting('classifier.model') || undefined;
  const enabledRaw = getSetting('classifier.enabled');
  const enabled = enabledRaw != null ? enabledRaw !== 'false' : undefined;
  _prefs = { provider, model, enabled };
  return getClassifierPrefs();
}

/** Persist classifier prefs (provider/model/enabled) and update the cache. */
export async function saveClassifierPrefs(patch = {}) {
  // Always re-read from the DB so saves are idempotent and never diverge.
  loadClassifierPrefs();
  if (patch.provider !== undefined) setSetting('classifier.provider', patch.provider);
  if (patch.model !== undefined) setSetting('classifier.model', patch.model);
  if (patch.enabled !== undefined) setSetting('classifier.enabled', patch.enabled ? 'true' : 'false');
  return loadClassifierPrefs();
}

function classifierKey(provider) {
  return provider === 'anthropic' ? 'anthropic' : 'openrouter';
}

export function saveClassifierKey(provider, key) {
  storeCredential(`classifier-${classifierKey(provider)}-key`, { token: key, storedAt: Date.now() });
}

function resolveClassifierKey(provider) {
  try {
    const stored = getCredential(`classifier-${classifierKey(provider)}-key`);
    if (stored && stored.token) return stored.token;
  } catch {}
  return process.env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'OPENROUTER_API_KEY'] || null;
}

export class OpenRouterError extends Error {
  constructor(message, { code, retriable }) {
    super(message);
    this.name = 'OpenRouterError';
    this.code = code || 'openrouter_error';
    this.retriable = retriable !== false;
  }
}

/**
 * Read runtime AI configuration from the environment.
 *
 * Defaults to the user-approved pinned release `deepseek/deepseek-v4-flash-0731`
 * and the recommended budget guardrails. No free-form model ID is accepted from
 * the frontend — the frontend may only request an app-level action.
 */
export function getAiConfig() {
  const prefs = getClassifierPrefs() || {};
  const provider = (prefs.provider || process.env.TASK_JUGGLER_CLASSIFIER_PROVIDER || 'openrouter').toLowerCase();
  const defaultModel = provider === 'anthropic'
    ? 'claude-sonnet-4-5-20250929'
    : 'deepseek/deepseek-v4-flash-0731';
  const model = prefs.model || process.env.TASK_JUGGLER_CLASSIFIER_MODEL || defaultModel;
  const configuredFallbacks = (process.env.TASK_JUGGLER_CLASSIFIER_FALLBACKS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const enabled = prefs.enabled !== undefined
    ? prefs.enabled
    : (process.env.TASK_JUGGLER_AI_ENABLED || 'true').toLowerCase() !== 'false';
  return {
    provider,
    apiKey: resolveClassifierKey('openrouter'),
    anthropicApiKey: resolveClassifierKey('anthropic'),
    enabled,
    model,
    fallbacks: configuredFallbacks,
    maxDailyUsd: Number(process.env.TASK_JUGGLER_AI_MAX_DAILY_USD || 0.25),
    maxTokens: Number(process.env.TASK_JUGGLER_AI_MAX_TOKENS || 400),
    timeoutMs: Number(process.env.TASK_JUGGLER_AI_TIMEOUT_MS || 60_000),
    dataCollectionDeny: (process.env.TASK_JUGGLER_AI_DATA_COLLECTION_DENY || 'true').toLowerCase() !== 'false',
  };
}

/**
 * Is the classifier usable? True when the selected provider has a key.
 * Does NOT require `enabled` — "configured" and "auto-enabled" are separate
 * states, so the UI can say "configured (auto off)" instead of "not configured".
 */
export function isAiConfigured(config = getAiConfig()) {
  if (config.provider === 'anthropic') return !!config.anthropicApiKey;
  return !!config.apiKey;
}

/**
 * Call the classifier with strict JSON output for one item.
 * Dispatches to Anthropic's direct API when configured, otherwise OpenRouter.
 * Returns { model, generationId, usage, costUsd, content } or throws.
 */
export async function classifyItem({ config = getAiConfig(), model, system, prompt, schema, maxTokens, signal }) {
  if (config.provider === 'anthropic') {
    const { classifyWithAnthropic } = await import('./anthropicClient.js');
    return classifyWithAnthropic({ config, model, system, prompt, schema, maxTokens, signal });
  }
  return classifyWithOpenRouter({ config, model, system, prompt, schema, maxTokens, signal });
}

/** @private */
async function classifyWithOpenRouter({ config = getAiConfig(), model, system, prompt, schema, maxTokens, signal }) {
  const selectedModel = model || config.model;
  const payload = {
    model: selectedModel,
    stream: false,
    temperature: 0,
    max_tokens: maxTokens || config.maxTokens,
    messages: [{
      role: 'system',
      content: system,
    }, {
      role: 'user',
      content: prompt,
    }],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: schema.name,
        strict: true,
        schema: schema.schema,
      },
    },
    provider: {
      require_parameters: true,
      data_collection: config.dataCollectionDeny ? 'deny' : undefined,
    },
  };
  if (!payload.provider.data_collection) delete payload.provider.data_collection;

  const url = `${BASE_URL}/chat/completions`;
  const res = await fetchWithRetry(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': process.env.TASK_JUGGLER_ORIGIN || 'http://localhost:3000',
      'X-OpenRouter-Title': 'Task Juggler',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const code = httpErrorCode(res.status);
    throw new OpenRouterError(`OpenRouter ${res.status}: ${await safeBody(res)}`, {
      code: code.name,
      retriable: code.retriable,
    });
  }

  const data = await res.json();
  const choice = data && data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  return {
    model: data.model || selectedModel,
    generationId: data.id || null,
    usage: (data.usage && {
      inputTokens: data.usage.prompt_tokens,
      outputTokens: data.usage.completion_tokens,
    }) || null,
    costUsd: (data.usage && typeof data.usage.cost === 'number') ? data.usage.cost : null,
    content: typeof content === 'string' ? content : JSON.stringify(content || {}),
    finishReason: choice && choice.finish_reason,
  };
}

/**
 * fetch wrapper with retriable-status classification and optional Retry-After
 * handling. Kept minimal — the durable job queue owns persistence/backoff.
 */
async function fetchWithRetry(url, opts) {
  return fetch(url, opts);
}

function httpErrorCode(status) {
  if (status === 429) return { name: 'too_many_requests', retriable: true };
  if ([408, 502, 503, 504, 529].includes(status)) return { name: 'server_error', retriable: true };
  if ([401, 402, 403].includes(status)) return { name: 'auth_error', retriable: false };
  if (status === 400) return { name: 'bad_request', retriable: false };
  return { name: `http_${status}`, retriable: false };
}

async function safeBody(res) {
  try { const t = await res.text(); return t.slice(0, 500); } catch { return '(unreadable body)'; }
}