// Low-level OpenRouter client. The API key lives only in the server process
// environment and is never sent to the browser or persisted to the DB/logs.

const BASE_URL = 'https://openrouter.ai/api/v1';

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
  const primary = process.env.TASK_JUGGLER_CLASSIFIER_MODEL || 'deepseek/deepseek-v4-flash-0731';
  const configuredFallbacks = (process.env.TASK_JUGGLER_CLASSIFIER_FALLBACKS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const enabled = (process.env.TASK_JUGGLER_AI_ENABLED || 'true').toLowerCase() !== 'false';
  return {
    apiKey: process.env.OPENROUTER_API_KEY || null,
    enabled,
    model: primary,
    fallbacks: configuredFallbacks,
    maxDailyUsd: Number(process.env.TASK_JUGGLER_AI_MAX_DAILY_USD || 0.25),
    maxTokens: Number(process.env.TASK_JUGGLER_AI_MAX_TOKENS || 400),
    timeoutMs: Number(process.env.TASK_JUGGLER_AI_TIMEOUT_MS || 60_000),
    dataCollectionDeny: (process.env.TASK_JUGGLER_AI_DATA_COLLECTION_DENY || 'true').toLowerCase() !== 'false',
  };
}

export function isAiConfigured(config = getAiConfig()) {
  return config.enabled && !!config.apiKey;
}

/**
 * Call OpenRouter chat completions with strict JSON output for one item.
 * Returns { model, generationId, usage, costUsd, content } or throws
 * OpenRouterError on failure.
 */
export async function classifyItem({ config = getAiConfig(), model, system, prompt, schema, maxTokens, signal }) {
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