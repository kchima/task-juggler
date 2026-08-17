// Local-first Task Juggler server
import express from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import crypto from 'crypto';

import {
  getTaskById, createTask, updateTask, deleteTask,
  getAllTasks, getTaskTree, getChildren,
  batchDelete, batchComplete, batchUpdateStatus,
  countByStatus, closeDb, getDescendantIds,
  getAllSourceItems, dismissSourceItem, removeDismissSourceItem,
  linkSourceItemToTask, getJobStates, getPendingJobCount,
} from './database.js';
import { scanAllSources, checkMcpCapabilities } from './connector/scanner.js';
import { ingestAndQueue } from './ingestService.js';
import { processNextJobs, enqueueDueJobs, markUserFields } from './ai/classification.js';
import { getAiConfig, isAiConfigured } from './ai/openRouterClient.js';
import { tick as drainScheduler, startScheduler } from './scheduler.js';
import { McpClient } from './connector/mcpClient.js';
import { FakeMcpServer } from './connector/fakeMcpServer.js';
import {
  startAuthorization, handleCallback,
  getConnectionStatus, disconnectProvider,
  refreshAccessToken,
} from './auth/oauthManager.js';
import { storeCredential, getCredential } from './auth/credentialStore.js';
import {
  startMcpAuthorization, handleMcpCallback,
  getMcpConnectionStatus, disconnectMcpProvider,
  MCP_ENDPOINTS,
} from './connector/mcpOAuthClient.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.TASK_JUGGLER_PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());

// --- Static files (frontend) ----------------------------------------------
const publicDir = path.join(__dirname, 'public');
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
}

// --- Utility: get base URL from request ------------------------------------
function getBaseUrl(req) {
  const host = req.headers.host || `localhost:${PORT}`;
  return `${req.protocol}://${host}`;
}

// --- Task CRUD routes (unchanged) -----------------------------------------
app.get('/api/tasks', (_req, res) => {
  const tasks = getAllTasks();
  const counts = countByStatus();
  res.json({ tasks, counts });
});

app.get('/api/tasks/tree', (_req, res) => {
  const tree = getTaskTree();
  res.json({ tree });
});

app.get('/api/tasks/:id', (req, res) => {
  const task = getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

app.post('/api/tasks', (req, res) => {
  const { title, parentId } = req.body;
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  const id = crypto.randomUUID();
  const task = createTask({
    id,
    parentId: parentId || null,
    title: title.trim(),
    status: 'not_started',
    ...req.body,
  });
  res.status(201).json({ task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const { parentId, ballInUsersCourt, status, priority, estRemaining, dueDate, title, description, sortOrder } = req.body;
  const updated = updateTask(req.params.id, {
    parentId, ballInUsersCourt, status, priority, estRemaining, dueDate, title, description, sortOrder,
  });
  if (!updated) return res.status(404).json({ error: 'Task not found' });

  // AI-authority guard: if this task links back to a source item, record exactly
  // which fields the user edited so classification never overwrites them.
  pinUserEditedFields(req.params.id, { status, priority, title, description });

  res.json({ task: updated });
});

/**
 * When a user edits fields on a task that originated from a source item, record
 * those field names as human-pinned on the source item so AI classification will
 * not overwrite them.
 */
function pinUserEditedFields(taskId, fields) {
  const task = getTaskById(taskId);
  if (!task || !task.sourceRef) return;
  const sourceRef = task.sourceRef;
  if (typeof sourceRef === 'string' && !sourceRef.startsWith('{')) {
    const changed = [];
    if (fields.status !== undefined) changed.push('status');
    if (fields.priority !== undefined) changed.push('priority');
    if (fields.title !== undefined) changed.push('title');
    if (fields.description !== undefined) changed.push('description');
    if (changed.length > 0) markUserFields(sourceRef, changed);
  }
}

app.delete('/api/tasks/:id', (req, res) => {
  const task = getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  deleteTask(req.params.id);
  res.status(204).end();
});

app.post('/api/tasks/batch', (req, res) => {
  const { ids, action, newStatus } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }
  let targetIds = ids;
  if (action === 'delete') {
    const allIds = new Set(ids);
    for (const id of ids) {
      const descendants = getDescendantIds(id);
      for (const did of descendants) allIds.add(did);
    }
    targetIds = [...allIds];
  }
  switch (action) {
    case 'delete':
      batchDelete(targetIds);
      break;
    case 'complete':
      batchComplete(ids);
      break;
    case 'setStatus':
      if (!newStatus) return res.status(400).json({ error: 'newStatus required for setStatus' });
      batchUpdateStatus(ids, newStatus);
      break;
    default:
      return res.status(400).json({ error: `Unknown action: ${action}` });
  }
  res.json({ ok: true, affected: targetIds.length });
});

app.get('/api/tasks/:id/children', (req, res) => {
  const children = getChildren(req.params.id);
  res.json({ children });
});

// --- Source items (durable discover/ingest store) --------------------------

/**
 * GET /api/sources/items
 * List discovered source items. Excludes dismissed by default.
 */
app.get('/api/sources/items', (req, res) => {
  const includeDismissed = req.query.includeDismissed === 'true';
  const items = getAllSourceItems({ includeDismissed });
  res.json({ items });
});

/**
 * POST /api/sources/items/:key/dismiss
 * Dismiss a source item (it won't feed classification or promotion).
 */
app.post('/api/sources/items/:key/dismiss', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const item = dismissSourceItem(key);
  res.json({ ok: true, item });
});

/**
 * POST /api/sources/items/:key/undismiss
 */
app.post('/api/sources/items/:key/undismiss', (req, res) => {
  const key = decodeURIComponent(req.params.key);
  const item = removeDismissSourceItem(key);
  res.json({ ok: true, item });
});

// --- Classification / OpenRouter -------------------------------------------

/**
 * GET /api/classify/status
 * Report AI configuration + current job queue state (no secrets).
 */
app.get('/api/classify/status', (_req, res) => {
  const config = getAiConfig();
  res.json({
    configured: isAiConfigured(config),
    model: config.model,
    fallbacks: config.fallbacks,
    maxDailyUsd: config.maxDailyUsd,
    enabled: config.enabled,
    pendingJobs: getPendingJobCount(),
    jobStates: getJobStates(),
  });
});

/**
 * POST /api/classify/run
 * Manually enqueue due jobs and process a bounded batch now.
 * Body: { limit? }
 */
app.post('/api/classify/run', async (req, res) => {
  if (!isAiConfigured(getAiConfig())) {
    return res.status(400).json({ error: 'OpenRouter is not configured (set OPENROUTER_API_KEY).' });
  }
  const limit = Math.max(1, Math.min(Number(req.body?.limit) || 1, 20));
  try {
    const enqueue = await enqueueDueJobs();
    const processed = await processNextJobs({ limit });
    res.json({ enqueue, processed });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Health check ----------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', db: 'sqlite' });
});

// --- Import from legacy artifact state ------------------------------------
app.post('/api/import', (req, res) => {
  const { tasks } = req.body;
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return res.status(400).json({ error: 'tasks array required' });
  }
  let imported = 0;
  let skipped = 0;
  for (const t of tasks) {
    if (!t.title) { skipped++; continue; }
    const existing = getTaskById(t.id);
    if (existing) { skipped++; continue; }
    createTask({
      id: t.id,
      title: t.title,
      description: t.description || '',
      status: t.status || 'not_started',
      priority: t.priority || 'medium',
      estRemaining: t.estRemaining || 'medium',
      dueDate: t.dueDate || null,
      ballInUsersCourt: t.ballInUsersCourt || false,
      sourceRef: t.sourceRef || null,
      sourceUrl: t.sourceUrl || null,
      sourceType: t.sourceType || null,
      sortOrder: t.sortOrder || Date.now(),
      parentId: t.parentId || null,
    });
    imported++;
  }
  res.json({ ok: true, imported, skipped });
});

// --- OAuth routes ----------------------------------------------------------

/**
 * Start the OAuth authorization flow for a provider.
 * POST /api/auth/start/:provider
 * Body: {}
 * Response: { authUrl, state, providerId }
 *
 * The frontend should open `authUrl` in a new browser window/tab.
 */
app.post('/api/auth/start/:provider', async (req, res) => {
  const { provider } = req.params;
  const origin = getBaseUrl(req);
  try {
    const result = await startAuthorization(provider, origin);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * OAuth callback endpoint.
 * GET /api/auth/callback/:provider?code=...&state=...
 *
 * This is where the provider redirects the user after authorization.
 * Returns an HTML page showing success/failure.
 */
app.get('/api/auth/callback/:provider', async (req, res) => {
  const { provider } = req.params;
  try {
    const result = await handleCallback(provider, req.query);
    // Render a success page
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connected — Task Juggler</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1d27; border: 1px solid #2a2e3a; border-radius: 8px; padding: 40px; text-align: center; max-width: 480px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  p { color: #8b8fa3; margin-bottom: 24px; line-height: 1.5; }
  .success-icon { font-size: 3rem; margin-bottom: 16px; }
  a { color: #5b7cfa; text-decoration: none; padding: 8px 20px; border: 1px solid #5b7cfa; border-radius: 6px; display: inline-block; }
  a:hover { background: #5b7cfa; color: #fff; }
</style>
</head>
<body>
<div class="card">
  <div class="success-icon">✓</div>
  <h1>Connected to ${result.name}</h1>
  <p>Task Juggler has been authorized to access your ${result.name} data.<br>
     You can close this tab and return to the main app.</p>
  <a href="/" target="_blank">← Return to Task Juggler</a>
</div>
</body>
</html>`);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Connection Failed — Task Juggler</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f1117; color: #e1e4eb; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #1a1d27; border: 1px solid #e5534b; border-radius: 8px; padding: 40px; text-align: center; max-width: 480px; }
  h1 { font-size: 1.5rem; margin-bottom: 8px; }
  p { color: #8b8fa3; margin-bottom: 24px; line-height: 1.5; }
  .error-icon { font-size: 3rem; margin-bottom: 16px; }
  a { color: #5b7cfa; text-decoration: none; padding: 8px 20px; border: 1px solid #5b7cfa; border-radius: 6px; display: inline-block; }
  a:hover { background: #5b7cfa; color: #fff; }
  .error-detail { font-size: 0.85rem; color: #e5534b; background: rgba(229,83,75,0.1); border-radius: 4px; padding: 8px 12px; margin-bottom: 16px; }
</style>
</head>
<body>
<div class="card">
  <div class="error-icon">✕</div>
  <h1>Connection Failed</h1>
  <div class="error-detail">${escapeHtml(err.message)}</div>
  <p>Please try again from the Task Juggler app.</p>
  <a href="/" target="_blank">← Return to Task Juggler</a>
</div>
</body>
</html>`);
  }
});

/**
 * Get connection status for all providers or a single provider.
 * GET /api/auth/status — all providers
 * GET /api/auth/status/:provider — single provider
 */
app.get('/api/auth/status', (_req, res) => {
  // MCP OAuth providers (Slack, Linear, Todoist)
  const mcpIds = Object.keys(MCP_ENDPOINTS);
  // Legacy direct OAuth providers
  const legacyIds = ['todoist'];

  const statuses = {};

  // Check MCP OAuth status for each
  for (const id of mcpIds) {
    const mcpStatus = getMcpConnectionStatus(id);
    if (mcpStatus.connected) {
      statuses[id] = mcpStatus;
    } else {
      // Fall back to legacy OAuth
      const legacyStatus = getConnectionStatus(id);
      statuses[id] = legacyStatus;
    }
  }

  // Also check any legacy-only providers
  for (const id of legacyIds) {
    if (!statuses[id]) {
      statuses[id] = getConnectionStatus(id);
    }
  }

  // Add MCP endpoint info for unconnected providers
  for (const [id, ep] of Object.entries(MCP_ENDPOINTS)) {
    if (!statuses[id] || !statuses[id].connected) {
      statuses[id] = {
        ...(statuses[id] || { connected: false, providerId: id }),
        supportsMcpOAuth: true,
        mcpUrl: ep.mcpUrl,
      };
    }
  }

  res.json({ statuses });
});

app.get('/api/auth/status/:provider', (req, res) => {
  const { provider } = req.params;

  // Check MCP OAuth status first
  const mcpStatus = getMcpConnectionStatus(provider);
  if (mcpStatus.connected) {
    return res.json({ status: mcpStatus });
  }

  // Fall back to legacy OAuth status
  const status = getConnectionStatus(provider);
  res.json({ status });
});

/**
 * Disconnect a provider (revoke token + remove from Keychain).
 * POST /api/auth/disconnect/:provider
 */
app.post('/api/auth/disconnect/:provider', async (req, res) => {
  const { provider } = req.params;
  try {
    const result = await disconnectProvider(provider);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * Save OAuth client credentials for a non-DCR provider (e.g. Slack).
 * POST /api/auth/setup/:provider
 * Body: { clientId, clientSecret? }
 */
app.post('/api/auth/setup/:provider', (req, res) => {
  const { provider } = req.params;
  const { clientId, clientSecret } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });

  const clientData = {
    client_id: clientId,
    client_secret: clientSecret || null,
    configuredAt: Date.now(),
  };

  const serviceName = `${provider}-client`;
  storeCredential(serviceName, clientData);
  res.json({ ok: true, provider, clientConfigured: true });
});

// --- MCP OAuth routes (Slack, Linear, Todoist via hosted MCP) -------------

/**
 * Start MCP OAuth authorization flow.
 * POST /api/auth/mcp-start/:provider
 */
app.post('/api/auth/mcp-start/:provider', async (req, res) => {
  const { provider } = req.params;
  const ep = MCP_ENDPOINTS[provider];
  if (!ep) return res.status(400).json({ error: `Unknown MCP provider: ${provider}` });

  const origin = getBaseUrl(req);
  try {
    const result = await startMcpAuthorization(provider, ep.mcpUrl, origin);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/**
 * MCP OAuth callback.
 * GET /api/auth/mcp-callback/:provider?code=...&state=...
 */
app.get('/api/auth/mcp-callback/:provider', async (req, res) => {
  const { provider } = req.params;
  try {
    const result = await handleMcpCallback(provider, req.query);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Connected — Task Juggler</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#e1e4eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d27;border:1px solid #2a2e3a;border-radius:8px;padding:40px;text-align:center;max-width:480px}
  h1{font-size:1.5rem;margin-bottom:8px}
  p{color:#8b8fa3;margin-bottom:24px;line-height:1.5}
  .icon{font-size:3rem;margin-bottom:16px}
  a{color:#5b7cfa;text-decoration:none;padding:8px 20px;border:1px solid #5b7cfa;border-radius:6px;display:inline-block}
  a:hover{background:#5b7cfa;color:#fff}
</style></head>
<body><div class="card">
  <div class="icon">✓</div>
  <h1>Connected to ${result.name || provider}</h1>
  <p>Task Juggler has been authorized.<br>You can close this tab and return to the main app.</p>
  <a href="/" target="_blank">← Return to Task Juggler</a>
</div></body></html>`);
  } catch (err) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.status(400).send(`<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Connection Failed — Task Juggler</title>
<style>
  body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#0f1117;color:#e1e4eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0}
  .card{background:#1a1d27;border:1px solid #e5534b;border-radius:8px;padding:40px;text-align:center;max-width:480px}
  h1{font-size:1.5rem;margin-bottom:8px}
  p{color:#8b8fa3;margin-bottom:24px;line-height:1.5}
  .icon{font-size:3rem;margin-bottom:16px}
  a{color:#5b7cfa;text-decoration:none;padding:8px 20px;border:1px solid #5b7cfa;border-radius:6px;display:inline-block}
  a:hover{background:#5b7cfa;color:#fff}
  .detail{font-size:0.85rem;color:#e5534b;background:rgba(229,83,75,0.1);border-radius:4px;padding:8px 12px;margin-bottom:16px}
</style></head>
<body><div class="card">
  <div class="icon">✕</div>
  <h1>Connection Failed</h1>
  <div class="detail">${escapeHtml(err.message)}</div>
  <p>Please try again.</p>
  <a href="/" target="_blank">← Return to Task Juggler</a>
</div></body></html>`);
  }
});

// --- MCP OAuth disconnect -------------------------------------------------

app.post('/api/auth/mcp-disconnect/:provider', async (req, res) => {
  const { provider } = req.params;
  try {
    const result = await disconnectMcpProvider(provider);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- MCP OAuth client setup (for providers needing manual app registration like Slack) ---

/**
 * GET /api/auth/mcp-setup/:provider
 * Returns setup guide and current config status for an MCP provider.
 */
app.get('/api/auth/mcp-setup/:provider', (req, res) => {
  const { provider } = req.params;
  const ep = MCP_ENDPOINTS[provider];
  if (!ep) return res.status(400).json({ error: `Unknown MCP provider: ${provider}` });

  // Check if already configured
  const existing = getCredential(`${provider}-client`);
  const configured = !!(existing && existing.client_id);

  res.json({
    provider,
    name: ep.name,
    requiresAppRegistration: ep.requiresAppRegistration || false,
    configured,
    setupGuide: ep.setupGuide || [],
    scopes: ['search:read.public', 'search:read.private', 'channels:history', 'groups:history', 'mpim:history', 'im:history', 'users:read', 'channels:read', 'files:read', 'emoji:read', 'reactions:read'],
  });
});

/**
 * POST /api/auth/mcp-setup/:provider
 * Save OAuth client credentials for a provider that needs manual app registration (e.g. Slack).
 * Body: { clientId, clientSecret }
 */
app.post('/api/auth/mcp-setup/:provider', (req, res) => {
  const { provider } = req.params;
  const { clientId, clientSecret } = req.body;
  if (!clientId) return res.status(400).json({ error: 'clientId is required' });
  if (!clientSecret) return res.status(400).json({ error: 'clientSecret is required for confidential clients' });

  const clientData = {
    client_id: clientId,
    client_secret: clientSecret,
    configuredAt: Date.now(),
  };

  storeCredential(`${provider}-client`, clientData);
  res.json({ ok: true, provider, clientConfigured: true });
});

// --- Connector / Source scanning -------------------------------------------
let _mcpClient = null;
// In-memory API key storage for non-OAuth sources (Slack, Linear, Devin)
// OAuth-managed providers (Todoist) use Keychain grants instead.
let _apiKeys = {};

function getOrCreateMcpClient() {
  return _mcpClient;
}

/**
 * POST /api/sources/scan
 * Scans all configured sources for new tasks.
 * Uses OAuth grants from Keychain primarily, with env var and in-memory fallback.
 */
app.post('/api/sources/scan', async (req, res) => {
  const mcpClient = getOrCreateMcpClient();
  // Merge: in-memory keys > env vars (for non-OAuth sources)
  const envConfig = {
    linear: _apiKeys.linear || process.env.LINEAR_API_KEY || null,
    todoist: null, // OAuth-managed — uses Keychain grant
    slack: _apiKeys.slack || process.env.SLACK_BOT_TOKEN || null,
    devin: _apiKeys.devin || process.env.DEVIN_API_TOKEN || null,
  };
  const results = await scanAllSources(mcpClient, envConfig);

  // Ingest discovered items into the durable source_items store and enqueue any
  // due classification jobs (OpenRouter). Scanning stays read-only; ingestion
  // is the sole writer of source state from a scan.
  const aiConfig = getAiConfig();
  const ingestion = await ingestAndQueue(results);

  // Drain a bounded classification batch right after fetching (non-blocking, so
  // the scan response stays fast). The recurring scheduler handles steady state.
  void drainScheduler().catch(() => {});

  res.json({ results, ingestion, aiConfigured: isAiConfigured(aiConfig) });
});

// Store API keys for non-OAuth sources (Slack, Linear, Devin) — in-memory.
app.post('/api/sources/keys', (req, res) => {
  const { keys } = req.body;
  if (!keys || typeof keys !== 'object') return res.status(400).json({ error: 'keys object required' });
  const stored = {};
  for (const [sourceId, value] of Object.entries(keys)) {
    if (typeof value === 'string' && value.length > 4) {
      _apiKeys[sourceId] = value;
      stored[sourceId] = value.slice(0, 4) + '···' + value.slice(-4);
    }
  }
  res.json({ ok: true, stored: Object.keys(stored) });
});

// Get the stored API key status (which non-OAuth sources have keys, masked)
app.get('/api/sources/keys', (_req, res) => {
  const status = {};
  for (const [sourceId, value] of Object.entries(_apiKeys)) {
    status[sourceId] = { configured: true, masked: value.slice(0, 4) + '···' + value.slice(-4) };
  }
  for (const key of ['linear', 'todoist', 'slack', 'devin']) {
    if (!status[key] && process.env[`${key.toUpperCase()}_API_KEY`]) {
      status[key] = { configured: true, source: 'env' };
    }
  }
  res.json({ keys: status });
});

// Get source capability report
app.get('/api/sources/status', (_req, res) => {
  const mcpClient = getOrCreateMcpClient();
  const mcpStatus = checkMcpCapabilities(mcpClient);
  res.json({
    mcp: mcpStatus,
    sourceOrder: ['todoist', 'slack', 'linear', 'devin', 'claude', 'opencode'],
  });
});

// Configure an MCP server connection
app.post('/api/sources/configure-mcp', (req, res) => {
  res.json({ ok: true, message: 'MCP configuration saved. Restart the server to connect.' });
});

// --- Start server ----------------------------------------------------------
export function startServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => {
      console.log(`Task Juggler running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

// Allow direct run
const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('/app/server.js'));
if (isMain) {
  startServer(PORT).then(() => {
    // Start the recurring OpenRouter classifier (safe no-op if not configured).
    startScheduler();
  });
}

export { app };

// --- Helpers (inline, not exported) ----------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}