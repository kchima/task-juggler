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
import { getCredential } from '../auth/credentialStore.js';
import { scanLocalSessions } from './localSessions.js';
import { openCodeItems } from './openCodeSessions.js';

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
  const hasListIssues = mcpClient.hasTool('list_issues') || mcpClient.hasTool('linear_list_issues');
  const toolName = mcpClient.hasTool('list_issues') ? 'list_issues' : 'linear_list_issues';
  if (!hasListIssues) {
    result.status = 'unconfigured';
    result.errors.push('list_issues tool not available');
    return result;
  }
  try {
    const issuesResult = await mcpClient.callTool(toolName, { assignee: 'me' });
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
  // Resolve the task-list tool dynamically — the hosted Todoist MCP tool name
  // varies; don't assume a hardcoded `todoist_find_tasks`.
  const tool = pickTodoistTool(mcpClient.toolNames());
  if (!tool) {
    result.status = 'unconfigured';
    result.errors.push('No Todoist task-discovery tool available (looked for a find/search/list-tasks tool).');
    return result;
  }
  try {
    const tasksResult = await mcpClient.callTool(tool, { filter: 'today | overdue | p1', limit: 50 });
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

/**
 * Pick a Todoist task-discovery tool from the available MCP tool names.
 * Prefers a "find / search / list / get tasks" tool; falls back to the legacy
 * hardcoded name for backwards compatibility.
 */
function pickTodoistTool(names) {
  const list = names || [];
  const rank = (n) => {
    const s = n.toLowerCase();
    let score = 0;
    if (/task/.test(s)) score += 2;
    if (/find|search/.test(s)) score += 4;
    else if (/list/.test(s)) score += 3;
    else if (/get/.test(s)) score += 1;
    return score;
  };
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => rank(b) - rank(a));
  return rank(sorted[0]) > 0 ? sorted[0] : (list.includes('todoist_find_tasks') ? 'todoist_find_tasks' : null);
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

  // --- Slack: MCP → direct token → MCP OAuth scan → unconfigured
  if (mcpClient && mcpClient.hasTool('slack_search')) {
    results.slack = await tryMcpDiscovery('slack', mcpClient);
  } else if (direct.slack) {
    results.slack = await scanSlackDirect(direct.slack);
  } else {
    // Try MCP OAuth scanning first (uses MCP tools via OAuth token)
    const mcpOAuthResult = await tryMcpOAuthScan('slack');
    if (mcpOAuthResult) {
      results.slack = mcpOAuthResult;
    } else if (hasAnyGrant('slack')) {
      // Prefer the direct user-token grant (slack-oauth-grant) for scanning —
      // it reads what the user can see, including private channels and DMs.
      let slackToken = null;
      try { slackToken = await resolveOAuthToken('slack'); } catch { slackToken = null; }
      if (slackToken) {
        results.slack = await scanSlackDirect(slackToken);
      } else {
        results.slack = scanResultWithError('slack', 'Slack is connected, but the last scan failed. The access token may be expired — reconnect from the Connections panel.');
      }
    } else {
      results.slack = scanResultUnconfigured('slack');
    }
  }

  // --- Linear: MCP → direct token → MCP OAuth scan → unconfigured
  if (mcpClient && (mcpClient.hasTool('list_issues') || mcpClient.hasTool('linear_list_issues'))) {
    results.linear = await tryMcpDiscovery('linear', mcpClient);
  } else if (direct.linear) {
    results.linear = await scanLinearDirect(direct.linear);
  } else {
    // Try MCP OAuth scanning via the MCP endpoint
    const mcpOAuthResult = await tryMcpOAuthScan('linear');
    if (mcpOAuthResult) {
      results.linear = mcpOAuthResult;
    } else if (hasAnyGrant('linear')) {
      // A connection exists (OAuth grant) but scanning failed — surface as an
      // error rather than misleading "not configured".
      results.linear = scanResultWithError('linear', 'Linear is connected, but the last scan failed. The access token may be expired — reconnect from the Connections panel.');
    } else {
      results.linear = scanResultUnconfigured('linear');
    }
  }

  // --- Todoist: MCP → direct token → MCP OAuth scan → legacy OAuth → unconfigured
  if (mcpClient && mcpClient.hasTool('todoist_find_tasks')) {
    results.todoist = await tryMcpDiscovery('todoist', mcpClient);
  } else if (direct.todoist) {
    results.todoist = await scanTodoistDirect(direct.todoist);
  } else {
    // Try MCP OAuth scanning first
    const mcpOAuthResult = await tryMcpOAuthScan('todoist');
    if (mcpOAuthResult) {
      results.todoist = mcpOAuthResult;
    } else {
      // Fall back to legacy direct OAuth
      let todoistToken = null;
      try { todoistToken = await resolveOAuthToken('todoist'); } catch { todoistToken = null; }
      if (todoistToken) {
        results.todoist = await scanTodoistDirect(todoistToken);
      } else if (hasAnyGrant('todoist')) {
        results.todoist = scanResultWithError('todoist', 'Todoist is connected, but the last scan failed. The access token may be expired — reconnect from the Connections panel.');
      } else {
        results.todoist = scanResultUnconfigured('todoist');
        // Diagnostic: if a grant was stored but is missing at scan time, this
        // line is the tell — the connection vanished between connect and scan.
        console.log('[Scanner] todoist grant present at scan:', !!(
          getCredential('todoist-mcp-grant') || getCredential('todoist-oauth-grant')
        ));
      }
    }
  }

  // --- Devin ---
  if (direct.devin) {
    results.devin = await scanDevinDirect(direct.devin, process.env.DEVIN_ORG_ID || null);
  } else {
    results.devin = scanResultUnconfigured('devin');
  }

  // --- Claude (local session discovery — read-only metadata) ---
  try {
    const { sessions, stats } = scanLocalSessions();
    const result = emptyScanResult('claude');
    result.status = sessions.length > 0 ? 'ok' : 'ok';
    result.items = sessions.slice(0, 50).map((s) => ({
      key: `claude:${s.id}`,
      label: `${s.title}${s.cwd ? ` (${pathShortName(s.cwd)})` : ''}${s.status === 'in_progress' ? ' ●' : ''}`,
      url: null,
      status: s.status,
    }));
    result.detected = result.items.map((i) => ({ key: i.key, label: i.label, outcome: 'discovered' }));
    if (stats.total > 0) {
      result.errors = []; // Clear any previous errors
    }
    results.claude = result;
  } catch (err) {
    const result = scanResultWithError('claude', `Local discovery failed: ${err.message}`);
    results.claude = result;
  }

  // --- OpenCode (local session/todo discovery — read-only metadata) ---
  try {
    const oc = openCodeItems();
    const result = emptyScanResult('opencode');
    if (oc.error) {
      result.status = 'unconfigured';
      result.errors.push(`OpenCode: ${oc.error}`);
    } else {
      result.status = oc.items.length > 0 ? 'ok' : 'ok';
      result.items = oc.items.slice(0, 50);
      result.detected = oc.sessions.map((s) => ({ key: s.key, label: s.title, outcome: 'discovered' }));
    }
    results.opencode = result;
  } catch (err) {
    const result = scanResultWithError('opencode', `OpenCode discovery failed: ${err.message}`);
    results.opencode = result;
  }

  return results;
}

export function checkMcpCapabilities(mcpClient) {
  if (!mcpClient) return { connected: false, tools: [], supportedSources: [] };
  const tools = mcpClient.toolNames();
  const supportedSources = [];
  if (tools.includes('slack_search') && tools.includes('slack_read_thread')) supportedSources.push('slack');
  if (tools.includes('list_issues') || tools.includes('linear_list_issues')) supportedSources.push('linear');
  if (tools.includes('todoist_find_tasks')) supportedSources.push('todoist');
  return { connected: true, tools, supportedSources };
}

// --- OAuth token resolution ------------------------------------------------

/**
 * True if the provider has any stored grant (MCP OAuth or legacy OAuth) in
 * Keychain — used to distinguish "connected but scan failed" from "not set up".
 */
function hasAnyGrant(sourceId) {
  try {
    if (getCredential(`${sourceId}-mcp-grant`)) return true;
    if (getCredential(`${sourceId}-oauth-grant`)) return true;
  } catch {}
  return false;
}

/**
 * Resolve an OAuth access token for a provider from Keychain.
 * Handles automatic refresh when the token is expired.
 */
async function resolveOAuthToken(providerId) {
  const grantService = `${providerId}-oauth-grant`;
  const oauthGrant = getCredential(grantService);
  if (!oauthGrant || !oauthGrant.accessToken) return null;

  // Check if expired
  if (oauthGrant.expiresIn) {
    const expiresAt = oauthGrant.obtainedAt + (oauthGrant.expiresIn * 1000);
    if (Date.now() >= expiresAt) {
      if (!oauthGrant.refreshToken) return null; // Expired and no refresh — re-authorize needed
      // Try refresh
      try {
        const { refreshAccessToken } = await import('../auth/oauthManager.js');
        const refreshed = await refreshAccessToken(providerId);
        if (refreshed && refreshed.accessToken) {
          return refreshed.accessToken;
        }
      } catch {
        // Refresh failed
      }
      return null;
    }
  }

  return oauthGrant.accessToken;
}

// --- Helpers ----------------------------------------------------------------

function pathShortName(p) {
  if (!p) return '';
  const parts = p.replace(/\/$/, '').split('/');
  if (parts.length >= 2) return parts.slice(-2).join('/');
  return parts.pop() || p;
}

/**
 * Try to scan a provider using its MCP OAuth token directly.
 * Fetches the MCP tools list, and if the required tools are available,
 * creates a lightweight MCP client and runs the MCP-based scan.
 *
 * Keeps the connection alive: if the stored access token is expired (or near
 * expiry), it is refreshed first via the rotating refresh token, so the user
 * doesn't have to re-authorize. Only when refresh fails (or no refresh token
 * exists) does it fall through to "reconnect required".
 */
async function tryMcpOAuthScan(sourceId) {
  try {
    const grant = getCredential(`${sourceId}-mcp-grant`);
    if (!grant || !grant.accessToken || !grant.mcpUrl) {
      console.log(`[Scanner] No MCP OAuth grant for ${sourceId}`);
      return null;
    }

    let accessToken = grant.accessToken;
    if (isMcpGrantExpired(grant)) {
      console.log(`[Scanner] MCP OAuth grant for ${sourceId} is expired — refreshing`);
      if (!grant.refreshToken) {
        console.log(`[Scanner] No refresh token for ${sourceId} — re-authorization required`);
        return null;
      }
      const { refreshMcpToken } = await import('./mcpOAuthClient.js');
      const fresh = await refreshMcpToken(sourceId);
      if (!fresh || !fresh.accessToken) {
        console.log(`[Scanner] Refresh failed for ${sourceId} — re-authorization required`);
        return null;
      }
      accessToken = fresh.accessToken;
    }

    console.log(`[Scanner] Trying MCP OAuth scan for ${sourceId} at ${grant.mcpUrl}`);

    // Call the MCP tools/list endpoint to check capabilities
    const { callMcpToolsList } = await import('./mcpOAuthClient.js');
    const tools = await callMcpToolsList(grant.mcpUrl, accessToken);
    console.log(`[Scanner] MCP tools/list returned ${tools.length} tools for ${sourceId}`);

    // Build a minimal MCP client from the tools
    const toolNames = tools.map((t) => t.name);

    // Build a simple MCP client-wrapper
    const { callMcpTool } = await import('./mcpOAuthClient.js');
    const mcpClient = {
      hasTool: (name) => toolNames.includes(name),
      toolNames: () => toolNames,
      callTool: async (name, args) => {
        return callMcpTool(grant.mcpUrl, accessToken, name, args);
      },
    };

    return await tryMcpDiscovery(sourceId, mcpClient);
  } catch (err) {
    console.log(`[Scanner] MCP OAuth scan failed for ${sourceId}: ${err.message}`);
    return null; // Fall through to unconfigured
  }
}

/**
 * True when an MCP OAuth access token is expired (or within `bufferMs` of
 * expiring, to avoid racing expiry mid-scan). Exported for tests.
 */
export function isMcpGrantExpired(grant, now = new Date(), bufferMs = 60_000) {
  if (!grant || !grant.expiresIn) return false;
  const expiresAt = grant.obtainedAt + grant.expiresIn * 1000;
  return now.getTime() >= expiresAt - bufferMs;
}

/**
 * Resolve an MCP OAuth token from Keychain.
 * The MCP OAuth grant stores the access token under `<providerId>-mcp-grant`.
 */
function resolveMcpToken(providerId) {
  try {
    const grant = getCredential(`${providerId}-mcp-grant`);
    if (grant && grant.accessToken) return grant.accessToken;
  } catch {}
  return null;
}