// OpenCode local discovery — reads only the non-transcript metadata tables of
// the local OpenCode SQLite database to surface unfinished, explicit todos as
// candidate work items.
//
// Privacy/safety rules (do not violate):
//  - Open the DB read-only, requiring the file to already exist.
//  - Only read `session`, `todo`, and optionally `project`.
//  - NEVER read message.data, part.data, session_message.data, session_input,
//    session.metadata, session.permission, or any credentials/account tables.
//  - Never infer a "waiting" state from local metadata; only map explicit
//    OpenCode todo.status values. There is no trustworthy waiting signal here.

import os from 'os';
import path from 'path';
import fs from 'fs';
import Database from 'better-sqlite3';

export const OPENCODE_DB_DEFAULT = path.join(
  os.homedir(),
  '.local', 'share', 'opencode', 'opencode.db',
);

const TODO_STATUS_ORDER = { in_progress: 0, pending: 1 };

/**
 * Scan the local OpenCode database for unfinished explicit todos.
 * Returns { sessions, stats, error? }. Any DB/open failure is isolated and
 * returned as `error` rather than thrown, matching scanner conventions.
 */
export function scanOpenCodeSessions({ dbPath = process.env.TASK_JUGGLER_OPENCODE_DB || OPENCODE_DB_DEFAULT, limit = 50 } = {}) {
  let conn;
  try {
    if (!fs.existsSync(dbPath)) {
      return { sessions: [], stats: { source: 'opencode', present: false, reason: 'missing' }, error: 'OpenCode database not found' };
    }
    conn = new Database(dbPath, { readonly: true, fileMustExist: true });
    // WAL mode must read only committed data; guard against a schema we don't
    // recognize without crashing the scan.
    const hasTodo = tableExists(conn, 'todo');
    const hasSession = tableExists(conn, 'session');
    if (!hasTodo || !hasSession) {
      return { sessions: [], stats: { source: 'opencode', present: true, reason: 'schema_mismatch' }, error: 'OpenCode schema tables missing/unexpected' };
    }

const nowMs = Date.now();
    const RECENT_MS = 24 * 60 * 60 * 1000;
    // Only surface todos updated in the last 24h (either the todo itself or its
    // session) — same temporal policy as every other source.
    const cutoff = String(nowMs - RECENT_MS);
    const rows = conn.prepare(`
      SELECT
        s.id          AS session_id,
        s.title       AS session_title,
        s.directory   AS cwd,
        s.project_id,
        s.time_updated AS session_updated_at,
        t.position,
        t.content     AS todo_content,
        t.status      AS todo_status,
        t.priority    AS todo_priority,
        t.time_updated AS todo_updated_at
      FROM todo AS t
      JOIN session AS s ON s.id = t.session_id
      WHERE s.time_archived IS NULL
        AND t.status IN ('in_progress', 'pending')
        AND (t.time_updated >= ? OR s.time_updated >= ?)
      ORDER BY
        CASE t.status WHEN 'in_progress' THEN 0 ELSE 1 END,
        CASE t.priority WHEN 'high' THEN 0 ELSE 1 END,
        t.time_updated DESC,
        s.time_updated DESC
      LIMIT ?
    `).all(cutoff, cutoff, limit);

    const sessions = rows.map((r) => normalizeTodo(r));
    return {
      sessions,
      stats: { source: 'opencode', present: true, count: sessions.length, reason: 'ok' },
      error: null,
    };
  } catch (err) {
    return { sessions: [], stats: { source: 'opencode', present: false, reason: 'read_failed' }, error: err.message };
  } finally {
    if (conn) { try { conn.close(); } catch {} }
  }
}

function tableExists(conn, name) {
  const r = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?").get(name);
  return !!r;
}

function normalizeTodo(r) {
  return {
    // Stable canonical key for Task Juggler ingestion: opencode:<sessionId>:todo:<position>
    key: `opencode:${r.session_id}:todo:${String(r.position ?? '')}`,
    source: 'opencode',
    title: r.todo_content || '(untitled todo)',
    sessionTitle: r.session_title || null,
    cwd: r.directory || null,
    projectId: r.project_id || null,
    status: r.todo_status === 'in_progress' ? 'in_progress' : 'pending',
    priority: r.todo_priority || null,
    modifiedAt: r.todo_updated_at || r.session_updated_at || null,
    url: null,
    sourceRef: { sessionId: r.session_id, position: r.position },
  };
}

/**
 * Produce a source_item-shaped slice for the scanner to ingest. Keeps the
 * todo text only (it is explicit user-authored metadata), no transcript.
 */
export function openCodeItems({ dbPath, limit } = {}) {
  const { sessions } = scanOpenCodeSessions({ dbPath, limit });
  return {
    sourceId: 'opencode',
    sessions,
    items: sessions.map((s) => ({
      key: s.key,
      label: s.title,
      status: s.status,
      priority: s.priority,
      url: null,
      // Everything the classifier needs to judge whether this todo is active
      // work needing the user: the todo text, its explicit state, and context.
      title: s.title,
      raw: {
        todoText: s.title,
        todoStatus: s.status,
        todoPriority: s.priority,
        sessionTitle: s.sessionTitle,
        cwd: s.cwd,
        modifiedAt: s.modifiedAt,
      },
    })),
  };
}

export default { scanOpenCodeSessions, openCodeItems, OPENCODE_DB_DEFAULT };