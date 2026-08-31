// Tests for the MCP OAuth keep-alive (proactive token refresh) logic.
import { describe, it, expect, afterEach, vi } from 'vitest';

// Mock the credential store + avoid real network by mocking getCredential to a
// configurable grant and mocking fetch/token exchange via the credential store.
const grantHolder = { current: null, client: null };
vi.mock('../app/auth/credentialStore.js', () => ({
  getCredential: (service) => {
    if (service === 'linear-mcp-grant') return grantHolder.current;
    if (service === 'linear-mcp-client') return grantHolder.client;
    return null;
  },
  storeCredential: () => {},
  deleteCredential: () => {},
  listCredentials: () => [],
}));

import { refreshMcpTokenIfNeeded, keepAliveAllMcpGrants } from '../app/connector/mcpOAuthClient.js';
import * as oc from '../app/connector/mcpOAuthClient.js';

describe('refreshMcpTokenIfNeeded', () => {
  afterEach(() => { grantHolder.current = null; grantHolder.client = null; vi.restoreAllMocks(); });

  it('does not refresh a fresh token', async () => {
    grantHolder.current = { accessToken: 'a', refreshToken: 'r', expiresIn: 3600, obtainedAt: Date.now(), mcpUrl: 'https://x/mcp' };
    const r = await refreshMcpTokenIfNeeded('linear', { now: new Date() });
    expect(r.needed).toBe(false);
    expect(r.reason).toBe('fresh');
  });

  it('attempts refresh when near expiry', async () => {
    grantHolder.current = { accessToken: 'a', refreshToken: 'r', expiresIn: 120, obtainedAt: Date.now() - 60_000, mcpUrl: 'https://mcp.linear.app/mcp' };
    const refreshFn = vi.fn().mockResolvedValue({ accessToken: 'new' });
    const r = await refreshMcpTokenIfNeeded('linear', { nearExpiryMs: 60_000, now: new Date(), refreshFn });
    expect(r.needed).toBe(true);
    expect(r.ok).toBe(true);
    expect(refreshFn).toHaveBeenCalledWith('linear');
  });

  it('reports refresh failure and requires re-auth', async () => {
    grantHolder.current = { accessToken: 'a', refreshToken: 'r', expiresIn: 60, obtainedAt: Date.now() - 60_000, mcpUrl: 'https://x' };
    const refreshFn = vi.fn().mockResolvedValue(null);
    const r = await refreshMcpTokenIfNeeded('linear', { nearExpiryMs: 60_000, now: new Date(), refreshFn });
    expect(r.needed).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('refresh-failed');
  });

  it('no-ops without a refresh token', async () => {
    grantHolder.current = { accessToken: 'a', expiresIn: 60, obtainedAt: Date.now() - 60_000 };
    const r = await refreshMcpTokenIfNeeded('linear');
    expect(r.needed).toBe(false);
    expect(r.reason).toBe('no-refresh');
  });

  it('keepAliveAllMcpGrants returns per-provider results', async () => {
    grantHolder.current = null; // no grant → no-op
    const r = await keepAliveAllMcpGrants({ providers: ['linear', 'slack'] });
    expect(r.linear).toBeDefined();
    expect(r.slack).toBeDefined();
  });
});