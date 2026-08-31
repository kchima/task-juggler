/**
 * Local session discovery — reads session metadata from Claude Code and
 * Claude Desktop local agent-mode sessions directly from the filesystem.
 *
 * Reads metadata only: session IDs, titles, timestamps, CWDs, models.
 * Does NOT read conversation transcripts, credentials, or tokens.
 *
 * Discovery sources:
 *   1. ~/.claude.json projects section (Claude Code repo-level sessions)
 *   2. ~/.claude/sessions/*.json (Claude Code per-session files)
 *   3. ~/Library/Application Support/Claude/local-agent-mode-sessions/
 *      (Claude Desktop local agent sessions)
 */

import fs from 'fs';
import path from 'path';

// ─── Paths ────────────────────────────────────────────────────────────────

const HOME = process.env.HOME || process.env.USERPROFILE || '/home';
const CLAUDE_CONFIG_PATH = path.join(HOME, '.claude.json');
const CLAUDE_SESSIONS_DIR = path.join(HOME, '.claude', 'sessions');
const CLAUDE_AGENT_SESSIONS_DIR = path.join(
  HOME, 'Library', 'Application Support', 'Claude', 'local-agent-mode-sessions'
);

// ─── Source: ~/.claude.json projects ──────────────────────────────────────

/**
 * Discover Claude Code project sessions from ~/.claude.json.
 * Each "project" in the config represents a recent Claude Code session
 * with rich metadata (session ID, cost, timestamps, model usage).
 */
function discoverClaudeConfigSessions() {
  const results = [];

  if (!fs.existsSync(CLAUDE_CONFIG_PATH)) return results;

  try {
    const raw = fs.readFileSync(CLAUDE_CONFIG_PATH, 'utf-8');
    const config = JSON.parse(raw);
    const projects = config.projects;

    if (!projects || typeof projects !== 'object') return results;

    for (const [projectPath, projectData] of Object.entries(projects)) {
      const lastSessionId = projectData.lastSessionId;
      if (!lastSessionId) continue;

      const projectName = projectPath.split('/').filter(Boolean).pop() || projectPath;
      const startedAt = projectData.lastStartTime || null;
      const modifiedAt = projectData.lastSessionModified || null;

      // Build model summary
      const modelUsage = projectData.lastModelUsage || {};
      const models = Object.keys(modelUsage);

      // Determine status
      const isRunning = !projectData.lastGracefulShutdown;
      const status = isRunning ? 'in_progress' : 'completed';

      results.push({
        id: lastSessionId,
        source: 'claude-config',
        title: projectName,
        description: projectData.lastSessionFirstPrompt || '',
        cwd: projectPath,
        projectName,
        status,
        startedAt,
        modifiedAt,
        gracefulShutdown: projectData.lastGracefulShutdown,
        cost: projectData.lastCost || null,
        version: projectData.lastVersionBase || null,
        models,
        modelUsage,
        duration: projectData.lastDuration || null,
        url: null, // No web URL for local sessions
      });
    }
  } catch (err) {
    // Silently return partial results
  }

  return results;
}

// ─── Source: ~/.claude/sessions/*.json ────────────────────────────────────

/**
 * Discover individual Claude Code session files from ~/.claude/sessions/.
 * Each session file contains process-level metadata (PID, CWD, start time).
 */
function discoverClaudeSessionFiles() {
  const results = [];

  if (!fs.existsSync(CLAUDE_SESSIONS_DIR)) return results;

  try {
    const entries = fs.readdirSync(CLAUDE_SESSIONS_DIR);

    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const filePath = path.join(CLAUDE_SESSIONS_DIR, entry);

      try {
        const stat = fs.statSync(filePath);
        // Skip files < 100 bytes (likely empty/incomplete)
        if (stat.size < 100) continue;

        const raw = fs.readFileSync(filePath, 'utf-8');
        const data = JSON.parse(raw);

        if (!data.sessionId) continue;

        // Determine if actively running (created within last 24 hours)
        const startedAt = data.startedAt || null;
        const now = Date.now();
        const isRecent = startedAt && (now - startedAt) < 24 * 60 * 60 * 1000;
        const status = isRecent ? 'in_progress' : 'completed';

        const projectName = data.name || data.cwd?.split('/').filter(Boolean).pop() || data.sessionId.slice(0, 8);

        results.push({
          id: data.sessionId,
          source: 'claude-session-file',
          title: projectName,
          description: data.name || '',
          cwd: data.cwd || null,
          projectName,
          status,
          startedAt,
          modifiedAt: stat.mtimeMs,
          gracefulShutdown: data.exitCode === 0,
          cost: null,
          version: data.version || null,
          models: [],
          modelUsage: null,
          duration: data.duration || null,
          entrypoint: data.entrypoint || null,
          url: null,
        });
      } catch {
        // Skip unparseable files
      }
    }
  } catch (err) {
    // Silently return partial results
  }

  return results;
}

// ─── Source: Claude Desktop local agent sessions ──────────────────────────

/**
 * Discover Claude Desktop local agent-mode sessions from
 * ~/Library/Application Support/Claude/local-agent-mode-sessions/.
 *
 * Structure: org-uuid/ -> local_<session-uuid>.json
 */
function discoverClaudeAgentSessions() {
  const results = [];

  if (!fs.existsSync(CLAUDE_AGENT_SESSIONS_DIR)) return results;

  try {
    const orgDirs = fs.readdirSync(CLAUDE_AGENT_SESSIONS_DIR);

    for (const orgDir of orgDirs) {
      const orgPath = path.join(CLAUDE_AGENT_SESSIONS_DIR, orgDir);
      if (!fs.statSync(orgPath).isDirectory()) continue;

      const accountDirs = fs.readdirSync(orgPath);
      for (const accountDir of accountDirs) {
        const accountPath = path.join(orgPath, accountDir);
        if (!fs.statSync(accountPath).isDirectory()) continue;

        // Read session JSON files
        const entries = fs.readdirSync(accountPath);
        for (const entry of entries) {
          if (!entry.endsWith('.json') || !entry.startsWith('local_')) continue;
          const filePath = path.join(accountPath, entry);

          try {
            const stat = fs.statSync(filePath);
            if (stat.size < 500) continue; // Skip empty/minimal files

            // Read only the first 4KB to get metadata keys
            const fd = fs.openSync(filePath, 'r');
            const buffer = Buffer.alloc(4096);
            const bytesRead = fs.readSync(fd, buffer, 0, 4096, 0);
            fs.closeSync(fd);

            const header = buffer.toString('utf-8', 0, bytesRead);

            // Extract metadata using regex (avoids loading full transcript)
            const sessionId = extractJsonString(header, 'sessionId');
            if (!sessionId) continue;

            const cwd = extractJsonString(header, 'cwd') || '';
            const title = extractJsonString(header, 'title') || 
                          extractJsonString(header, 'initialMessage', 80) || '';
            const createdAt = extractJsonNumber(header, 'createdAt');
            const lastActivityAt = extractJsonNumber(header, 'lastActivityAt');
            const model = extractJsonString(header, 'model') || '';
            const isArchived = extractJsonBool(header, 'isArchived');
            const permissionMode = extractJsonString(header, 'permissionMode') || '';

            const projectName = cwd.split('/').filter(Boolean).pop() || 'desktop-session';
            const now = Date.now();
            const isRecent = createdAt && (now - createdAt) < 24 * 60 * 60 * 1000;
            const status = (isArchived || (!isRecent && lastActivityAt && (now - lastActivityAt) > 7 * 24 * 60 * 60 * 1000))
              ? 'completed' : 'in_progress';

            results.push({
              id: sessionId,
              source: 'claude-agent',
              title: title || projectName,
              description: title || '',
              cwd: cwd || null,
              projectName,
              status,
              startedAt: createdAt,
              modifiedAt: lastActivityAt || stat.mtimeMs,
              gracefulShutdown: null,
              cost: null,
              version: null,
              models: model ? [model] : [],
              modelUsage: null,
              duration: null,
              entrypoint: 'local-agent',
              url: null,
            });
          } catch {
            // Skip unreadable files
          }
        }
      }
    }
  } catch (err) {
    // Silently return partial results
  }

  return results;
}

// ─── Main scan function ───────────────────────────────────────────────────

/**
 * Scan all local session sources and return a unified list of sessions.
 * Sessions are sorted by last activity time (most recent first).
 */
export function scanLocalSessions() {
  const configSessions = discoverClaudeConfigSessions();
  const sessionFiles = discoverClaudeSessionFiles();
  const agentSessions = discoverClaudeAgentSessions();

  // De-duplicate by session ID (config sessions take precedence)
  const seen = new Set();
  const all = [];

  for (const s of [...configSessions, ...sessionFiles, ...agentSessions]) {
    if (!seen.has(s.id)) {
      seen.add(s.id);
      all.push(s);
    }
  }

  // Sort by modifiedAt descending (most recent first)
  all.sort((a, b) => (b.modifiedAt || b.startedAt || 0) - (a.modifiedAt || a.startedAt || 0));

  // Only surface sessions active in the last 24h — this is a "what's current"
  // in-flight work surface, not an archive browser. Sessions with no usable
  // timestamp are kept (some sources only give status) but at least are sorted.
  const now = Date.now();
  const RECENT_MS = 24 * 60 * 60 * 1000;
  const recent = all.filter((s) => {
    const t = s.modifiedAt || s.startedAt;
    return !t || (now - t) < RECENT_MS;
  });

  // Summary stats
  const stats = {
    total: recent.length,
    active: recent.filter((s) => s.status === 'in_progress').length,
    completed: recent.filter((s) => s.status === 'completed').length,
    skippedOld: all.length - recent.length,
    bySource: {
      'claude-config': configSessions.length,
      'claude-session-file': sessionFiles.length,
      'claude-agent': agentSessions.length,
    },
  };

  return { sessions: recent, stats };
}

/**
 * Scan just the count and status without returning full sessions.
 * Useful for the connections panel summary.
 */
export function scanLocalSessionSummary() {
  const { stats } = scanLocalSessions();
  return stats;
}

// ─── JSON extraction helpers ──────────────────────────────────────────────

function extractJsonString(text, key, truncate = 0) {
  const regex = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
  const match = text.match(regex);
  if (!match) return null;
  let val = match[1]
    .replace(/\\"/g, '"')
    .replace(/\\\\/g, '\\')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t');
  if (truncate > 0 && val.length > truncate) val = val.slice(0, truncate);
  return val || null;
}

function extractJsonNumber(text, key) {
  const regex = new RegExp(`"${key}"\\s*:\\s*(\\d+)`);
  const match = text.match(regex);
  return match ? parseInt(match[1], 10) : null;
}

function extractJsonBool(text, key) {
  const regex = new RegExp(`"${key}"\\s*:\\s*(true|false)`);
  const match = text.match(regex);
  if (!match) return null;
  return match[1] === 'true';
}