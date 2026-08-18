// Tests for the Anthropic classifier provider and provider-aware config.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { parseAnthropicResponse } from '../app/ai/anthropicClient.js';
import { getAiConfig, isAiConfigured } from '../app/ai/openRouterClient.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('parseAnthropicResponse', () => {
  it('extracts the structured verdict from the forced tool_use block', () => {
    const data = {
      id: 'msg_1',
      model: 'claude-sonnet-4-5-20250929',
      content: [
        { type: 'text', text: 'Here is the result' },
        { type: 'tool_use', name: 'task_verdict', input: { actionable: true, status: 'in_progress' } },
      ],
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    const r = parseAnthropicResponse(data, 'fallback');
    expect(r.model).toBe('claude-sonnet-4-5-20250929');
    expect(r.generationId).toBe('msg_1');
    expect(JSON.parse(r.content)).toEqual({ actionable: true, status: 'in_progress' });
    expect(r.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(r.costUsd).toBeNull();
  });

  it('falls back to text when no tool_use block is present', () => {
    const r = parseAnthropicResponse({ content: [{ type: 'text', text: '{"actionable":false}' }] }, 'm');
    expect(r.content).toBe('{"actionable":false}');
    expect(r.model).toBe('m');
  });
});

describe('classifier config (provider-aware)', () => {
  it('defaults to OpenRouter with the pinned DeepSeek model', () => {
    const c = getAiConfig();
    expect(c.provider).toBe('openrouter');
    expect(c.model).toBe('deepseek/deepseek-v4-flash-0731');
    expect(isAiConfigured(c)).toBe(false); // no key
  });

  it('is configured for Anthropic when provider + key are set', () => {
    vi.stubEnv('TASK_JUGGLER_CLASSIFIER_PROVIDER', 'anthropic');
    vi.stubEnv('ANTHROPIC_API_KEY', 'sk-ant-test');
    const c = getAiConfig();
    expect(c.provider).toBe('anthropic');
    expect(c.model).toBe('claude-sonnet-4-5-20250929');
    expect(isAiConfigured(c)).toBe(true);
  });

  it('is configured for OpenRouter when an OpenRouter key is present', () => {
    vi.stubEnv('OPENROUTER_API_KEY', 'sk-or-test');
    expect(isAiConfigured(getAiConfig())).toBe(true);
  });
});