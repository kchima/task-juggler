// Fetch available models for a classifier provider, so the UI can offer a
// dropdown instead of asking the user to guess IDs.

const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models';

// The default classifier model user wants. Kept here so the dropdown's fallback
// selection stays on it even when the stored model isn't in the fetched list.
export const DEFAULT_CLASSIFIER_MODEL = 'deepseek/deepseek-v4-flash-0731';

/**
 * Fetch models for a provider. Requires the provider's key.
 * Returns [{ id, name }] sorted alphabetically by id, or throws on error.
 */
export async function fetchAvailableModels(provider, apiKey) {
  const normalized = String(provider || '').toLowerCase();

  let models;
  if (normalized === 'anthropic') {
    const res = await fetch(ANTHROPIC_MODELS, {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    });
    if (!res.ok) throw new Error(`Anthropic models API returned ${res.status}`);
    const data = await res.json();
    const items = (data && data.data) || [];
    models = items
      .map((m) => ({ id: m.id, name: m.display_name || m.id }))
      .filter((m) => typeof m.id === 'string');
  } else {
    // OpenRouter (default)
    const res = await fetch(OPENROUTER_MODELS, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) throw new Error(`OpenRouter models API returned ${res.status}`);
    const data = await res.json();
    const items = (data && data.data) || [];
    models = items
      .map((m) => ({ id: m.id, name: m.name || m.id }))
      .filter((m) => typeof m.id === 'string' && !m.id.includes('-latest'));
  }

  // Deterministic, easy-to-browse order.
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Given a current model and a fetched list, prefer keeping the current model
 * if it's in the list. When it isn't, fall back to the user's preferred default
 * (DeepSeek V4 Flash 0731), then to the first (alphabetized) model. The naive
 * models[0] fallback previously picked whatever the API happened to list first.
 * Exported for tests.
 */
export function pickModelPreference(currentModel, models) {
  if (!Array.isArray(models) || models.length === 0) return currentModel;
  const normalized = String(currentModel || '').toLowerCase();
  const found = models.find((m) => String(m.id).toLowerCase() === normalized);
  if (found) return found.id;
  const dl = String(DEFAULT_CLASSIFIER_MODEL).toLowerCase();
  const defaultModel = models.find((m) => String(m.id).toLowerCase() === dl);
  return (defaultModel && defaultModel.id) || models[0].id;
}