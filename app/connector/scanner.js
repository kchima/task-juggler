/**
 * Source scanner — attempts to discover tasks from each configured source.
 * Tries MCP first, falls back to direct API adapters when configured.
 * Each scan is isolated: one source failing never blocks another.
 */

import {
  emptyScanResult, scanResultWithError, scanResultUnconfigured,
} from './registry.js';
import {
  scanLinearDirect, scanTodoistDirect, scanSlackDirect, scanDevinDirect,
  getDirectAdaptersConfig,
} from './directAdapters.js';

// --- MCP client discovery -------------------------------------------------

async function tryMcpDiscovery(sourceId, mcpClient) {
  try {
    switch (sourceId) {
      case 'slack':   return await scanSlackViaMcp(mcpClient);
      case 'linear':  return await scanLinearViaMcp(mcpClient);
      case 'todoist': return await scanTodoistViaMcp(mcpClient);
      default:
        return scanResultWithError(sourceId, `No MCP adapter for ${sourceId}`);
    }
  } catch (err) {
    return scanResultWithError(sourceId, err.message || 'MCP discovery failed');
  }
}

async function scanSlackViaMcp(mcpClient) {
  // ...unchanged from before...
  const result = emptyScanResult('slack');
  if (!mcpClient.hasTool('slack_search') || !mcpClient.hasTool('slack_read_thread')) {
    result.status = 'unconfigured';
    if (!mcpClient.hasTool('slack_search')) result.errors.push('slack_search tool not available');
    if (!mcpClient.hasTool('slack_read_thread')) result.errors.push('slack_read_thread tool not available');
    return result;
  }
  try {
    for (const query of ['is:thread to:me after:yesterday', 'is:thread from:me after:yesterday']) {
      const searchResult = await mcpClient.callTool('slack_search', { query, limit: 20 });
      const text = extractTextContent(searchResult);
      if (text) {
        for (const ref of extractSlackThreadRefs(text)) {
          const key = `slack:${ref.channelId}:${ref.threadTs}`;
          if (!result.items.some((i) => i.key === key)) {
            result.items.push({
              key,
              label: `Thread in #${ref.channelId}`,
              url: `https://${ref.workspaceDomain}/archives/${ref.channelId}/p${ref.threadTs.replace('.', '')}?thread_ts=${ref.threadTs}&cid=${ref.channelId}`,
            });
            result.detected.push({ key, label: `Thread in #${ref.channelId}`, outcome: 'pending' });
          }
        }
      }
    }
  } catch (err) {
    result.errors.push(`Slack search: ${err.message}`);
  }
  return result;
}

async function scanLinearViaMcp(mcpClient) {
  const result = emptyScanResult('linear');
  if (!mcpClient.hasTool('linear_list_issues')) {
    result.status = 'unconfigured';
    result.errors.push('linear_list_issues tool not available');
    return result;
  }
  try {
    const issuesResult = await mcpClient.callTool('linear_list_issues', { assignee: 'me' });
    const raw = extractTextContent(issuesResult);
    const issues = safeJsonParse(raw)?.issues || [];
    for (const issue of issues) {
      if (!['backlog', 'unstarted', 'started', 'triage'].includes(issue.statusType)) continue;
      const key = `linear:${issue.id}`;
      result.items.push({ key, label: `[${issue.identifier || issue.id}] ${issue.title}`, url: issue.url || null });
      result.detected.push({ key, label: issue.title, outcome: 'added' });
    }
  } catch (err) {
    result.errors.push(`Linear: ${err.message}`);
  }
  return result;
}

async function scanTodoistViaMcp(mcpClient) {
  const result = emptyScanResult('todoist');
  if (!mcpClient.hasTool('todoist_find_tasks')) {
    result.status = 'unconfigured';
    result.errors.push('todoist_find_tasks tool not available');
    return result;
  }
  try {
    const tasksResult = await mcpClient.callTool('todoist_find_tasks', { filter: 'today | overdue | p1', limit: 50 });
    const raw = extractTextContent(tasksResult);
    const tasks = safeJsonParse(raw)?.tasks || [];
    for (const task of tasks) {
      const key = `todoist:${task.id}`;
      const isUrgent = task.priority === 'p1' || (task.dueDate && new Date(task.dueDate) <= new Date());
      result.items.push({ key, label: task.content, url: null });
      result.detected.push({ key, label: task.content, outcome: isUrgent ? 'added' : 'skipped-gate' });
    }
  } catch (err) {
    result.errors.push(`Todoist: ${err.message}`);
  }
  return result;
}

// --- Helpers ---------------------------------------------------------------

function extractTextContent(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  if (mcpResult.content && Array.isArray(mcpResult.content)) {
    return mcpResult.content.map((c) => c.text || '').join('\n');
  }
  if (mcpResult.text) return mcpResult.text;
  return JSON.stringify(mcpResult);
}

function safeJsonParse(str) {
  if (typeof str !== 'string') return null;
  try { return JSON.parse(str); } catch { return null; }
}

const SLACK_PERMALINK_RE = /https:\/\/([\w-]+\.slack\.com)\/archives\/([A-Z0-9]+)\/p\d+\?[^)\s]*thread_ts=([\d.]+)/g;

function extractSlackThreadRefs(text) {
  const refs = new Map();
  for (const match of text.matchAll(SLACK_PERMALINK_RE)) {
    const [, workspaceDomain, channelId, threadTs] = match;
    const key = `${channelId}:${threadTs}`;
    if (!refs.has(key)) refs.set(key, { channelId, threadTs, workspaceDomain });
  }
  return [...refs.values()];
}

// --- Main scan orchestrator ------------------------------------------------

/**
 * Scan all sources. Accepts optional MCP client and optional env-config for direct adapters.
 */
export async function scanAllSources(mcpClient = null, envConfig = {}) {
  // Resolve direct adapter credentials from envConfig or process.env
  const direct = {
    linear: envConfig.linear || process.env.LINEAR_API_KEY || null,
    todoist: envConfig.todoist || process.env.TODOIST_API_TOKEN || null,
    slack: envConfig.slack || process.env.SLACK_BOT_TOKEN || null,
    devin: envConfig.devin || process.env.DEVIN_API_TOKEN || null,
  };

  const results = {};

  // --- Slack ---
  if (mcpClient && mcpClient.hasTool('slack_search')) {
    results.slack = await tryMcpDiscovery('slack', mcpClient);
  } else if (direct.slack) {
    results.slack = await scanSlackDirect(direct.slack);
  } else {
    results.slack = scanResultUnconfigured('slack');
    results.slack.errors.push('No Slack MCP server or SLACK_BOT_TOKEN configured. To enable: (a) connect a Slack MCP server, or (b) set the SLACK_BOT_TOKEN environment variable.');
  }

  // --- Linear ---
  if (mcpClient && mcpClient.hasTool('linear_list_issues')) {
    results.linear = await tryMcpDiscovery('linear', mcpClient);
  } else if (direct.linear) {
    results.linear = await scanLinearDirect(direct.linear);
  } else {
    results.linear = scanResultUnconfigured('linear');
    results.linear.errors.push('No Linear MCP server or LINEAR_API_KEY configured. To enable: (a) connect a Linear MCP server, or (b) set the LINEAR_API_KEY environment variable (a personal API key from https://linear.app/settings/api).');
  }

  // --- Todoist ---
  if (mcpClient && mcpClient.hasTool('todoist_find_tasks')) {
    results.todoist = await tryMcpDiscovery('todoist', mcpClient);
  } else if (direct.todoist) {
    results.todoist = await scanTodoistDirect(direct.todoist);
  } else {
    results.todoist = scanResultUnconfigured('todoist');
    results.todoist.errors.push('No Todoist MCP server or TODOIST_API_TOKEN configured. To enable: (a) connect a Todoist MCP server, or (b) set the TODOIST_API_TOKEN environment variable (get it from Todoist settings → Integrations → API token).');
  }

  // --- Devin ---
  if (direct.devin) {
    results.devin = await scanDevinDirect(direct.devin);
  } else {
    results.devin = scanResultUnconfigured('devin');
    results.devin.errors.push('DEVIN_API_TOKEN not configured. To enable: set the DEVIN_API_TOKEN environment variable (get a token from https://app.devin.ai/settings/api).');
  }

  // --- Claude (always info-only — blocked at bridge layer) ---
  results.claude = scanResultUnconfigured('claude');
  results.claude.errors.push('Claude/Cowork session scanning is blocked at the artifact bridge layer. Use the juggler skill in chat to scan sessions.');

  return results;
}

export function checkMcpCapabilities(mcpClient) {
  if (!mcpClient) return { connected: false, tools: [], supportedSources: [] };
  const tools = mcpClient.toolNames();
  const supportedSources = [];
  if (tools.includes('slack_search') && tools.includes('slack_read_thread')) supportedSources.push('slack');
  if (tools.includes('linear_list_issues')) supportedSources.push('linear');
  if (tools.includes('todoist_find_tasks')) supportedSources.push('todoist');
  return { connected: true, tools, supportedSources };
}