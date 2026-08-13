/**
 * OAuth manager — PKCE authorization code flow for public clients.
 *
 * Manages:
 *   - Code Verifier / Code Challenge generation (S256)
 *   - State and nonce generation
 *   - Authorization URL construction
 *   - Callback verification and token exchange
 *   - Token refresh
 *   - Dynamic Client Registration (RFC 7591)
 *
 * In-memory state store for pending authorization attempts.
 * Completed grants are persisted to macOS Keychain via credentialStore.
 */

import crypto from 'crypto';
import https from 'https';
import http from 'http';
import { getProviderConfig, getCallbackUrl } from './providerConfigs.js';
import { storeCredential, getCredential, deleteCredential } from './credentialStore.js';

// ─── In-memory state store ──────────────────────────────────────────────
// Each entry represents a pending authorization attempt.
// Entries expire after AUTH_TIMEOUT_MS and are cleaned up on access.
const _pendingAuths = new Map();
const AUTH_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

function cleanExpiredAuths() {
  const now = Date.now();
  for (const [key, entry] of _pendingAuths) {
    if (now - entry.createdAt > AUTH_TIMEOUT_MS) {
      _pendingAuths.delete(key);
    }
  }
}

// ─── PKCE helpers ───────────────────────────────────────────────────────

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

function generateNonce() {
  return base64URLEncode(crypto.randomBytes(16));
}

// ─── HTTP helpers ────────────────────────────────────────────────────────

function postFormUrl(url, params) {
  const body = new URLSearchParams(params).toString();
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || (url.startsWith('https') ? 443 : 80),
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = proto.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(body);
    req.end();
  });
}

function postJson(url, body, options = {}) {
  const data = JSON.stringify(body);
  const urlObj = new URL(url);
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
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
      res.on('end', () => resolve({ status: res.statusCode, body: responseData }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
    req.write(data);
    req.end();
  });
}

function fetchUrl(url, options = {}) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const req = proto.get(url, { headers: options.headers || {}, ...options }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(new Error('Request timed out')); });
  });
}

// ─── Dynamic Client Registration (RFC 7591) ────────────────────────────

/**
 * Register this client dynamically with the provider.
 * Stores the returned client credentials in Keychain.
 * Returns the client_id (and client_secret if applicable).
 */
export async function registerDynamicClient(providerId, origin) {
  const config = getProviderConfig(providerId);
  if (!config || !config.supportsDCR) {
    throw new Error(`Provider ${providerId} does not support dynamic client registration`);
  }

  // Check if we already have a registered client
  const existing = getCredential(config.clientCredentialService);
  if (existing && existing.client_id) {
    return existing;
  }

  const callbackUrl = getCallbackUrl(providerId, origin);

  const body = {
    client_name: 'Task Juggler',
    redirect_uris: [callbackUrl],
    scope: config.defaultScope,
    grant_types: ['authorization_code'],
    response_types: ['code'],
    token_endpoint_auth_method: config.tokenEndpointAuthMethod || 'none',
  };

  if (config.hasRefreshTokens) {
    body.grant_types.push('refresh_token');
  }

  const response = await postJson(config.registerUrl, body);

  if (response.status !== 201 && response.status !== 200) {
    let errMsg = `DCR registration returned status ${response.status}`;
    try {
      const err = JSON.parse(response.body);
      errMsg = err.error_description || err.error || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  const clientData = JSON.parse(response.body);

  // Validate response
  if (!clientData.client_id) {
    throw new Error('DCR registration did not return a client_id');
  }

  // Store in Keychain
  storeCredential(config.clientCredentialService, clientData);

  return clientData;
}

// ─── Authorization flow ─────────────────────────────────────────────────

/**
 * Start an OAuth authorization flow for the given provider.
 *
 * Returns:
 *   { authUrl, state, providerId }
 *
 * The caller should open `authUrl` in the user's browser.
 */
export async function startAuthorization(providerId, origin) {
  const config = getProviderConfig(providerId);
  if (!config) {
    throw new Error(`Unknown provider: ${providerId}`);
  }

  // Ensure we have a registered client
  let clientData;
  if (config.supportsDCR) {
    clientData = await registerDynamicClient(providerId, origin);
  } else {
    // For providers without DCR, client must be pre-configured
    clientData = getCredential(config.clientCredentialService);
    if (!clientData || !clientData.client_id) {
      throw new Error(
        `No OAuth client configured for ${config.name}. ` +
        `Please set up your ${config.name} app and enter the client credentials.`
      );
    }
  }

  const callbackUrl = getCallbackUrl(providerId, origin);
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();
  const nonce = generateNonce();

  // Store pending auth state
  const authId = `${providerId}:${state}`;
  _pendingAuths.set(authId, {
    providerId,
    state,
    codeVerifier,
    nonce,
    clientId: clientData.client_id,
    callbackUrl,
    createdAt: Date.now(),
  });

  // Build authorization URL
  const params = new URLSearchParams({
    client_id: clientData.client_id,
    redirect_uri: callbackUrl,
    response_type: 'code',
    state,
  });

  // Some providers (Slack) use user_scope instead of scope for user-level tokens
  if (config.userScope) {
    params.set('user_scope', config.userScope);
  } else {
    params.set('scope', config.defaultScope);
  }

  if (config.supportsPKCE) {
    params.set('code_challenge', codeChallenge);
    params.set('code_challenge_method', 'S256');
  }

  const authUrl = `${config.authorizationUrl}?${params.toString()}`;

  return { authUrl, state, providerId };
}

// ─── Callback handling ──────────────────────────────────────────────────

/**
 * Handle an OAuth callback. Verifies state, exchanges the code for tokens,
 * and stores the grant in Keychain.
 *
 * Returns the connection result on success, or throws on error.
 */
export async function handleCallback(providerId, queryParams) {
  const { code, state } = queryParams;

  if (!code) {
    throw new Error('Authorization code missing from callback');
  }
  if (!state) {
    throw new Error('State parameter missing from callback');
  }

  cleanExpiredAuths();

  // Verify state
  const authId = `${providerId}:${state}`;
  const pendingAuth = _pendingAuths.get(authId);
  if (!pendingAuth) {
    throw new Error(
      'Invalid or expired authorization state. ' +
      'This can happen if the authorization took too long or if the state parameter was tampered with.'
    );
  }

  // Consume the pending auth (one-time use)
  _pendingAuths.delete(authId);

  // Exchange code for tokens
  const config = getProviderConfig(providerId);

  const exchangeParams = {
    client_id: pendingAuth.clientId,
    code,
    redirect_uri: pendingAuth.callbackUrl,
    grant_type: 'authorization_code',
  };

  if (config.supportsPKCE && pendingAuth.codeVerifier) {
    exchangeParams.code_verifier = pendingAuth.codeVerifier;
  }

  // Look up client secret if the provider requires one
  if (config.tokenEndpointAuthMethod !== 'none') {
    const clientData = getCredential(config.clientCredentialService);
    if (clientData && clientData.client_secret) {
      exchangeParams.client_secret = clientData.client_secret;
    }
  }

  const response = await postFormUrl(config.tokenUrl, exchangeParams);

  if (response.status !== 200) {
    let errMsg = `Token exchange returned status ${response.status}`;
    try {
      const err = JSON.parse(response.body);
      errMsg = err.error_description || err.error || errMsg;
    } catch {}
    throw new Error(errMsg);
  }

  const tokenData = JSON.parse(response.body);

  if (!tokenData.access_token) {
    throw new Error('Token exchange did not return an access_token');
  }

  // Build the grant object with metadata
  const grant = {
    accessToken: tokenData.access_token,
    tokenType: tokenData.token_type || 'Bearer',
    scope: tokenData.scope || config.defaultScope,
    expiresIn: tokenData.expires_in || null,
    refreshToken: tokenData.refresh_token || null,
    obtainedAt: Date.now(),
    providerId,
  };

  // Enhance grant with account info (non-blocking — fetch in background)
  storeCredential(config.oauthGrantService, grant);

  // Fetch account info asynchronously to add display metadata
  fetchAccountInfo(providerId, grant.accessToken).then((accountInfo) => {
    const current = getCredential(config.oauthGrantService);
    if (current) {
      storeCredential(config.oauthGrantService, { ...current, accountInfo });
    }
  }).catch(() => {
    // Non-critical — ignore failures
  });

  return {
    providerId,
    name: config.name,
    icon: config.icon,
    accountInfo: null, // populated async
  };
}

// ─── Token refresh ──────────────────────────────────────────────────────

/**
 * Refresh an OAuth access token using the stored refresh token.
 * Returns the updated grant, or null if the provider doesn't support refresh.
 */
export async function refreshAccessToken(providerId) {
  const config = getProviderConfig(providerId);
  if (!config) throw new Error(`Unknown provider: ${providerId}`);

  const grant = getCredential(config.oauthGrantService);
  if (!grant || !grant.refreshToken) return null;

  const clientData = getCredential(config.clientCredentialService);
  if (!clientData || !clientData.client_id) return null;

  const params = {
    client_id: clientData.client_id,
    grant_type: 'refresh_token',
    refresh_token: grant.refreshToken,
  };

  if (config.tokenEndpointAuthMethod !== 'none' && clientData.client_secret) {
    params.client_secret = clientData.client_secret;
  }

  const response = await postFormUrl(config.tokenUrl, params);

  if (response.status !== 200) {
    // Refresh failed — likely expired. User needs to re-authorize.
    return null;
  }

  const tokenData = JSON.parse(response.body);

  if (!tokenData.access_token) return null;

  // Update the stored grant
  const updatedGrant = {
    ...grant,
    accessToken: tokenData.access_token,
    expiresIn: tokenData.expires_in || grant.expiresIn,
    refreshToken: tokenData.refresh_token || grant.refreshToken,
    obtainedAt: Date.now(),
  };

  storeCredential(config.oauthGrantService, updatedGrant);
  return updatedGrant;
}

// ─── Connection status ──────────────────────────────────────────────────

/**
 * Get the current connection status for a provider.
 */
export function getConnectionStatus(providerId) {
  const config = getProviderConfig(providerId);
  if (!config) return { connected: false };

  const grant = getCredential(config.oauthGrantService);
  if (!grant) {
    return { connected: false, providerId };
  }

  const expiresAt = grant.obtainedAt + (grant.expiresIn * 1000 || 0);
  const isExpired = grant.expiresIn ? Date.now() >= expiresAt : false;

  return {
    connected: true,
    providerId,
    name: config.name,
    icon: config.icon,
    scope: grant.scope || null,
    expiresAt: grant.expiresIn ? expiresAt : null,
    isExpired,
    hasRefreshToken: !!grant.refreshToken,
    accountInfo: grant.accountInfo || null,
  };
}

/**
 * Disconnect a provider: revoke the token if supported, then delete the grant.
 */
export async function disconnectProvider(providerId) {
  const config = getProviderConfig(providerId);
  if (!config) throw new Error(`Unknown provider: ${providerId}`);

  const grant = getCredential(config.oauthGrantService);
  if (grant && grant.accessToken) {
    // Attempt revocation (best-effort)
    try {
      const clientData = getCredential(config.clientCredentialService);
      if (clientData && clientData.client_id) {
        const revokeUrl = providerId === 'todoist'
          ? `https://api.todoist.com/api/v1/access_tokens?client_id=${clientData.client_id}&client_secret=${clientData.client_secret || ''}&access_token=${grant.accessToken}`
          : null;
        if (revokeUrl) {
          await fetchUrl(revokeUrl, { method: 'DELETE' });
        }
      }
    } catch {
      // Revocation failure is non-critical — we still remove local credentials
    }
  }

  deleteCredential(config.oauthGrantService);
  return { providerId, disconnected: true };
}

/**
 * Revoke all OAuth grants (used on server shutdown or full reset).
 */
export function disconnectAllProviders() {
  for (const [id, config] of Object.entries(PROVIDER_CONFIGS)) {
    if (config.oauthGrantService) {
      deleteCredential(config.oauthGrantService);
    }
  }
}

// ─── Account info (background enrichment) ───────────────────────────────

async function fetchAccountInfo(providerId, accessToken) {
  switch (providerId) {
    case 'todoist': {
      // Use Sync API — the /sync/v9/user endpoint is deprecated (410 Gone)
      const resp = await postFormUrl('https://api.todoist.com/api/v1/sync', {
        sync_token: '*',
        resource_types: JSON.stringify(['user']),
      }, {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (resp.status === 200) {
        const data = JSON.parse(resp.body);
        const user = data.user || {};
        return {
          id: user.id,
          name: user.full_name,
          email: user.email,
        };
      }
      return null;
    }
    default:
      return null;
  }
}

// Re-export provider configs for convenience
export { PROVIDER_CONFIGS } from './providerConfigs.js';
export { getProviderConfig } from './providerConfigs.js';