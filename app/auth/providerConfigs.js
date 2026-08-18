/**
 * Provider OAuth configurations.
 * Each provider defines its authorization and token endpoints, scopes,
 * and whether it supports PKCE, dynamic client registration, and refresh tokens.
 */

export const PROVIDER_CONFIGS = {
  todoist: {
    id: 'todoist',
    name: 'Todoist',
    icon: '✓',
    color: '#e44332',
    authorizationUrl: 'https://app.todoist.com/oauth/authorize',
    tokenUrl: 'https://api.todoist.com/oauth/access_token',
    registerUrl: 'https://api.todoist.com/oauth/register',
    scopes: ['data:read'],
    defaultScope: 'data:read',
    supportsPKCE: true,
    supportsDCR: true,
    tokenEndpointAuthMethod: 'none',
    hasRefreshTokens: true,
    redirectUri: '/api/auth/callback/todoist',
    clientCredentialService: 'todoist-client',
    oauthGrantService: 'todoist-oauth-grant',
    requiredScopes: ['data:read'],
    description: 'Tasks, projects, and filters',
    setupGuide: [
      'Todoist supports dynamic client registration — no initial setup required.',
      'Click "Connect with browser" to authorize via OAuth.',
      'Only read-only access to your tasks is requested.',
    ],
  },

  slack: {
    id: 'slack',
    name: 'Slack',
    icon: '💬',
    color: '#4a154b',
    authorizationUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    revokeUrl: null, // Slack tokens are revoked via app management
    // User scopes (not bot scopes) for a local, user-token app — required for
    // the localhost desktop-redirect flow and for reading what the user can see.
    scopes: [
      'search:read', 'search:read.private',
      'channels:read', 'channels:history',
      'groups:history', 'im:history', 'mpim:history',
      'users:read', 'reactions:read', 'files:read', 'emoji:read',
    ],
    userScope: 'search:read,search:read.private,channels:read,channels:history,groups:history,im:history,mpim:history,users:read,reactions:read,files:read,emoji:read',
    defaultScope: 'search:read,channels:read,channels:history',
    supportsPKCE: true,
    supportsDCR: false,   // Requires creating a Slack app manually
    tokenEndpointAuthMethod: 'none', // PKCE = public client, no secret needed
    hasRefreshTokens: true,
    redirectUri: '/api/auth/callback/slack',
    clientCredentialService: 'slack-client',
    oauthGrantService: 'slack-oauth-grant',
    requiredScopes: ['search:read', 'channels:read', 'channels:history'],
    description: 'Messages and threads',
    setupGuide: [
      '1. Create a Slack app at https://api.slack.com/apps (personal dev account — this is NOT an install into your workspace).',
      '2. Under "OAuth & Permissions", enable PKCE (one-way).',
      `3. Add redirect URL: http://localhost:3000/api/auth/callback/slack`,
      '4. Add USER Token Scopes: search:read, search:read.private, channels:read, channels:history, groups:history, im:history, mpim:history, users:read, reactions:read, files:read, emoji:read',
      '5. Copy the Client ID (Basic Information) and paste it here. No client secret is needed with PKCE.',
      '6. Click "Sign in with Slack" — authorize in the browser, then it is connected.',
    ],
    requiresClientSetup: true,
    clientSetupInstructions: [
      'Open https://api.slack.com/apps → Create New App → Blank app.',
      'Under OAuth & Permissions → enable PKCE (one-way).',
      `Add http://localhost:3000/api/auth/callback/slack as a Redirect URL.`,
      'Add USER Token Scopes: search:read, search:read.private, channels:read, channels:history, groups:history, im:history, mpim:history, users:read, reactions:read, files:read, emoji:read.',
      'Copy the Client ID from Basic Information (no secret needed with PKCE).',
    ],
  },

  linear: {
    id: 'linear',
    name: 'Linear',
    icon: '⬡',
    color: '#5e6ad2',
    authorizationUrl: 'https://linear.app/oauth/authorize',
    tokenUrl: 'https://api.linear.app/oauth/token',
    revokeUrl: 'https://api.linear.app/oauth/revoke',
    scopes: ['read'],
    defaultScope: 'read',
    supportsPKCE: true,
    supportsDCR: false,
    tokenEndpointAuthMethod: 'none',
    hasRefreshTokens: true,
    redirectUri: '/api/auth/callback/linear',
    clientCredentialService: 'linear-client',
    oauthGrantService: 'linear-oauth-grant',
    requiredScopes: ['read'],
    description: 'Issues and projects',
    requiresClientSetup: true,
    setupGuide: [
      '1. Create a Linear OAuth app at https://linear.app/settings/api/apps',
      '2. Add redirect URL: http://localhost:3000/api/auth/callback/linear',
      '3. Copy the Client ID and paste it here',
    ],
    clientSetupInstructions: [
      'Open Linear → Settings → API → OAuth Apps → Create.',
      `Add ${'http://localhost:3000/api/auth/callback/linear'} as a Redirect URI.`,
      'Select scope: read (read-only access to issues and projects).',
      'Copy the Client ID after creation.',
    ],
  },
};

/**
 * Get a provider configuration by ID.
 */
export function getProviderConfig(providerId) {
  return PROVIDER_CONFIGS[providerId] || null;
}

/**
 * Get the callback URL for a provider, relative to the server origin.
 */
export function getCallbackUrl(providerId, origin) {
  const config = getProviderConfig(providerId);
  if (!config) return null;
  return `${origin}${config.redirectUri}`;
}