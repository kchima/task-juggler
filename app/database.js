// Local-first SQLite database layer for Task Juggler
import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
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
    initSchema();
  }
  return db;
}

function initSchema() {
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

    CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_tasks_source_ref ON tasks(source_ref);
  `);
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
  initSchema();
  return db;
}

// --- Query helpers ----------------------------------------------------------

function rowToTask(row) {
  if (!row) return null;
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
    sourceRef: row.source_ref || null,
    sourceUrl: row.source_url || null,
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

  conn.prepare(`
    INSERT INTO tasks (id, parent_id, title, description, status, priority, est_remaining, due_date, ball_in_users_court, source_ref, source_url, source_type, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, parentId || null, title, description || '', status || 'not_started',
    priority || 'medium', estRemaining || 'medium', dueDate || null,
    ballInUsersCourt ? 1 : 0, sourceRef || null, sourceUrl || null,
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