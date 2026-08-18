/**
 * MCP OAuth Client — connects to HTTP MCP servers that support OAuth.
 *
 * Flow:
 *   1. Connect to MCP endpoint → receive 401 with www-authenticate header
 *   2. Fetch .well-known/oauth-protected-resource → find authorization server
 *   3. Fetch .well-known/oauth-authorization-server → get endpoints
 *   4. Register dynamic client (if supported) or use PKCE public client
 *   5. Open browser for user authorization
 *   6. Exchange code for tokens via callback
 *   7. Reconnect with Bearer token → call MCP tools
 */

import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { storeCredential, getCredential, deleteCredential } from '../auth/credentialStore.js';

// ─── Constants ────────────────────────────────────────────────────────────

const MCP_JSONRPC_VERSION = '2.0';
const MCP_PROTOCOL_VERSION = '2025-03-26';

// ─── HTTP helpers ─────────────────────────────────────────────────────────

function jsonRpcRequest(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const proto = url.startsWith('https') ? https : http;
    const req = proto.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/event-stream',
        'Content-Length': Buffer.byteLength(data),
        ...options.headers,
      },
    }, (res) => {
      const contentType = res.headers['content-type'] || '';
      let responseData = '';

      if (contentType.includes('text/event-stream')) {
        // Streamable HTTP / SSE response — read until we get a complete event
        res.on('data', (chunk) => {
          responseData += chunk.toString();
          // Look for a complete SSE event: event: message\ndata: {...}\n\n
          const eventMatch = responseData.match(/event: message\s*\ndata: ({.*?})\n\n/s);
          if (eventMatch) {
            try {
              const parsed = JSON.parse(eventMatch[1]);
              req.destroy(); // Close the connection early, we got what we need
              resolve({
                status: res.statusCode,
                headers: res.headers,
                body: JSON.stringify(parsed),
              });
            } catch {
              // Parse failed, keep reading
            }
          }
        });
        // Also handle case where the stream ends without SSE format (fallback)
        res.on('end', () => {
          if (responseData) {
            resolve({
              status: res.statusCode,
              headers: res.headers,
              body: responseData,
            });
          }
        });
      } else {
        // Standard JSON response
        res.on('data', (chunk) => { responseData += chunk; });
        res.on('end', () => {
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: responseData,
          });
        });
      }
    });
    req.on('error', (err) => {
      if (!resolved) {
        resolved = true;
        reject(err);
      }
    });
    req.setTimeout(options.timeout || 15000, () => {
      if (!resolved) {
        resolved = true;
        req.destroy(new Error('Request timed out'));
        reject(new Error('Request timed out'));
      }
    });
    req.write(data);
    req.end();
  });
}

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: { 'Accept': 'application/json', ...options.headers }, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(new Error('Request timed out')); });
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
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

function postJson(url, body, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const req = proto.request({
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        ...options.headers,
      },
    }, (res) => {
      let responseData = '';
      res.on('data', (chunk) => { responseData += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

// ─── PKCE helpers ─────────────────────────────────────────────────────────

function base64URLEncode(buffer) {
  return buffer.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function generateCodeVerifier() {
  return base64URLEncode(crypto.randomBytes(32));
}

function generateCodeChallenge(verifier) {
  return base64URLEncode(crypto.createHash('sha256').update(verifier).digest());
}

function generateState() {
  return base64URLEncode(crypto.randomBytes(16));
}

// ─── In-memory pending auth state ─────────────────────────────────────────

const _pendingAuths = new Map();
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

// Persist pending auth to the credential store so it survives server restarts.
// The callback may arrive after the server restarts (isolated external browser).
function persistPendingAuth(providerId, state, pending) {
  try {
    storeCredential(`mcp-pending-${providerId}-${state}`, {
      ...pending,
      createdAt: Date.now(),
    });
  } catch {
    // Non-critical
  }
}

function getPendingAuth(providerId, state) {
  // Check in-memory first
  const inMem = _pendingAuths.get(`${providerId}:${state}`);
  if (inMem) {
    _pendingAuths.delete(`${providerId}:${state}`);
    return inMem;
  }
  // Fall back to persisted state (e.g. after server restart)
  try {
    const persisted = getCredential(`mcp-pending-${providerId}-${state}`);
    if (persisted) {
      // Clean up stale persisted state
      deleteCredential(`mcp-pending-${providerId}-${state}`);
      return persisted;
    }
  } catch {}
  return null;
}

function clearPendingAuth(providerId, state) {
  _pendingAuths.delete(`${providerId}:${state}`);
  try { deleteCredential(`mcp-pending-${providerId}-${state}`); } catch {}
}

// ─── MCP OAuth discovery ─────────────────────────────────────────────────

/**
 * Discover OAuth metadata from an MCP endpoint.
 * Sends an initialize request and reads the www-authenticate header.
 */
export async function discoverMcpOAuth(mcpUrl) {
  const initRequest = {
    jsonrpc: MCP_JSONRPC_VERSION,
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'TaskJuggler', version: '1.0.0' },
    },
  };

  const response = await jsonRpcRequest(mcpUrl, initRequest);

  // Extract www-authenticate header
  const authHeader = response.headers['www-authenticate'] || response.headers['www-authenticate'] || '';
  if (!authHeader) {
    // Server may not require auth
    if (response.status === 200) {
      return { requiresAuth: false, serverInfo: JSON.parse(response.body) };
    }
    throw new Error(`MCP endpoint returned ${response.status} without auth metadata`);
  }

  // Parse resource_metadata URL from www-authenticate header
  const resourceMetaMatch = authHeader.match(/resource_metadata="([^"]+)"/);
  if (!resourceMetaMatch) {
    throw new Error(`No resource_metadata in www-authenticate header: ${authHeader.slice(0, 200)}`);
  }

  const resourceMetaUrl = resourceMetaMatch[1];

  // Fetch resource metadata
  const resourceMeta = await fetchUrl(resourceMetaUrl);
  if (resourceMeta.status !== 200) {
    throw new Error(`Failed to fetch resource metadata: ${resourceMeta.status}`);
  }

  const resourceData = JSON.parse(resourceMeta.body);
  const authServers = resourceData.authorization_servers;
  if (!authServers || authServers.length === 0) {
    throw new Error('No authorization servers found in resource metadata');
  }

  // Fetch authorization server metadata from each server
  const authServerMetas = [];
  for (const server of authServers) {
    const metaUrl = `${server.replace(/\/$/, '')}/.well-known/oauth-authorization-server`;
    const metaResp = await fetchUrl(metaUrl);
    if (metaResp.status === 200) {
      authServerMetas.push(JSON.parse(metaResp.body));
    }
  }

  if (authServerMetas.length === 0) {
    throw new Error('Could not fetch authorization server metadata');
  }

  return {
    requiresAuth: true,
    authServer: authServerMetas[0],
    resourceData,
    mcpUrl,
  };
}

// ─── Dynamic Client Registration (for MCP servers that support it) ────────

/**
 * Register a dynamic OAuth client with the MCP authorization server.
 * Falls back to using a client ID metadata document approach if available.
 */
async function registerMcpClient(authMeta, providerId, callbackUrl) {
  const { authServer, mcpUrl, resourceData } = authMeta;

  // Check for existing client credential (DCR-registered or manually configured)
  const existing = getCredential(`${providerId}-mcp-client`);
  if (existing && existing.client_id) {
    console.log(`[MCP OAuth] Using existing client credential for ${providerId}: client_id=${existing.client_id}`);
    return existing;
  }

  // If the provider needs app registration (e.g. Slack), the user must configure it first.
  // Check for manually configured client credentials stored under ${providerId}-client (legacy setup route)
  const manualClient = getCredential(`${providerId}-client`);
  if (manualClient && manualClient.client_id) {
    console.log(`[MCP OAuth] Using manually configured client for ${providerId}: client_id=${manualClient.client_id}`);
    // Migrate to mcp-client namespace for consistent lookup
    const clientData = {
      client_id: manualClient.client_id,
      client_secret: manualClient.client_secret || null,
      tokenEndpointAuthMethod: 'client_secret_post',
      dynamicClient: false,
    };
    storeCredential(`${providerId}-mcp-client`, clientData);
    return clientData;
  }

  // Try DCR first
  if (authServer.registration_endpoint) {
    try {
      // Pick the best token endpoint auth method supported by the server.
      // Prefer client_secret_post over none (PKCE) to avoid issues with
      // providers whose login redirects strip code_challenge (e.g. Todoist).
      const supportedMethods = authServer.token_endpoint_auth_methods_supported || [];
      let tokenMethod = 'none';
      if (supportedMethods.includes('client_secret_post')) {
        tokenMethod = 'client_secret_post';
      } else if (supportedMethods.includes('client_secret_basic')) {
        tokenMethod = 'client_secret_basic';
      }

      const body = {
        client_name: 'Task Juggler',
        redirect_uris: [callbackUrl],
        scope: (authServer.scopes_supported || []).join(' ') || undefined,
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
        token_endpoint_auth_method: tokenMethod,
      };

      console.log(`[MCP OAuth] Attempting DCR for ${providerId} at ${authServer.registration_endpoint} with auth_method=${tokenMethod}, redirect_uris: [${callbackUrl}]`);

      const resp = await postJson(authServer.registration_endpoint, body);
      if (resp.status === 201 || resp.status === 200) {
        const clientData = JSON.parse(resp.body);
        console.log(`[MCP OAuth] DCR succeeded for ${providerId}: client_id=${clientData.client_id}, auth_method=${clientData.token_endpoint_auth_method || tokenMethod}`);
        storeCredential(`${providerId}-mcp-client`, clientData);
        return clientData;
      }

      console.error(`[MCP OAuth] DCR failed for ${providerId}: HTTP ${resp.status}`, resp.body.slice(0, 500));
    } catch (err) {
      console.error(`[MCP OAuth] DCR threw for ${providerId}:`, err.message);
    }
  } else {
    console.log(`[MCP OAuth] No DCR endpoint for ${providerId}, checking metadata for client_id...`);
  }

  // Check if the auth server or resource metadata advertises a client_id
  if (authServer.client_id) {
    console.log(`[MCP OAuth] Using auth server client_id for ${providerId}: ${authServer.client_id}`);
    const clientData = {
      client_id: authServer.client_id,
      client_secret: null,
      tokenEndpointAuthMethod: 'none',
      dynamicClient: false,
    };
    storeCredential(`${providerId}-mcp-client`, clientData);
    return clientData;
  }

  if (resourceData && resourceData.client_id) {
    console.log(`[MCP OAuth] Using resource metadata client_id for ${providerId}: ${resourceData.client_id}`);
    const clientData = {
      client_id: resourceData.client_id,
      client_secret: null,
      tokenEndpointAuthMethod: 'none',
      dynamicClient: false,
    };
    storeCredential(`${providerId}-mcp-client`, clientData);
    return clientData;
  }

  // No DCR, no advertised client_id — throw a clear error
  throw new Error(
    `${providerId} does not support dynamic client registration and no client_id was found in metadata. ` +
    `This provider requires a pre-registered app. ` +
    `Configure your app credentials in Settings → Connections.`
  );
}

// ─── Authorization flow ───────────────────────────────────────────────────

/**
 * Start MCP OAuth authorization flow for a provider.
 * Returns { authUrl, state, providerId } for the frontend to open.
 */
export async function startMcpAuthorization(providerId, mcpUrl, origin) {
  // Discover OAuth metadata
  const authMeta = await discoverMcpOAuth(mcpUrl);
  if (!authMeta.requiresAuth) {
    throw new Error(`${providerId} MCP does not require authentication`);
  }

  const { authServer } = authMeta;

  // Build callback URL before registering (registerMcpClient needs it for DCR)
  const callbackPath = `/api/auth/mcp-callback/${providerId}`;
  const callbackUrl = `${origin}${callbackPath}`;

  // Register or obtain client
  let clientData;
  try {
    clientData = await registerMcpClient(authMeta, providerId, callbackUrl);
  } catch (err) {
    throw new Error(`Failed to register MCP client: ${err.message}`);
  }

  // PKCE
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Store pending auth (both in-memory and persisted for restart safety)
  const pending = {
    providerId,
    state,
    codeVerifier,
    clientId: clientData.client_id,
    callbackUrl,
    mcpUrl,
    authServer,
    createdAt: Date.now(),
  };
  _pendingAuths.set(`${providerId}:${state}`, pending);
  persistPendingAuth(providerId, state, pending);

  // Build authorization URL
  const authEndpoint = authServer.authorization_endpoint;
  if (!authEndpoint) {
    throw new Error('Authorization server has no authorization_endpoint');
  }

  const params = new URLSearchParams({
    client_id: clientData.client_id,
    redirect_uri: callbackUrl,
    response_type: 'code',
    state,
  });

  // Only include PKCE params for public clients (no client_secret).
  // For confidential clients (registered with client_secret_post/basic),
  // PKCE is optional and some providers (Todoist) strip code_challenge
  // during their login redirect, causing errors.
  const isPublicClient = !clientData.client_secret;
  if (isPublicClient) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  // Add the resource parameter when the auth server supports it (RFC 8707).
  // This is required by the MCP OAuth spec and some servers (Todoist, Linear)
  // expect it in the authorization request.
  const resourceIndicator = authMeta.resourceData?.resource || mcpUrl;
  if (authServer.resource_parameter_supported !== false && resourceIndicator) {
    params.set('resource', resourceIndicator);
  }

  // Add scope if available — request minimal scopes only
  if (authServer.scopes_supported && authServer.scopes_supported.length > 0) {
    // Prefer exact "read" or "data:read" scopes over broader matches.
    // Some servers include scopes like "backups:read" or "billing:read"
    // that we should never request — they're sensitive and unrelated.
    const scopes = authServer.scopes_supported;
    const exactRead = scopes.find((s) => s.toLowerCase() === 'read');
    const exactDataRead = scopes.find((s) => s.toLowerCase() === 'data:read');
    const minimalScope = exactDataRead || exactRead || scopes[0];
    params.set('scope', minimalScope);
  }

  const authUrl = `${authEndpoint}?${params.toString()}`;

  return { authUrl, state, providerId };
}

// ─── Callback handling ────────────────────────────────────────────────────

/**
 * Handle MCP OAuth callback.
 * Exchanges code for token, stores in Keychain, returns connection info.
 */
export async function handleMcpCallback(providerId, queryParams) {
  const { code, state } = queryParams;
  if (!code) throw new Error('Authorization code missing');
  if (!state) throw new Error('State parameter missing');

  const pending = getPendingAuth(providerId, state);
  if (!pending) throw new Error('Invalid or expired authorization state');

  clearPendingAuth(providerId, state);

  const { authServer, codeVerifier, clientId, callbackUrl, mcpUrl } = pending;
  const tokenEndpoint = authServer.token_endpoint;
  if (!tokenEndpoint) throw new Error('Authorization server has no token_endpoint');

  // Exchange code for token
  const exchangeParams = {
    client_id: clientId,
    code,
    redirect_uri: callbackUrl,
    grant_type: 'authorization_code',
    code_verifier: codeVerifier,
  };

  // Include the resource parameter (RFC 8707) in the token exchange.
  // When the auth URL included resource=https://mcp.example.com/mcp,
  // the token endpoint must receive it too to issue a token for that resource.
  if (mcpUrl) {
    exchangeParams.resource = mcpUrl;
  }

  // Add client_secret if the provider uses confidential client auth
  let exchangeHeaders = {};
  const clientData = getCredential(`${providerId}-mcp-client`);
  const supportedMethods = authServer.token_endpoint_auth_methods_supported || [];
  const supportsSecretPost = supportedMethods.includes('client_secret_post');
  const supportsSecretBasic = supportedMethods.includes('client_secret_basic');

  if ((supportsSecretPost || supportsSecretBasic) && clientData && clientData.client_secret) {
    if (supportsSecretBasic) {
      // Use HTTP Basic Auth for client_secret_basic
      const credentials = Buffer.from(`${clientId}:${clientData.client_secret}`).toString('base64');
      exchangeHeaders = { Authorization: `Basic ${credentials}` };
      console.log(`[MCP OAuth] Using Basic auth for ${providerId} token exchange`);
    } else {
      // Use form-encoded client_secret for client_secret_post
      exchangeParams.client_secret = clientData.client_secret;
      console.log(`[MCP OAuth] Adding client_secret to token exchange for ${providerId}`);
    }
  }

  const response = await postFormUrl(tokenEndpoint, exchangeParams, exchangeHeaders);

  if (response.status !== 200) {
    let errMsg = `Token exchange returned ${response.status}`;
    try { const err = JSON.parse(response.body); errMsg = err.error_description || err.error || errMsg; } catch {}
    throw new Error(errMsg);
  }

  const tokenData = JSON.parse(response.body);
  if (!tokenData.access_token) throw new Error('No access_token in response');
  console.log(`[MCP OAuth] token exchange ok for ${providerId}: hasToken=${!!tokenData.access_token} expires=${tokenData.expires_in ?? 'n/a'} refresh=${!!tokenData.refresh_token}`);

  // Store the grant
  const grant = {
    accessToken: tokenData.access_token,
    tokenType: tokenData.token_type || 'Bearer',
    scope: tokenData.scope || '',
    expiresIn: tokenData.expires_in || null,
    refreshToken: tokenData.refresh_token || null,
    obtainedAt: Date.now(),
    providerId,
    mcpUrl,
  };

  try {
    storeCredential(`${providerId}-mcp-grant`, grant);
    console.log(`[MCP OAuth] Stored grant for ${providerId} in Keychain`);
  } catch (err) {
    console.error(`[MCP OAuth] FAILED to store grant for ${providerId}:`, err && err.message);
    throw err;
  }

  // Fetch MCP server info with the token to confirm it works
  try {
    const tools = await callMcpToolsList(mcpUrl, grant.accessToken);
    grant.availableTools = tools;
    storeCredential(`${providerId}-mcp-grant`, grant);
  } catch {
    // Non-critical
  }

  return { providerId, name: providerId, connected: true };
}

// ─── MCP tool calls ───────────────────────────────────────────────────────

/**
 * Call the MCP tools/list endpoint with an access token.
 */
export async function callMcpToolsList(mcpUrl, accessToken) {
  const request = {
    jsonrpc: MCP_JSONRPC_VERSION,
    id: 2,
    method: 'tools/list',
    params: {},
  };

  const response = await jsonRpcRequest(mcpUrl, request, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status !== 200) {
    throw new Error(`MCP tools/list returned ${response.status}`);
  }

  const data = JSON.parse(response.body);
  return data.result?.tools || [];
}

/**
 * Call a specific MCP tool with arguments.
 */
export async function callMcpTool(mcpUrl, accessToken, toolName, args = {}) {
  const request = {
    jsonrpc: MCP_JSONRPC_VERSION,
    id: Date.now(),
    method: 'tools/call',
    params: { name: toolName, arguments: args },
  };

  const response = await jsonRpcRequest(mcpUrl, request, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (response.status !== 200) {
    throw new Error(`MCP tool call returned ${response.status}`);
  }

  const data = JSON.parse(response.body);
  return data.result || null;
}

// ─── Connection status ────────────────────────────────────────────────────

/**
 * Get MCP OAuth connection status for a provider.
 */
export function getMcpConnectionStatus(providerId) {
  const grant = getCredential(`${providerId}-mcp-grant`);
  if (!grant) return { connected: false, providerId };

  const expiresAt = grant.obtainedAt + (grant.expiresIn ? grant.expiresIn * 1000 : 0);
  const isExpired = grant.expiresIn ? Date.now() >= expiresAt : false;

  return {
    connected: true,
    providerId,
    mcpUrl: grant.mcpUrl,
    scope: grant.scope || null,
    expiresAt: grant.expiresIn ? expiresAt : null,
    isExpired,
    hasRefreshToken: !!grant.refreshToken,
    availableTools: grant.availableTools || null,
  };
}

/**
 * Disconnect MCP provider (revoke + remove).
 */
export async function disconnectMcpProvider(providerId) {
  const grant = getCredential(`${providerId}-mcp-grant`);
  if (grant && grant.accessToken) {
    try {
      // Attempt revocation if the auth server supports it
      const authMeta = await discoverMcpOAuth(grant.mcpUrl);
      const revokeEndpoint = authMeta.authServer.revocation_endpoint;
      if (revokeEndpoint) {
        await postFormUrl(revokeEndpoint, {
          token: grant.accessToken,
          token_type_hint: 'access_token',
        });
      }
    } catch {
      // Non-critical
    }
  }

  deleteCredential(`${providerId}-mcp-grant`);
  deleteCredential(`${providerId}-mcp-client`);
  return { providerId, disconnected: true };
}

/**
 * Refresh an MCP OAuth token.
 */
export async function refreshMcpToken(providerId) {
  const grant = getCredential(`${providerId}-mcp-grant`);
  if (!grant || !grant.refreshToken) return null;

  try {
    const authMeta = await discoverMcpOAuth(grant.mcpUrl);
    const tokenEndpoint = authMeta.authServer.token_endpoint;
    if (!tokenEndpoint) return null;

    const params = {
      client_id: grant.clientId || (getCredential(`${providerId}-mcp-client`) || {}).client_id,
      grant_type: 'refresh_token',
      refresh_token: grant.refreshToken,
    };

    // Include the resource parameter (RFC 8707) for MCP-scoped refresh
    if (grant.mcpUrl) {
      params.resource = grant.mcpUrl;
    }

    // Add client_secret if available (for pre-registered apps like Slack)
    const clientData = getCredential(`${providerId}-mcp-client`);
    if (clientData && clientData.client_secret) {
      params.client_secret = clientData.client_secret;
    }

    const response = await postFormUrl(tokenEndpoint, params);
    if (response.status !== 200) return null;

    const tokenData = JSON.parse(response.body);
    if (!tokenData.access_token) return null;

    grant.accessToken = tokenData.access_token;
    grant.expiresIn = tokenData.expires_in || grant.expiresIn;
    grant.refreshToken = tokenData.refresh_token || grant.refreshToken;
    grant.obtainedAt = Date.now();

    storeCredential(`${providerId}-mcp-grant`, grant);
    return grant;
  } catch {
    return null;
  }
}

// ─── MCP endpoint configurations for known providers ───────────────────────

export const MCP_ENDPOINTS = {
  slack: {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    mcpUrl: 'https://mcp.slack.com/mcp',
    discoveryUrl: 'https://mcp.slack.com/.well-known/oauth-protected-resource',
    description: 'Messages, threads, and files',
    authType: 'oauth',
    requiresAppRegistration: true,
    setupGuide: [
      'Create a Slack app at https://api.slack.com/apps',
      'Under "OAuth & Permissions", enable PKCE',
      `Add redirect URL: http://localhost:3000/api/auth/mcp-callback/slack`,
      'Add User Token Scopes: search:read.public, search:read.private, channels:history, groups:history, mpim:history, im:history, users:read, channels:read, files:read, emoji:read, reactions:read',
      'Copy the Client ID and Client Secret from Basic Information',
    ],
  },
  linear: {
    id: 'linear',
    name: 'Linear',
    icon: '⬡',
    mcpUrl: 'https://mcp.linear.app/mcp',
    discoveryUrl: 'https://mcp.linear.app/.well-known/oauth-protected-resource/mcp',
    description: 'Issues and projects',
    authType: 'oauth',
    requiresAppRegistration: false,
  },
  todoist: {
    id: 'todoist',
    name: 'Todoist',
    icon: '✓',
    mcpUrl: 'https://ai.todoist.net/mcp',
    discoveryUrl: 'https://ai.todoist.net/.well-known/oauth-protected-resource/mcp',
    description: 'Tasks and projects',
    authType: 'oauth',
    requiresAppRegistration: false,
  },
  devin: {
    id: 'devin',
    name: 'Devin',
    icon: 'Δ',
    mcpUrl: 'https://mcp.devin.ai/mcp',
    discoveryUrl: null,
    description: 'AI software engineering sessions',
    authType: 'api-key',
    requiresAppRegistration: false,
  },
};

export function getMcpEndpoint(providerId) {
  return MCP_ENDPOINTS[providerId] || null;
}