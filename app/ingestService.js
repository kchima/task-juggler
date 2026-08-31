// Ingestion service — bridges read-only source scan results into the durable
// `source_items` store, preserving normalized data + content hash, then offers
// to enqueue classification jobs. Scanning remains read-only discovery; this is
// the only place we mutate source state from a scan.

import { createHash } from 'crypto';
import { upsertSourceItem } from './database.js';
import { enqueueDueJobs } from './ai/classification.js';

/**
 * Ingest a set of scan results ({ sourceId -> { items: [...] } }) into
 * source_items. Preserves each item's canonical key, normalized content hash,
 * and latest source content. Returns counts per source.
 */
export function ingestScanResults(scanResults) {
  const summary = {};
  for (const [sourceId, result] of Object.entries(scanResults || {})) {
    const items = Array.isArray(result && result.items) ? result.items : [];
    let ingested = 0;
    let skipped = 0;
    for (const item of items) {
      if (!item || !item.key) { skipped++; continue; }
      upsertSourceItem(normalizeItem(sourceId, item));
      ingested++;
    }
    summary[sourceId] = { status: result.status, ingested, skipped };
  }
  return summary;
}

/**
 * Normalize a scanner item into the durable source_item shape.
 * Scanner items may carry { key, label, url, status, priority, ... } plus any
 * additional raw fields on `raw` / `_raw` that the source returned.
 */
export function normalizeItem(sourceId, item) {
  const raw = item.raw ?? item._raw ?? null;
  const fields = {
    sourceType: sourceId,
    key: item.key,
    title: item.title || item.label || item.key,
    description: item.description || '',
    status: item.status || null,
    url: item.url || null,
    priority: item.priority || (sourceId === 'todoist' && item.isUrgent ? 'high' : null),
    raw,
    sourceUpdatedAt: item.updatedAt || item.modifiedAt || null,
  };
  fields.contentHash = contentHash(fields);
  return fields;
}

/**
 * Stable, normalized content hash — used to detect whether a source item has
 * changed since it was last classified (skip unchanged content).
 *
 * IMPORTANT: only *content* that determines the verdict should affect the hash.
 * Volatile metadata (timestamps, recency, statuses that change every scan)
 * MUST NOT be in here, or unchanged threads get re-classified on every scan and
 * the credits bill grows unboundedly. `raw` is normalized to a stable string
 * (excluding keys like modifiedAt/updatedAt/createdAt/lastSeen).
 */
export function contentHash(fields) {
  const norm = JSON.stringify({
    sourceType: fields.sourceType,
    title: fields.title,
    description: fields.description,
    status: fields.status,
    priority: fields.priority,
    raw: stableRaw(fields.raw),
  });
  return createHash('sha256').update(norm).digest('hex');
}

/** Exclude volatile metadata keys from the hash-relevant raw context. */
const VOLATILE_RAW_KEYS = /^(modifiedAt|updatedAt|createdAt|lastSeenAt|firstSeenAt|sessionUpdatedAt)$/i;
function stableRaw(raw) {
  if (raw == null) return raw;
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) return raw.map(stableRaw);
  if (typeof raw === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(raw)) {
      if (VOLATILE_RAW_KEYS.test(k)) continue;
      out[k] = stableRaw(v);
    }
    return out;
  }
  return raw;
}

/**
 * Ingest scan results and enqueue classification jobs for changed/new items.
 * Returns { ingest: summary, enqueue: { ok, enqueued } }.
 */
export async function ingestAndQueue(scanResults) {
  const ingest = ingestScanResults(scanResults);
  let enqueue;
  try {
    enqueue = await enqueueDueJobs();
  } catch (err) {
    enqueue = { ok: false, reason: err.message, enqueued: 0 };
  }
  return { ingest, enqueue };
}