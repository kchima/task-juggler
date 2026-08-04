/**
 * Source scanner — attempts to discover tasks from each configured source.
 * Tries MCP first (via a stdio server), falls back to direct API stubs.
 * Each scan is isolated: one source failing never blocks another.
 */

import { emptyScanResult, scanResultWithError, scanResultUnconfigured, getSource } from './registry.js';

// --- MCP client discovery -------------------------------------------------

async function tryMcpDiscovery(sourceId, mcpClient) {
  const source = getSource(sourceId);
  if (!source) return scanResultWithError(sourceId, `Unknown source: ${sourceId}`);

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
  const result = emptyScanResult('slack');

  if (!mcpClient.hasTool('slack_search')) {
    result.status = 'unconfigured';
    result.errors.push('slack_search tool not available from MCP server');
    return result;
  }
  if (!mcpClient.hasTool('slack_read_thread')) {
    result.status = 'unconfigured';
    result.errors.push('slack_read_thread tool not available from MCP server');
    return result;
  }

  try {
    // Search for recent threads mentioning the user
    const searchResult = await mcpClient.callTool('slack_search', {
      query: 'is:thread to:me after:yesterday',
      limit: 20,
    });
    const text = extractTextContent(searchResult);
    if (text) {
      const refs = extractSlackThreadRefs(text);
      for (const ref of refs) {
        const key = `slack:${ref.channelId}:${ref.threadTs}`;
        result.items.push({
          key,
          label: `Thread in #${ref.channelId}`,
          url: `https://${ref.workspaceDomain}/archives/${ref.channelId}/p${ref.threadTs.replace('.', '')}?thread_ts=${ref.threadTs}&cid=${ref.channelId}`,
        });
        result.detected.push({ key, label: `Thread in #${ref.channelId}`, outcome: 'pending' });
      }
    }

    // Also search for threads where the user has spoken
    const fromResult = await mcpClient.callTool('slack_search', {
      query: 'is:thread from:me after:yesterday',
      limit: 20,
    });
    const fromText = extractTextContent(fromResult);
    if (fromText) {
      const refs = extractSlackThreadRefs(fromText);
      for (const ref of refs) {
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
  } catch (err) {
    result.errors.push(`Slack search: ${err.message}`);
  }

  return result;
}

async function scanLinearViaMcp(mcpClient) {
  const result = emptyScanResult('linear');

  if (!mcpClient.hasTool('linear_list_issues')) {
    result.status = 'unconfigured';
    result.errors.push('linear_list_issues tool not available from MCP server');
    return result;
  }

  try {
    const issuesResult = await mcpClient.callTool('linear_list_issues', { assignee: 'me' });
    const raw = extractTextContent(issuesResult);
    let issues;
    try {
      issues = JSON.parse(raw).issues || [];
    } catch {
      issues = [];
    }

    for (const issue of issues) {
      const isOpen = ['backlog', 'unstarted', 'started', 'triage'].includes(issue.statusType);
      if (!isOpen) continue;
      const key = `linear:${issue.id}`;
      result.items.push({
        key,
        label: `[${issue.identifier || issue.id}] ${issue.title}`,
        url: issue.url || null,
      });
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
    result.errors.push('todoist_find_tasks tool not available from MCP server');
    return result;
  }

  try {
    const tasksResult = await mcpClient.callTool('todoist_find_tasks', {
      filter: 'today | overdue | p1',
      limit: 50,
    });
    const raw = extractTextContent(tasksResult);
    let tasks;
    try {
      tasks = JSON.parse(raw).tasks || [];
    } catch {
      tasks = [];
    }

    for (const task of tasks) {
      const key = `todoist:${task.id}`;
      const isUrgent = task.priority === 'p1' || (task.dueDate && new Date(task.dueDate) <= new Date());
      result.items.push({
        key,
        label: task.content,
        url: null,
      });
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
 * Scan all sources. Accepts an MCP client if one is available (may be null).
 * Returns a map of sourceId -> scanResult.
 */
export async function scanAllSources(mcpClient = null) {
  const results = {};

  // Slack — requires MCP
  if (mcpClient) {
    results.slack = await tryMcpDiscovery('slack', mcpClient);
  } else {
    results.slack = scanResultUnconfigured('slack');
    results.slack.errors.push('No MCP server connected — Slack scanning requires an MCP server with slack_search and slack_read_thread tools.');
  }

  // Linear — MCP or direct fallback
  if (mcpClient && mcpClient.hasTool('linear_list_issues')) {
    results.linear = await tryMcpDiscovery('linear', mcpClient);
  } else {
    results.linear = scanResultUnconfigured('linear');
    results.linear.errors.push('No Linear MCP server connected. Configure a Linear MCP server or set up direct API access.');
  }

  // Todoist — MCP or direct fallback
  if (mcpClient && mcpClient.hasTool('todoist_find_tasks')) {
    results.todoist = await tryMcpDiscovery('todoist', mcpClient);
  } else {
    results.todoist = scanResultUnconfigured('todoist');
    results.todoist.errors.push('No Todoist MCP server connected. Configure a Todoist MCP server or set up direct API access.');
  }

  // Devin — direct API only for now
  results.devin = scanResultUnconfigured('devin');
  results.devin.errors.push('Devin.ai scanning requires direct API configuration (not yet implemented).');

  // Claude — always info-only (blocked at bridge layer)
  results.claude = scanResultUnconfigured('claude');
  results.claude.errors.push('Claude/Cowork session scanning is blocked at the artifact bridge layer. Use the juggler skill in chat to scan sessions.');

  return results;
}

/**
 * Check which MCP tools are available and return a compatibility report.
 */
export function checkMcpCapabilities(mcpClient) {
  if (!mcpClient) {
    return { connected: false, tools: [], supportedSources: [] };
  }
  const tools = mcpClient.toolNames();
  const supportedSources = [];
  if (tools.includes('slack_search') && tools.includes('slack_read_thread')) supportedSources.push('slack');
  if (tools.includes('linear_list_issues')) supportedSources.push('linear');
  if (tools.includes('todoist_find_tasks')) supportedSources.push('todoist');
  return { connected: true, tools, supportedSources };
}