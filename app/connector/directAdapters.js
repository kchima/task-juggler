/**
 * Direct API adapters for sources that don't have MCP servers available.
 * Each adapter reads its API credentials from environment variables.
 * Returns the same scan result shape as the MCP-based scanners.
 */

import https from 'https';
import http from 'http';

// --- HTTP helper ---

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: options.headers || {}, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => { req.destroy(new Error('Request timed out')); });
  });
}

function postJson(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const req = proto.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data), ...options.headers },
      ...options,
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

function postFormUrl(url, params, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const data = new URLSearchParams(params).toString();
    const urlObj = new URL(url);
    const req = proto.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(data),
        ...options.headers,
      },
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(options.timeout || 15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

// --- Adapter: Linear via GraphQL API ---

export async function scanLinearDirect(apiKey) {
  const result = { sourceId: 'linear', status: 'ok', items: [], errors: [], detected: [] };

  if (!apiKey) {
    result.status = 'unconfigured';
    result.errors.push('LINEAR_API_KEY not configured. Set the LINEAR_API_KEY environment variable.');
    return result;
  }

  try {
    const response = await postJson('https://api.linear.app/graphql', {
      query: `{
        viewer {
          assignedIssues(filter: { state: { type: { in: ["backlog", "unstarted", "started", "triage"] } } }, first: 50) {
            nodes {
              id
              identifier
              title
              url
              state { name type }
              priority
              dueDate
            }
          }
        }
      }`,
    }, {
      headers: {
        'Authorization': apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
    });

    if (response.status !== 200) {
      result.status = 'error';
      result.errors.push(`Linear API returned status ${response.status}`);
      return result;
    }

    const data = JSON.parse(response.body);
    const issues = data?.data?.viewer?.assignedIssues?.nodes || [];

    for (const issue of issues) {
      const key = `linear:${issue.id}`;
      result.items.push({
        key,
        label: `[${issue.identifier}] ${issue.title}`,
        url: issue.url || null,
      });
      result.detected.push({ key, label: issue.title, outcome: 'added' });
    }
  } catch (err) {
    result.status = 'error';
    result.errors.push(`Linear API: ${err.message}`);
  }

  return result;
}

// --- Adapter: Todoist via Sync API (v1 — REST v2 is deprecated/410) ---

export async function scanTodoistDirect(apiToken) {
  const result = { sourceId: 'todoist', status: 'ok', items: [], errors: [], detected: [] };

  if (!apiToken) {
    result.status = 'unconfigured';
    result.errors.push('TODOIST_API_TOKEN not configured. Set the TODOIST_API_TOKEN environment variable.');
    return result;
  }

  try {
    // Use the Sync API (POST form-encoded) — REST v2 returns 410 Gone
    const response = await postFormUrl('https://api.todoist.com/api/v1/sync', {
      sync_token: '*',
      resource_types: JSON.stringify(['items', 'projects', 'labels']),
    }, {
      headers: { 'Authorization': `Bearer ${apiToken}` },
    });

    if (response.status !== 200) {
      result.status = 'error';
      result.errors.push(`Todoist Sync API returned status ${response.status}`);
      if (response.body) {
        try {
          const err = JSON.parse(response.body);
          if (err.error) result.errors.push(err.error);
        } catch {}
      }
      return result;
    }

    const data = JSON.parse(response.body);
    const items = data.items || [];
    const projects = data.projects || [];

    // Build a project name lookup
    const projectNames = {};
    for (const p of projects) {
      projectNames[p.id] = p.name;
    }

    for (const item of items) {
      // Skip completed items
      if (item.checked === 1) continue;

      const key = `todoist:${item.id}`;
      const projectName = projectNames[item.project_id] || '';
      const label = item.content + (projectName ? ` (${projectName})` : '');
      const isUrgent = item.priority === 1 || item.priority === 2;

      result.items.push({ key, label, url: null });
      result.detected.push({ key, label: item.content, outcome: isUrgent ? 'added' : 'skipped-gate' });
    }
  } catch (err) {
    result.status = 'error';
    result.errors.push(`Todoist Sync API: ${err.message}`);
  }

  return result;
}

// --- Adapter: Slack via Web API ---

export async function scanSlackDirect(botToken) {
  const result = { sourceId: 'slack', status: 'ok', items: [], errors: [], detected: [] };

  if (!botToken) {
    result.status = 'unconfigured';
    result.errors.push('SLACK_BOT_TOKEN not configured. Set the SLACK_BOT_TOKEN environment variable.');
    return result;
  }

  try {
    // Use conversations.list and search.messages to find thread mentions
    const authResp = await fetchUrl('https://slack.com/api/auth.test', {
      headers: { 'Authorization': `Bearer ${botToken}` },
    });
    const authData = JSON.parse(authResp.body);
    if (!authData.ok) {
      result.status = 'error';
      result.errors.push(`Slack auth failed: ${authData.error}`);
      return result;
    }

    // Search for recent thread activity
    const searchResp = await postJson('https://slack.com/api/search.messages', {
      query: 'is:thread after:yesterday',
      count: 20,
      sort: 'timestamp',
    }, {
      headers: { 'Authorization': `Bearer ${botToken}`, 'Content-Type': 'application/json' },
    });

    if (searchResp.status === 200) {
      const searchData = JSON.parse(searchResp.body);
      if (searchData.ok && searchData.messages?.matches) {
        for (const match of searchData.messages.matches) {
          if (match.permalink) {
            const key = `slack:${match.channel?.id || '?'}:${match.ts}`;
            result.items.push({
              key,
              label: match.text ? match.text.slice(0, 100) : `Thread in #${match.channel?.name || '?'}`,
              url: match.permalink,
            });
            result.detected.push({ key, label: match.text?.slice(0, 80) || 'Thread', outcome: 'pending' });
          }
        }
      }
    }
  } catch (err) {
    result.status = 'error';
    result.errors.push(`Slack API: ${err.message}`);
  }

  return result;
}

// --- Adapter: Devin via Public REST API ---

export async function scanDevinDirect(apiToken) {
  const result = { sourceId: 'devin', status: 'ok', items: [], errors: [], detected: [] };

  if (!apiToken) {
    result.status = 'unconfigured';
    result.errors.push('DEVIN_API_TOKEN not configured. Set the DEVIN_API_TOKEN environment variable.\nSign up at https://app.devin.ai/settings/api to get a token.');
    return result;
  }

  try {
    const response = await fetchUrl('https://api.devin.ai/v1/sessions?status=in_progress,running', {
      headers: { 'Authorization': `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    });

    if (response.status === 404) {
      // Devin API may be at a different endpoint
      result.status = 'unconfigured';
      result.errors.push('Devin API endpoint not found at expected URL. The API may have changed or requires a different base URL.');
      return result;
    }

    if (response.status !== 200) {
      result.status = 'error';
      result.errors.push(`Devin API returned status ${response.status}`);
      return result;
    }

    const data = JSON.parse(response.body);
    const sessions = data.sessions || data.data || [];

    for (const session of sessions) {
      const key = `devin:${session.id || session.session_id}`;
      result.items.push({
        key,
        label: session.name || session.description || `Session ${session.id?.slice(0, 8)}`,
        url: session.url || `https://app.devin.ai/sessions/${session.id}`,
      });
      result.detected.push({ key, label: session.name || 'Devin session', outcome: 'added' });
    }
  } catch (err) {
    result.status = 'error';
    result.errors.push(`Devin API: ${err.message}`);
  }

  return result;
}

// --- Source config lookup --------------------------------------------------

/**
 * Read API credentials from environment and config.
 * Server passes these in from process.env or from the stored config.
 */
export function getDirectAdaptersConfig(env = process.env) {
  return {
    linear: env.LINEAR_API_KEY || null,
    todoist: env.TODOIST_API_TOKEN || null,
    slack: env.SLACK_BOT_TOKEN || null,
    devin: env.DEVIN_API_TOKEN || null,
  };
}