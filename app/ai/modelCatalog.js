// Fetch available models for a classifier provider, so the UI can offer a
// dropdown instead of asking the user to guess IDs.

const OPENROUTER_MODELS = 'https://openrouter.ai/api/v1/models';
const ANTHROPIC_MODELS = 'https://api.anthropic.com/v1/models';

/**
 * Fetch models for a provider. Requires the provider's key.
 * Returns [{ id, name }] or throws on error.
 */
export async function fetchAvailableModels(provider, apiKey) {
  const normalized = String(provider || '').toLowerCase();

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
    return items
      .map((m) => ({ id: m.id, name: m.display_name || m.id }))
      .filter((m) => typeof m.id === 'string');
  }

  // OpenRouter (default)
  const res = await fetch(OPENROUTER_MODELS, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!res.ok) throw new Error(`OpenRouter models API returned ${res.status}`);
  const data = await res.json();
  const items = (data && data.data) || [];
  return items
    .map((m) => ({ id: m.id, name: m.name || m.id }))
    .filter((m) => typeof m.id === 'string' && !m.id.includes('-latest'));
}

/**
 * Given a current model and a fetched list, prefer keeping the current model
 * if it's in the list (so selection doesn't jump). Exported for tests.
 */
export function pickModelPreference(currentModel, models) {
  if (!Array.isArray(models) || models.length === 0) return currentModel;
  const normalized = String(currentModel || '').toLowerCase();
  const found = models.find((m) => String(m.id).toLowerCase() === normalized);
  return (found && found.id) || models[0].id;
}