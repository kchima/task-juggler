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

const SLACK_API = 'https://slack.com/api';

/**
 * Find recent threads involving the user and fetch each thread's full body so
 * the classifier has real context. Works with either a bot token (xoxb-) or a
 * user token (xoxp-); search coverage depends on the token's scopes.
 */
export async function scanSlackDirect(botToken) {
  const result = { sourceId: 'slack', status: 'ok', items: [], errors: [], detected: [] };

  if (!botToken) {
    result.status = 'unconfigured';
    result.errors.push('Slack token not configured. Add a Slack token (xoxb- or xoxp-) in the Connections panel.');
    return result;
  }
  const auth = { Authorization: `Bearer ${botToken}` };

  try {
    const authResp = await fetchUrl(`${SLACK_API}/auth.test`, { headers: auth });
    const authData = safeJsonParseBody(authResp);
    if (!authData || !authData.ok) {
      result.status = 'error';
      result.errors.push(`Slack auth failed: ${authData?.error || `HTTP ${authResp.status}`}`);
      return result;
    }

    // Two simple queries (Slack search doesn't reliably support boolean OR):
    // threads directed at the user, and threads the user started. Both use the
    // same dedupe map below.
    const queries = ['is:thread to:me after:yesterday', 'is:thread from:me after:yesterday'];
    const byKey = new Map();

    for (const query of queries) {
      try {
        const searchResp = await postJson(`${SLACK_API}/search.messages`, { query, count: 20, sort: 'timestamp' }, {
          headers: { ...auth, 'Content-Type': 'application/json' },
        });
        const searchData = safeJsonParseBody(searchResp);
        if (searchData && searchData.ok && searchData.messages?.matches) {
          for (const match of searchData.messages.matches) {
            const channelId = match.channel?.id;
            // For a thread reply, thread_ts is the root; otherwise the message ts.
            const threadTs = match.thread_ts || match.ts;
            if (!channelId || !threadTs) continue;
            const key = `slack:${channelId}:${threadTs}`;
            if (byKey.has(key)) continue;
            byKey.set(key, { match, channelId, threadTs });
          }
        } else if (searchData && !searchData.ok && searchData.error) {
          result.errors.push(`Slack search ("${query}"): ${searchData.error}`);
        }
      } catch (err) {
        result.errors.push(`Slack search ("${query}"): ${err.message}`);
      }
    }

    // Fetch the full thread for each candidate (bounded) so classification has
    // real content. One failing thread never blocks the rest.
    const candidates = [...byKey.values()].slice(0, 15);
    for (const { match, channelId, threadTs } of candidates) {
      try {
        const repliesResp = await fetchUrl(
          `${SLACK_API}/conversations.replies?channel=${encodeURIComponent(channelId)}&ts=${encodeURIComponent(threadTs)}&limit=50`,
          { headers: auth },
        );
        const repliesData = safeJsonParseBody(repliesResp);
        if (!repliesData || !repliesData.ok) {
          result.errors.push(`Slack replies (${channelId}): ${repliesData?.error || `HTTP ${repliesResp.status}`}`);
          continue;
        }
        const messages = repliesData.messages || [];
        const text = messages.map((m) => {
          const who = m.user ? `U${m.user}` : (m.bot_id ? `bot:${m.bot_id}` : '?');
          return `[${who}] ${m.text || ''}`;
        }).join('\n').trim();

        result.items.push({
          key: `slack:${channelId}:${threadTs}`,
          label: (match.text || messages[0]?.text || `Thread in #${match.channel?.name || channelId}`).slice(0, 120),
          url: match.permalink || null,
          status: null,
          priority: null,
          raw: { channelId, threadTs, channelName: match.channel?.name || null, text },
          updatedAt: match.ts ? new Date(Number(match.ts) * 1000).toISOString() : null,
        });
        result.detected.push({ key: `slack:${channelId}:${threadTs}`, label: text.slice(0, 80), outcome: 'pending' });
      } catch (err) {
        result.errors.push(`Slack replies (${channelId}): ${err.message}`);
      }
    }
  } catch (err) {
    result.status = 'error';
    result.errors.push(`Slack API: ${err.message}`);
  }

  return result;
}

function safeJsonParseBody(resp) {
  if (!resp || typeof resp.body !== 'string' || !resp.body) return null;
  try { return JSON.parse(resp.body); } catch { return null; }
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