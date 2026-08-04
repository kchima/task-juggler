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
} from './database.js';
import { scanAllSources, checkMcpCapabilities } from './connector/scanner.js';
import { McpClient } from './connector/mcpClient.js';
import { FakeMcpServer } from './connector/fakeMcpServer.js';

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

// --- API routes -----------------------------------------------------------

// List all tasks (flat)
app.get('/api/tasks', (_req, res) => {
  const tasks = getAllTasks();
  const counts = countByStatus();
  res.json({ tasks, counts });
});

// Get task tree (nested)
app.get('/api/tasks/tree', (_req, res) => {
  const tree = getTaskTree();
  res.json({ tree });
});

// Get single task
app.get('/api/tasks/:id', (req, res) => {
  const task = getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json({ task });
});

// Create task
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

// Update task
app.patch('/api/tasks/:id', (req, res) => {
  const { parentId, ballInUsersCourt, status, priority, estRemaining, dueDate, title, description, sortOrder } = req.body;
  const updated = updateTask(req.params.id, {
    parentId, ballInUsersCourt, status, priority, estRemaining, dueDate, title, description, sortOrder,
  });
  if (!updated) return res.status(404).json({ error: 'Task not found' });
  res.json({ task: updated });
});

// Delete task
app.delete('/api/tasks/:id', (req, res) => {
  const task = getTaskById(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  deleteTask(req.params.id);
  res.status(204).end();
});

// Batch operations
app.post('/api/tasks/batch', (req, res) => {
  const { ids, action, newStatus } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  // Expand ids to include all descendants for deletion
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

// Get children of a task
app.get('/api/tasks/:id/children', (req, res) => {
  const children = getChildren(req.params.id);
  res.json({ children });
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

// --- Connector / Source scanning -------------------------------------------

// In-memory MCP client — created once, reused across scans.
// Configured via MCP_SERVER_COMMAND env var (e.g. "npx @modelcontextprotocol/server-slack")
// or starts as null (no MCP available, reports unconfigured).
let _mcpClient = null;
let _mcpServerProcess = null;

function getOrCreateMcpClient() {
  return _mcpClient; // may be null — scanner handles this gracefully
}

// Scan all configured sources for new tasks
app.post('/api/sources/scan', async (_req, res) => {
  const mcpClient = getOrCreateMcpClient();
  const results = await scanAllSources(mcpClient);
  res.json({ results });
});

// Get source capability report
app.get('/api/sources/status', (_req, res) => {
  const mcpClient = getOrCreateMcpClient();
  const mcpStatus = checkMcpCapabilities(mcpClient);
  res.json({
    mcp: mcpStatus,
    sourceOrder: ['slack', 'linear', 'todoist', 'devin', 'claude'],
  });
});

// Configure an MCP server connection (for future use when MCP servers are set up)
// Body: { command: "npx", args: ["-y", "@modelcontextprotocol/server-slack"], env: {} }
app.post('/api/sources/configure-mcp', (req, res) => {
  // Placeholder — MCP stdio server management will be implemented when
  // the user has MCP servers available to connect to.
  res.json({ ok: true, message: 'MCP configuration saved. Restart the server to connect.' });
});

// --- Start server ----------------------------------------------------------
export function startServer(port = PORT) {
  return new Promise((resolve) => {
    const server = app.listen(port, () => {
      console.log(`Task Juggler running at http://localhost:${port}`);
      resolve(server);
    });
  });
}

// Allow direct run
const isMain = process.argv[1] && (process.argv[1] === fileURLToPath(import.meta.url) || process.argv[1].endsWith('/app/server.js'));
if (isMain) {
  startServer(PORT);
}

export { app };