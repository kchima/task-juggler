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

    // DMs + threads modified in the last 24h. Slack's `after:` is date-granular,
    // so use today's date as the floor, plus `in:im` to target direct messages.
    // Pull DMs + threads, then enforce a hard 24h "latest-message" window.
    // Slack's search `after:` is date-granular, so we query a slightly wider
    // date range but filter strictly on each thread's latest message timestamp
    // to guarantee only threads with activity in the last 24h survive.
    const CUTOFF_MS = Date.now() - 24 * 60 * 60 * 1000;
    const twoDaysAgo = new Date(CUTOFF_MS - 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const queries = [
      `is:thread in:im after:${twoDaysAgo}`,
      `is:thread to:me after:${twoDaysAgo}`,
      `is:thread from:me after:${twoDaysAgo}`,
    ];
    const byKey = new Map();

    for (const query of queries) {
      try {
        // search.messages requires FORM-ENCODED params — a JSON body is rejected
        // with invalid_arguments + "missing required field: query".
        const searchResp = await postFormUrl(`${SLACK_API}/search.messages`, { query, count: 30, sort: 'timestamp' }, {
          headers: { ...auth },
        });
        const searchData = safeJsonParseBody(searchResp);
        if (searchData && searchData.ok && searchData.messages?.matches) {
          for (const match of searchData.messages.matches) {
            const channelId = match.channel?.id;
            // For a thread reply, thread_ts is the root; otherwise the message ts.
            const threadTs = match.thread_ts || match.ts;
            if (!channelId || !threadTs) continue;
            // Latest message ts for the thread (Slack ts is epoch seconds).
            const ts = match.thread_ts ? (match.thread_ts) : match.ts;
            const tsSec = Number(ts);
            if (!Number.isFinite(tsSec) || tsSec * 1000 < CUTOFF_MS) continue; // outside 24h
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

// --- Adapter: Devin via v3 REST API ---

/**
 * Scan Devin sessions for in-flight work using the current v3 API.
 *
 * Auth: a service-user API key (`cog_…`) with the ViewOrgSessions permission.
 * The endpoint is org-scoped (`/v3/organizations/{org_id}/sessions`), so the
 * org id is resolved from an env var, or discovered via GET /v3/self.
 *
 * Active signals (Task Juggler "in progress / waiting" relevance):
 *   status: claimed | running            → in flight
 *   status_detail: working               → actively running
 *   status_detail: waiting_for_user      → Devin needs YOU (top of the queue)
 *   status_detail: waiting_for_approval  → Devin needs an approval (you)
 */
export async function scanDevinDirect(apiToken, orgId = null) {
  const result = { sourceId: 'devin', status: 'ok', items: [], errors: [], detected: [] };

  if (!apiToken) {
    result.status = 'unconfigured';
    result.errors.push('Devin API key not configured. Add a Devin API key (cog_…) in the Connections panel.');
    return result;
  }

  const devinHeaders = { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' };

  try {
    // Resolve the org id (path parameter) if not supplied.
    const resolvedOrgId = orgId || await discoverDevinOrgId(apiToken);
    if (!resolvedOrgId) {
      result.status = 'error';
      result.errors.push('Could not determine your Devin organization ID. Set the DEVIN_ORG_ID environment variable.');
      return result;
    }

    const response = await fetchUrl(
      `https://api.devin.ai/v3/organizations/${encodeURIComponent(resolvedOrgId)}/sessions?first=50`,
      { headers: devinHeaders },
    );

    if (response.status === 401 || response.status === 403) {
      result.status = 'error';
      result.errors.push(`Devin auth failed (${response.status}). Use a service-user API key (cog_…) with ViewOrgSessions permission.`);
      return result;
    }
    if (response.status === 404) {
      result.status = 'error';
      result.errors.push('Devin v3 sessions endpoint not found for this org. Check DEVIN_ORG_ID.');
      return result;
    }
    if (response.status !== 200) {
      result.status = 'error';
      result.errors.push(`Devin API returned status ${response.status}`);
      return result;
    }

    const data = JSON.parse(response.body);
    const sessions = (data && data.items) || [];

    for (const s of sessions) {
      const id = s.session_id;
      const status = s.status;
      const detail = s.status_detail;
      // In-flight work: claimed or running; a waiting_* detail means Devin is
      // blocked on you — keep that visible as a stronger signal.
      if (status !== 'claimed' && status !== 'running') continue;
      const waitingOnUser = detail === 'waiting_for_user' || detail === 'waiting_for_approval';
      const label = (s.title || `Devin session ${id.slice(0, 8)}`)
        + `${detail ? ` — ${detail.replace(/_/g, ' ')}` : ''}`;
      const key = `devin:${id}`;
      result.items.push({
        key,
        label,
        url: s.url || `https://app.devin.ai/sessions/${id}`,
        status: waitingOnUser ? 'waiting_for_user' : 'in_progress',
        priority: waitingOnUser ? 'high' : null,
        raw: { sessionId: id, status, statusDetail: detail, title: s.title },
      });
      result.detected.push({ key, label, outcome: waitingOnUser ? 'needs-you' : 'in-flight' });
    }
  } catch (err) {
    result.status = 'error';
    result.errors.push(`Devin API: ${err.message}`);
  }

  return result;
}

/**
 * Resolve the Devin organization id via GET /v3/self (documented in Devin's
 * auth guide as the way to find your org id). Defensive across response shapes.
 */
async function discoverDevinOrgId(apiToken) {
  try {
    const resp = await fetchUrl('https://api.devin.ai/v3/self', {
      headers: { Authorization: `Bearer ${apiToken}`, 'Content-Type': 'application/json' },
    });
    if (resp.status !== 200) return null;
    const body = JSON.parse(resp.body);
    const data = body.data || body;
    // Prefer a direct org_id, then an organizations list (find the default or first).
    const direct = data.org_id || data.organization_id || data.organization?.id || data.organizationId;
    if (direct) return direct;
    const orgs = data.organizations || data.organizations_list || [];
    if (Array.isArray(orgs) && orgs.length > 0) {
      const active = orgs.find((o) => o.is_default) || orgs.find((o) => o.is_active) || orgs[0];
      return active?.id || active?.org_id || null;
    }
    return null;
  } catch {
    return null;
  }
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