// Tests for the model catalog (alphabetization + default preference).
import { describe, it, expect } from 'vitest';
import { fetchAvailableModels, pickModelPreference, DEFAULT_CLASSIFIER_MODEL } from '../app/ai/modelCatalog.js';

const TEST_MODELS = [
  { id: 'openai/gpt-5.6-luna-pro', name: 'OpenAI: GPT-5.6 Luna Pro' },
  { id: 'deepseek/deepseek-v4-flash-0731', name: 'DeepSeek: DeepSeek V4 Flash 0731' },
  { id: 'z-ai/glm-5.3', name: 'Z.ai: GLM 5.3' },
  { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5' },
];

describe('model catalog ordering + defaults', () => {
  it('DEFAULT_CLASSIFIER_MODEL is DeepSeek V4 Flash 0731', () => {
    expect(DEFAULT_CLASSIFIER_MODEL).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('pickModelPreference keeps the current model when present', () => {
    expect(pickModelPreference('z-ai/glm-5.3', TEST_MODELS)).toBe('z-ai/glm-5.3');
  });

  it('falls back to DeepSeek V4 Flash 0731 (not the first model) when the stored model is unknown', () => {
    expect(pickModelPreference('openai/some-old-model', TEST_MODELS)).toBe('deepseek/deepseek-v4-flash-0731');
  });

  it('falls back to the first model when even the default is missing', () => {
    const list = TEST_MODELS.filter((m) => !m.id.includes('deepseek'));
    expect(pickModelPreference('unknown', list)).toBe('openai/gpt-5.6-luna-pro');
  });

  it('fetchAvailableModels sorts alphabetically by id (via mocked fetch)', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({ data: TEST_MODELS }),
    });
    try {
      const sorted = await fetchAvailableModels('openrouter', 'sk-test');
      const ids = sorted.map((m) => m.id);
      expect(ids).toEqual([...ids].sort());
      expect(ids[0]).toBe('anthropic/claude-opus-5');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});