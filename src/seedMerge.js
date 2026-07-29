import { sourceRefKey } from './taskKey.js';

export function mergeSeedTasks(existingTasks, seedTasks, dismissedKeys = []) {
  const blocked = new Set([...existingTasks.map(sourceRefKey), ...dismissedKeys]);
  const additions = seedTasks.filter((t) => !blocked.has(sourceRefKey(t)));
  return [...existingTasks, ...additions];
}

export function readSeedFromDocument(doc = globalThis.document) {
  const el = doc?.getElementById('juggler-seed');
  if (!el) return [];
  try {
    const parsed = JSON.parse(el.textContent);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
