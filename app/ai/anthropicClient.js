// Anthropic classifier provider — direct API (api.anthropic.com/v1/messages).
// Uses a forced tool_use call for structured JSON output, mirroring the
// OpenRouter provider's contract so the classifier layer is interchangeable.
//
// Returns the same normalized shape as the OpenRouter client:
//   { model, generationId, usage: { inputTokens, outputTokens }, costUsd, content }

const BASE_URL = 'https://api.anthropic.com/v1/messages';

export class AnthropicError extends Error {
  constructor(message, { code, retriable }) {
    super(message);
    this.name = 'AnthropicError';
    this.code = code || 'anthropic_error';
    this.retriable = retriable !== false;
  }
}

export async function classifyWithAnthropic({ config, model, system, prompt, schema, maxTokens, signal }) {
  const selectedModel = model || config.model || 'claude-sonnet-4-5-20250929';
  const toolName = (schema && schema.name) || 'task_verdict';

  const payload = {
    model: selectedModel,
    max_tokens: maxTokens || config.maxTokens || 1024,
    system,
    messages: [{ role: 'user', content: prompt }],
    tools: [{
      name: toolName,
      description: 'Structured classification verdict from the task-juggler schema',
      input_schema: (schema && schema.schema) || { type: 'object' },
    }],
    tool_choice: { type: 'tool', name: toolName },
  };

  const res = await fetch(BASE_URL, {
    method: 'POST',
    headers: {
      'x-api-key': config.anthropicApiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
    signal,
  });

  if (!res.ok) {
    const code = anthropicHttpErrorCode(res.status);
    throw new AnthropicError(`Anthropic ${res.status}: ${(await safeBody(res)).slice(0, 500)}`, {
      code: code.name,
      retriable: code.retriable,
    });
  }

  const data = await res.json();
  return parseAnthropicResponse(data, selectedModel);
}

/**
 * Parse an Anthropic /v1/messages response into the classifier's normalized
 * shape. Pulls the structured verdict from the forced tool_use block.
 * Exported for tests.
 */
export function parseAnthropicResponse(data, fallbackModel) {
  const blocks = Array.isArray(data.content) ? data.content : [];
  const toolUse = blocks.find((c) => c && c.type === 'tool_use');
  const text = blocks.filter((c) => c && c.type === 'text').map((c) => c.text || '').join('');
  const content = toolUse && toolUse.input ? JSON.stringify(toolUse.input) : text;
  return {
    model: data.model || fallbackModel,
    generationId: data.id || null,
    usage: {
      inputTokens: data.usage && data.usage.input_tokens,
      outputTokens: data.usage && data.usage.output_tokens,
    },
    costUsd: null, // Anthropic does not report cost in the response
    content,
  };
}

/** @private */
function anthropicHttpErrorCode(status) {
  if (status === 429) return { name: 'too_many_requests', retriable: true };
  if ([500, 502, 503, 504, 529].includes(status)) return { name: 'server_error', retriable: true };
  if ([401, 403].includes(status)) return { name: 'auth_error', retriable: false };
  if (status === 400) return { name: 'bad_request', retriable: false };
  return { name: `http_${status}`, retriable: false };
}

/** @private */
async function safeBody(res) {
  try { return await res.text(); } catch { return '(unreadable body)'; }
}