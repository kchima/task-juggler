// Local-first SQLite database layer for Task Juggler
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.TASK_JUGGLER_DB || path.join(__dirname, '..', 'data', 'tasks.db');

let db = null;

export function getDb() {
  if (!db) {
    const dir = path.dirname(DB_PATH);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    migrate(db);
  }
  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

/** Initialize an in-memory database for testing. Call closeDb() in afterEach. */
export function initTestDb() {
  closeDb();
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Schema version: stored in PRAGMA user_version.
 * This is the single source of truth for ordered, additive migrations.
 */
const MIGRATIONS = [
  () => {
    // v1 — tasks table (the original schema)
    db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id            TEXT PRIMARY KEY,
        parent_id     TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        title         TEXT NOT NULL,
        description   TEXT DEFAULT '',
        status        TEXT NOT NULL DEFAULT 'not_started'
                      CHECK(status IN ('not_started','in_progress','completed','cancelled','waiting_for_other','waiting_for_ai')),
        priority      TEXT DEFAULT 'medium'
                      CHECK(priority IN ('urgent','high','medium','low')),
        est_remaining TEXT DEFAULT 'medium'
                      CHECK(est_remaining IN ('small','medium','large')),
        due_date      TEXT,
        ball_in_users_court INTEGER NOT NULL DEFAULT 0,
        source_ref    TEXT,
        source_url    TEXT,
        source_type   TEXT,
        sort_order    REAL NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
    // Idempotent upgrade for databases created before these columns existed:
    // ALTER TABLE ADD COLUMN is a no-op-safe way to bring a partial schema in
    // line. SQLite forbids `IF NOT EXISTS` on ADD COLUMN, so check first. This
    // must run BEFORE creating indexes on those columns.
    ensureColumns('tasks', {
      parent_id: 'TEXT REFERENCES tasks(id) ON DELETE CASCADE',
      description: "TEXT DEFAULT ''",
      status: "TEXT NOT NULL DEFAULT 'not_started'",
      priority: "TEXT DEFAULT 'medium'",
      est_remaining: "TEXT DEFAULT 'medium'",
      due_date: 'TEXT',
      ball_in_users_court: 'INTEGER NOT NULL DEFAULT 0',
      source_ref: 'TEXT',
      source_url: 'TEXT',
      source_type: 'TEXT',
      sort_order: 'REAL NOT NULL DEFAULT 0',
      created_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
      updated_at: "TEXT NOT NULL DEFAULT (datetime('now'))",
    });
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source_ref);
    `);
  },
  () => {
    // v2 — durable source items (scan/discovery boundary, seed for classification)
    db.exec(`
      CREATE TABLE IF NOT EXISTS source_items (
        id               TEXT PRIMARY KEY,
        source_type      TEXT NOT NULL,
        key              TEXT NOT NULL UNIQUE,
        title            TEXT NOT NULL,
        description      TEXT DEFAULT '',
        status           TEXT,
        url              TEXT,
        priority         TEXT,
        raw              TEXT,
        content_hash     TEXT,
        source_updated_at TEXT,
        first_seen_at    TEXT NOT NULL DEFAULT (datetime('now')),
        last_seen_at     TEXT NOT NULL DEFAULT (datetime('now')),
        dismissed_at     TEXT,
        linked_task_id   TEXT REFERENCES tasks(id) ON DELETE SET NULL,
        human_fields     TEXT,
        created_at       TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_source_items_source ON source_items(source_type);
      CREATE INDEX IF NOT EXISTS idx_source_items_hash ON source_items(content_hash);
      CREATE INDEX IF NOT EXISTS idx_source_items_seen ON source_items(last_seen_at);
    `);
  },
  () => {
    // v3 — durable classification job queue (server-side OpenRouter scheduler)
    db.exec(`
      CREATE TABLE IF NOT EXISTS classification_jobs (
        id                TEXT PRIMARY KEY,
        source_type       TEXT NOT NULL,
        source_key        TEXT NOT NULL,
        content_hash      TEXT NOT NULL,
        policy_version    INTEGER NOT NULL DEFAULT 1,
        prompt_version    INTEGER NOT NULL DEFAULT 1,
        state             TEXT NOT NULL DEFAULT 'pending'
                          CHECK(state IN ('pending','leased','succeeded','retryable_failed','terminal_failed')),
        attempt_count     INTEGER NOT NULL DEFAULT 0,
        run_after         TEXT,
        lease_expires_at  TEXT,
        last_error_code   TEXT,
        configured_model  TEXT,
        served_model      TEXT,
        generation_id     TEXT,
        input_tokens      INTEGER,
        output_tokens     INTEGER,
        cost_usd          REAL,
        verdict           TEXT,
        created_at        TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at        TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE(source_type, source_key, content_hash, policy_version, prompt_version)
      );
      CREATE INDEX IF NOT EXISTS idx_classification_jobs_state ON classification_jobs(state, run_after);
      CREATE INDEX IF NOT EXISTS idx_classification_jobs_source ON classification_jobs(source_type, source_key);
    `);
  },
  () => {
    // v4 — simple key/value settings store (classifier prefs, etc.)
    db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      );
    `);
  },
];

/**
 * Apply pending migrations in order. Persists progress in PRAGMA user_version.
 */
function migrate(conn) {
  const current = conn.pragma('user_version', { simple: true }) || 0;
  for (let version = current; version < MIGRATIONS.length; version++) {
    // The migration functions close over the module-level `db`, which in
    // these tests is the in-memory connection. Guard so we always operate on
    // the connection passed in.
    const prevDb = db;
    db = conn;
    try {
      MIGRATIONS[version]();
    } finally {
      db = prevDb;
    }
    conn.pragma(`user_version = ${version + 1}`);
  }
}

/**
 * Add any missing columns to an existing table, preserving existing rows. This
 * makes migrations idempotent for databases created by earlier schema versions.
 */
function ensureColumns(table, columns) {
  const existing = new Set(
    db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name),
  );
  for (const [name, definition] of Object.entries(columns)) {
    if (existing.has(name)) continue;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
  }
}

export function getSchemaVersion() {
  const conn = getDb();
  return conn.pragma('user_version', { simple: true }) || 0;
}

// --- Query helpers ----------------------------------------------------------

function rowToTask(row) {
  if (!row) return null;
  // Deserialize JSON-stringified fields that may have been stored as objects
  const tryParse = (v) => {
    if (!v || typeof v !== 'string') return v;
    try { const p = JSON.parse(v); return p && typeof p === 'object' ? p : v; } catch { return v; }
  };
  return {
    id: row.id,
    parentId: row.parent_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    estRemaining: row.est_remaining,
    dueDate: row.due_date || null,
    ballInUsersCourt: !!row.ball_in_users_court,
    sourceRef: tryParse(row.source_ref),
    sourceUrl: tryParse(row.source_url),
    sourceType: row.source_type || null,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function getAllTasks() {
  const conn = getDb();
  const rows = conn.prepare('SELECT * FROM tasks WHERE status != ? ORDER BY sort_order ASC, created_at ASC').all('cancelled');
  return rows.map(rowToTask);
}

export function getTaskTree() {
  const tasks = getAllTasks();
  const map = new Map();
  const roots = [];

  for (const t of tasks) {
    map.set(t.id, { ...t, children: [] });
  }
  for (const t of map.values()) {
    if (t.parentId && map.has(t.parentId)) {
      map.get(t.parentId).children.push(t);
    } else {
      roots.push(t);
    }
  }
  return roots;
}

export function getTaskById(id) {
  const conn = getDb();
  return rowToTask(conn.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
}

export function createTask({ id, parentId, title, description, status, priority, estRemaining, dueDate, ballInUsersCourt, sourceRef, sourceUrl, sourceType, sortOrder }) {
  const conn = getDb();
  const now = new Date().toISOString();
  const order = sortOrder ?? Date.now();
  // better-sqlite3 v13 rejects JS objects as bound parameters, so
  // serialize objects (e.g. legacy sourceRef from artifact state) to JSON.
  const serialize = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

  conn.prepare(`
    INSERT INTO tasks (id, parent_id, title, description, status, priority, est_remaining, due_date, ball_in_users_court, source_ref, source_url, source_type, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, parentId || null, title, description || '', status || 'not_started',
    priority || 'medium', estRemaining || 'medium', dueDate || null,
    ballInUsersCourt ? 1 : 0, serialize(sourceRef) || null, sourceUrl || null,
    sourceType || null, order, now, now
  );
  return getTaskById(id);
}

export function updateTask(id, fields) {
  const conn = getDb();
  const existing = conn.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  if (!existing) return null;

  const sets = [];
  const params = [];

  if (fields.title !== undefined) { sets.push('title = ?'); params.push(fields.title); }
  if (fields.description !== undefined) { sets.push('description = ?'); params.push(fields.description); }
  if (fields.status !== undefined) { sets.push('status = ?'); params.push(fields.status); }
  if (fields.priority !== undefined) { sets.push('priority = ?'); params.push(fields.priority); }
  if (fields.estRemaining !== undefined) { sets.push('est_remaining = ?'); params.push(fields.estRemaining); }
  if (fields.dueDate !== undefined) { sets.push('due_date = ?'); params.push(fields.dueDate || null); }
  if (fields.ballInUsersCourt !== undefined) { sets.push('ball_in_users_court = ?'); params.push(fields.ballInUsersCourt ? 1 : 0); }
  if (fields.parentId !== undefined) { sets.push('parent_id = ?'); params.push(fields.parentId || null); }
  if (fields.sortOrder !== undefined) { sets.push('sort_order = ?'); params.push(fields.sortOrder); }

  if (sets.length === 0) return getTaskById(id);

  sets.push("updated_at = datetime('now')");
  params.push(id);

  conn.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  return getTaskById(id);
}

export function deleteTask(id) {
  const conn = getDb();
  conn.prepare('DELETE FROM tasks WHERE id = ?').run(id);
}

export function batchDelete(ids) {
  const conn = getDb();
  const del = conn.prepare('DELETE FROM tasks WHERE id = ?');
  const tx = conn.transaction((taskIds) => {
    for (const tid of taskIds) { del.run(tid); }
  });
  tx(ids);
}

export function batchComplete(ids) {
  const conn = getDb();
  const now = new Date().toISOString();
  const upd = conn.prepare("UPDATE tasks SET status = 'completed', updated_at = ? WHERE id = ?");
  const tx = conn.transaction((taskIds) => {
    for (const tid of taskIds) { upd.run(now, tid); }
  });
  tx(ids);
}

export function batchUpdateStatus(ids, newStatus) {
  const conn = getDb();
  const now = new Date().toISOString();
  const upd = conn.prepare("UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?");
  const tx = conn.transaction((taskIds) => {
    for (const tid of taskIds) { upd.run(newStatus, now, tid); }
  });
  tx(ids);
}

export function getChildren(parentId) {
  const conn = getDb();
  return conn.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY sort_order ASC, created_at ASC').all(parentId).map(rowToTask);
}

export function countByStatus() {
  const conn = getDb();
  return conn.prepare('SELECT status, COUNT(*) as count FROM tasks GROUP BY status').all()
    .reduce((acc, row) => { acc[row.status] = row.count; return acc; }, {});
}

export function getDescendantIds(id) {
  const conn = getDb();
  const ids = [];
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.shift();
    const children = conn.prepare('SELECT id FROM tasks WHERE parent_id = ?').all(current);
    for (const child of children) {
      ids.push(child.id);
      queue.push(child.id);
    }
  }
  return ids;
}

// --- Source items (scan/discovery boundary) --------------------------------

function rowToSourceItem(row) {
  if (!row) return null;
  const tryParse = (v) => {
    if (!v || typeof v !== 'string') return v;
    try { const p = JSON.parse(v); return p; } catch { return v; }
  };
  return {
    id: row.id,
    sourceType: row.source_type,
    key: row.key,
    title: row.title,
    description: row.description,
    status: row.status,
    url: row.url,
    priority: row.priority,
    raw: tryParse(row.raw),
    contentHash: row.content_hash,
    sourceUpdatedAt: row.source_updated_at,
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    dismissedAt: row.dismissed_at,
    linkedTaskId: row.linked_task_id,
    humanFields: tryParse(row.human_fields),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Insert or update a scanned source item.
 * Returns { sourceItem, created } where `created` is true only on first insert.
 */
export function upsertSourceItem(item) {
  const conn = getDb();
  const { id, sourceType, key, title, description, status, url, priority, raw, contentHash, sourceUpdatedAt } = item;
  const existing = conn.prepare('SELECT id FROM source_items WHERE key = ?').get(key);
  const now = new Date().toISOString();
  const serialize = (v) => (v !== null && typeof v === 'object' ? JSON.stringify(v) : v);

  if (existing) {
    conn.prepare(`
      UPDATE source_items SET
        title = ?, description = ?, status = ?, url = ?, priority = ?,
        raw = ?, content_hash = ?, source_updated_at = ?, last_seen_at = ?,
        updated_at = ?
      WHERE key = ?
    `).run(
      title, description || '', status || null, url || null, priority || null,
      serialize(raw) ?? null, contentHash || null, sourceUpdatedAt || null,
      now, now, key
    );
    return { sourceItem: getSourceItemByKey(key), created: false };
  }

  conn.prepare(`
    INSERT INTO source_items
      (id, source_type, key, title, description, status, url, priority, raw, content_hash, source_updated_at, last_seen_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id || key, sourceType, key, title, description || '', status || null,
    url || null, priority || null, serialize(raw) ?? null, contentHash || null,
    sourceUpdatedAt || null, now, now
  );
  return { sourceItem: getSourceItemByKey(key), created: true };
}

export function getSourceItemByKey(key) {
  const conn = getDb();
  return rowToSourceItem(conn.prepare('SELECT * FROM source_items WHERE key = ?').get(key));
}

/**
 * List source items, newest first. By default excludes dismissed items.
 */
export function getAllSourceItems({ includeDismissed = false, sourceType = null } = {}) {
  const conn = getDb();
  let sql = 'SELECT * FROM source_items';
  const clauses = [];
  const params = [];
  if (!includeDismissed) clauses.push('dismissed_at IS NULL');
  if (sourceType) { clauses.push('source_type = ?'); params.push(sourceType); }
  if (clauses.length) sql += ' WHERE ' + clauses.join(' AND ');
  sql += ' ORDER BY last_seen_at DESC';
  return conn.prepare(sql).all(...params).map(rowToSourceItem);
}

export function dismissSourceItem(key) {
  const conn = getDb();
  conn.prepare("UPDATE source_items SET dismissed_at = datetime('now'), updated_at = datetime('now') WHERE key = ?").run(key);
  return getSourceItemByKey(key);
}

export function removeDismissSourceItem(key) {
  const conn = getDb();
  conn.prepare("UPDATE source_items SET dismissed_at = NULL, updated_at = datetime('now') WHERE key = ?").run(key);
  return getSourceItemByKey(key);
}

export function linkSourceItemToTask(key, taskId) {
  const conn = getDb();
  conn.prepare('UPDATE source_items SET linked_task_id = ?, updated_at = datetime(\'now\') WHERE key = ?').run(taskId, key);
}

/**
 * Record which task fields the user has edited for a linked item, so AI
 * classification never overwrites a man/keith-considered answer.
 */
export function setHumanFields(key, fields) {
  const conn = getDb();
  const prev = getSourceItemByKey(key);
  const merged = new Set((prev && Array.isArray(prev.humanFields) ? prev.humanFields : []));
  for (const f of fields) merged.add(f);
  conn.prepare('UPDATE source_items SET human_fields = ?, updated_at = datetime(\'now\') WHERE key = ?').run(JSON.stringify([...merged]), key);
  return getSourceItemByKey(key);
}

// --- Classification jobs (durable server-side queue) -----------------------

function rowToJob(row) {
  if (!row) return null;
  return {
    id: row.id,
    sourceType: row.source_type,
    sourceKey: row.source_key,
    contentHash: row.content_hash,
    policyVersion: row.policy_version,
    promptVersion: row.prompt_version,
    state: row.state,
    attemptCount: row.attempt_count,
    runAfter: row.run_after,
    leaseExpiresAt: row.lease_expires_at,
    lastErrorCode: row.last_error_code,
    configuredModel: row.configured_model,
    servedModel: row.served_model,
    generationId: row.generation_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    verdict: row.verdict,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Create a classification job. Uniqueness over
 * (source_type, source_key, content_hash, policy_version, prompt_version)
 * makes enqueue idempotent across repeated scans/restarts.
 * Returns { job, created }.
 */
export function enqueueClassificationJob({ sourceType, sourceKey, contentHash, policyVersion = 1, promptVersion = 1 }) {
  const conn = getDb();
  const id = crypto.randomUUID();
  const existing = conn.prepare(`
    SELECT * FROM classification_jobs
    WHERE source_type = ? AND source_key = ? AND content_hash = ?
      AND policy_version = ? AND prompt_version = ?
  `).get(sourceType, sourceKey, contentHash, policyVersion, promptVersion);

  if (existing) {
    // If previously succeeded/terminal, keep it. If pending/leased/retryable, re-use.
    return { job: rowToJob(existing), created: false };
  }

  conn.prepare(`
    INSERT INTO classification_jobs (id, source_type, source_key, content_hash, policy_version, prompt_version, state)
    VALUES (?, ?, ?, ?, ?, ?, 'pending')
  `).run(id, sourceType, sourceKey, contentHash, policyVersion, promptVersion);
  return { job: rowToJob(conn.prepare('SELECT * FROM classification_jobs WHERE id = ?').get(id)), created: true };
}

/**
 * Claim a bounded set of pending jobs with a lease. Prevents concurrent
 * workers from re-claiming the same jobs.
 */
export function claimJobs(limit = 1, { leaseSeconds = 120, now = new Date() } = {}) {
  const conn = getDb();
  const nowIso = now.toISOString();
  const leaseExpiry = new Date(now.getTime() + leaseSeconds * 1000).toISOString();

  const pending = conn.prepare(`
    SELECT * FROM classification_jobs
    WHERE state = 'pending' AND (run_after IS NULL OR run_after <= ?)
    ORDER BY created_at ASC
    LIMIT ?
  `).all(nowIso, limit);

  if (pending.length === 0) return [];

  const leaseUpdate = conn.prepare("UPDATE classification_jobs SET state = 'leased', lease_expires_at = ?, updated_at = ? WHERE id = ?");
  const tx = conn.transaction((rows) => {
    for (const r of rows) leaseUpdate.run(leaseExpiry, nowIso, r.id);
  });
  tx(pending);

  // Re-read the freshly leased rows so we return their updated state.
  const ids = pending.map((r) => r.id);
  const placeholders = ids.map(() => '?').join(',');
  return conn.prepare(`SELECT * FROM classification_jobs WHERE id IN (${placeholders})`).all(...ids).map(rowToJob);
}

/** Mark a job complete with its observed model/cost/verdict. */
export function completeJob(id, { verdict, servedModel, generationId, inputTokens, outputTokens, costUsd }) {
  const conn = getDb();
  conn.prepare(`
    UPDATE classification_jobs SET
      state = 'succeeded', verdict = ?, served_model = ?, generation_id = ?,
      input_tokens = ?, output_tokens = ?, cost_usd = ?,
      last_error_code = NULL, updated_at = datetime('now')
    WHERE id = ?
  `).run(
    verdict ? JSON.stringify(verdict) : null, servedModel || null, generationId || null,
    inputTokens ?? null, outputTokens ?? null, costUsd ?? null, id
  );
}

/** Mark a job as retryable failure (with next run time) or terminal failure. */
export function failJob(id, { errorCode = 'unknown', attempts = 1, maxAttempts = 5, backoffMs }) {
  const conn = getDb();
  const terminal = attempts >= maxAttempts;
  const next = new Date(Date.now() + (backoffMs || 60_000 * Math.pow(2, Math.min(attempts, 6))));
  conn.prepare(`
    UPDATE classification_jobs SET
      state = ?, attempt_count = ?, last_error_code = ?,
      run_after = ?, updated_at = datetime('now')
    WHERE id = ?
  `).run(terminal ? 'terminal_failed' : 'pending', attempts, errorCode, next.toISOString(), id);
  return { terminal };
}

export function getPendingJobCount() {
  const conn = getDb();
  const r = conn.prepare("SELECT COUNT(*) AS c FROM classification_jobs WHERE state IN ('pending','leased','retryable_failed')").get();
  return r.c;
}

export function getJobStates() {
  const conn = getDb();
  return conn.prepare('SELECT state, COUNT(*) AS count FROM classification_jobs GROUP BY state').all()
    .reduce((acc, row) => { acc[row.state] = row.count; return acc; }, {});
}

/**
 * Sum the OpenRouter cost recorded for jobs completed today (UTC), used to
 * enforce the daily budget guardrail in the classification scheduler.
 * `updated_at` is set to `datetime('now')` (UTC) on completion.
 */
export function getTodayCompletedCostUsd() {
  const conn = getDb();
  const r = conn.prepare(
    "SELECT COALESCE(SUM(cost_usd), 0) AS total FROM classification_jobs WHERE state = 'succeeded' AND updated_at >= date('now')",
  ).get();
  return r && typeof r.total === 'number' ? r.total : 0;
}

// --- Settings key/value store ----------------------------------------------

export function getSetting(key, fallback = null) {
  try {
    const r = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return r ? r.value : fallback;
  } catch {
    return fallback;
  }
}

export function setSetting(key, value) {
  const conn = getDb();
  conn.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')
  `).run(key, String(value));
}