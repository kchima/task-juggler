/**
 * Connector registry — defines what sources Task Juggler can discover tasks from.
 * Each source entry declares its display name, icon, whether it requires MCP or
 * can fall back to a direct API, and the discovery handler signature.
 */

// --- Source definitions ----------------------------------------------------

export const SOURCES = {
  slack: {
    id: 'slack',
    label: 'Slack',
    icon: '💬',
    description: 'Threads mentioning you or requiring a response',
    requiresMCP: true,
    hasDirectFallback: false,
    capabilities: ['search_threads', 'read_thread'],
  },
  linear: {
    id: 'linear',
    label: 'Linear',
    icon: '⬡',
    description: 'Issues assigned to you',
    requiresMCP: true,
    hasDirectFallback: true,
    capabilities: ['list_issues'],
  },
  todoist: {
    id: 'todoist',
    label: 'Todoist',
    icon: '✓',
    description: 'High-priority and overdue tasks',
    requiresMCP: true,
    hasDirectFallback: true,
    capabilities: ['find_tasks'],
  },
  devin: {
    id: 'devin',
    label: 'Devin',
    icon: 'Δ',
    description: 'Active Devin.ai sessions',
    requiresMCP: false,
    hasDirectFallback: true,
    capabilities: ['list_sessions'],
  },
claude: {
    id: 'claude',
    label: 'Claude',
    icon: '✦',
    description: 'Claude Code and Desktop local sessions',
    requiresMCP: false,
    hasDirectFallback: false,
    supportsLocalDiscovery: true,
    capabilities: ['list_sessions'],
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    icon: '⌘',
    description: 'Unfinished todos from local OpenCode sessions',
    requiresMCP: false,
    hasDirectFallback: false,
    supportsLocalDiscovery: true,
    capabilities: ['list_todos'],
  },
};

export const SOURCE_ORDER = ['slack', 'linear', 'todoist', 'devin', 'claude', 'opencode'];

export function getSource(id) {
  return SOURCES[id] || null;
}

export function getEnabledSources() {
  return SOURCE_ORDER.map((id) => SOURCES[id]).filter(Boolean);
}

// --- Scan result shape -----------------------------------------------------

/**
 * A scan result from a single source:
 * {
 *   sourceId: 'slack',
 *   status: 'ok' | 'error' | 'unconfigured' | 'not-available',
 *   items: [{ key, label, url }],
 *   errors: [string],
 *   detected: [{ key, label, outcome }],   // debug panel entries
 * }
 */

export function emptyScanResult(sourceId) {
  return { sourceId, status: 'ok', items: [], errors: [], detected: [] };
}

export function scanResultWithError(sourceId, error) {
  return { sourceId, status: 'error', items: [], errors: [error], detected: [] };
}

export function scanResultUnconfigured(sourceId) {
  return { sourceId, status: 'unconfigured', items: [], errors: [], detected: [] };
}