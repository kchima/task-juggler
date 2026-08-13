// Tests for OpenCode local-session discovery (read-only, privacy-safe).
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import { scanOpenCodeSessions, openCodeItems } from '../../app/connector/openCodeSessions.js';

function buildFixtureDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fixture-'));
  const dbPath = path.join(dir, 'opencode.db');
  const conn = new Database(dbPath);
  conn.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, project_id TEXT, directory TEXT, title TEXT,
      time_archived TEXT, time_updated TEXT
    );
    CREATE TABLE todo (
      session_id TEXT, content TEXT, status TEXT, priority TEXT,
      position INTEGER, time_updated TEXT
    );
    CREATE TABLE project (id TEXT PRIMARY KEY, name TEXT);
    CREATE TABLE message (id TEXT PRIMARY KEY, data TEXT);
  `);
  conn.prepare(`INSERT INTO session (id, project_id, directory, title, time_archived, time_updated) VALUES
    ('ses_1', 'p1', '/work', 'Active session', NULL, '1000'),
    ('ses_2', 'p1', '/work', 'Archived session', '2024-01-01', '900')`).run();
  conn.prepare(`INSERT INTO todo (session_id, content, status, priority, position, time_updated) VALUES
    ('ses_1', 'Finish the thing', 'in_progress', 'high', 1, '1000'),
    ('ses_1', 'Clean up', 'pending', 'medium', 2, '950'),
    ('ses_2', 'Old task', 'in_progress', 'low', 1, '800'),
    ('ses_1', 'Done task', 'completed', 'medium', 3, '900')`).run();
  conn.prepare(`INSERT INTO message (id, data) VALUES ('m1', '{"text":"private transcript"}')`).run();
  conn.close();
  return dbPath;
}

describe('scanOpenCodeSessions', () => {
  it('returns unfinished todos from non-archived sessions, in priority order', () => {
    const dbPath = buildFixtureDb();
    const { sessions, error, stats } = scanOpenCodeSessions({ dbPath });
    expect(error).toBeNull();
    expect(stats.count).toBe(2); // archived + completed excluded
    expect(sessions[0].title).toBe('Finish the thing'); // in_progress first
    expect(sessions[0].key).toBe('opencode:ses_1:todo:1');
    expect(sessions.some((s) => s.title === 'Clean up')).toBe(true);
    // never include archived-session todos or completed todos
    expect(sessions.some((s) => s.title === 'Old task')).toBe(false);
    expect(sessions.some((s) => s.title === 'Done task')).toBe(false);
  });

  it('never reads transcript content', () => {
    const dbPath = buildFixtureDb();
    const { sessions } = scanOpenCodeSessions({ dbPath });
    const blobs = JSON.stringify(sessions);
    expect(blobs).not.toContain('private transcript');
    expect(blobs).not.toContain('m1');
  });

  it('reports a missing db as an isolated non-throwing error', () => {
    const { sessions, error } = scanOpenCodeSessions({ dbPath: '/nonexistent/opencode.db' });
    expect(sessions).toEqual([]);
    expect(error).toBeTruthy();
  });

  it('produces scanner-ready items via openCodeItems', () => {
    const dbPath = buildFixtureDb();
    const oc = openCodeItems({ dbPath });
    expect(oc.sourceId).toBe('opencode');
    expect(oc.items.length).toBe(2);
    expect(oc.items[0].key.startsWith('opencode:')).toBe(true);
  });
});