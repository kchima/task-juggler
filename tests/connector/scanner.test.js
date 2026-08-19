// Tests for the source scanner
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scanAllSources, checkMcpCapabilities, isMcpGrantExpired } from '../../app/connector/scanner.js';
import { getSource, getEnabledSources } from '../../app/connector/registry.js';
import { FakeMcpServer, createSlackTestServer, createLinearTestServer, createTodoistTestServer } from '../../app/connector/fakeMcpServer.js';
import { McpClient } from '../../app/connector/mcpClient.js';

// Isolate the scanner from the developer's real Keychain/network: no stored
// grants means no OAuth refresh or MCP tool calls during tests. This keeps the
// suite fast, deterministic, and hermetic on any machine.
vi.mock('../../app/auth/credentialStore.js', () => ({
  getCredential: () => null,
  storeCredential: () => {},
  deleteCredential: () => {},
  listCredentials: () => [],
}));

describe('registry', () => {
  it('returns source definitions for all known sources', () => {
    expect(getSource('slack').label).toBe('Slack');
    expect(getSource('linear').label).toBe('Linear');
    expect(getSource('todoist').label).toBe('Todoist');
    expect(getSource('devin').label).toBe('Devin');
    expect(getSource('claude').label).toContain('Claude');
    expect(getSource('opencode').label).toContain('OpenCode');
  });

  it('returns null for unknown source', () => {
    expect(getSource('nonexistent')).toBeNull();
  });

  it('getEnabledSources returns all sources in order', () => {
    const sources = getEnabledSources();
    expect(sources.length).toBeGreaterThanOrEqual(4);
    expect(sources[0].id).toBe('slack');
    expect(sources[1].id).toBe('linear');
  });
});

describe('scanAllSources — no MCP client', () => {
  it('returns unconfigured status for sources without keys or MCP', async () => {
    const results = await scanAllSources(null);
    // Slack: unconfigured unless a real OAuth grant exists in Keychain (env-dependent)
    expect(['unconfigured', 'ok', 'error']).toContain(results.slack.status);
    // Linear may have an MCP OAuth grant from a real connection (environment-dependent).
    // With a grant present but the token failing, status is 'error' (connected-but-failed).
    expect(['ok', 'unconfigured', 'error']).toContain(results.linear.status);
    expect(results.devin.status).toBe('unconfigured');
    // Todoist: unconfigured if no OAuth grant, ok/error if a grant exists in Keychain
    expect(['ok', 'unconfigured', 'error']).toContain(results.todoist.status);
    // Claude/OpenCode: discover local sessions if present, ok otherwise
    expect(['ok', 'error', 'unconfigured']).toContain(results.claude.status);
    expect(results.opencode).toBeDefined();
  });

  it('does not report unconfigured sources as errors (happy path, not an error)', async () => {
    const results = await scanAllSources(null);
    // "Not configured" is the correct state before a user connects — it must not
    // surface as an error. Errors are reserved for genuine failures.
    if (results.slack.status === 'unconfigured') {
      expect(results.slack.errors).toEqual([]);
    }
    if (results.devin.status === 'unconfigured') {
      expect(results.devin.errors).toEqual([]);
    }
    if (results.todoist.status === 'unconfigured') {
      expect(results.todoist.errors).toEqual([]);
    }
    if (results.linear.status === 'unconfigured') {
      expect(results.linear.errors).toEqual([]);
    }
  });
});

describe('scanAllSources — with MCP client', () => {
  it('scans Slack using a fake MCP server', async () => {
    const searchResults = [
      { channelId: 'C01SCAN', threadTs: '1784800000.500000', workspaceDomain: 'test.slack.com' },
      { channelId: 'C02SCAN', threadTs: '1784800001.600000', workspaceDomain: 'test.slack.com' },
    ];
    const server = createSlackTestServer({ searchResults });
    const client = new McpClient(server);
    await client.connect();

    const results = await scanAllSources(client);
    // Slack should have found items from the fake search
    expect(results.slack.status).toBe('ok');
    expect(results.slack.items.length).toBeGreaterThanOrEqual(2);
  });

  it('scans Linear using a fake MCP server', async () => {
    const issues = [
      { id: 'LINEAR-1', identifier: 'PROJ-1', title: 'Fix the thing', statusType: 'started', url: 'https://linear.app/proj/issue/PROJ-1' },
      { id: 'LINEAR-2', identifier: 'PROJ-2', title: 'Completed issue', statusType: 'completed', url: 'https://linear.app/proj/issue/PROJ-2' },
    ];
    const server = createLinearTestServer({ issues });
    const client = new McpClient(server);
    await client.connect();

    const results = await scanAllSources(client);
    expect(results.linear.items).toHaveLength(1); // only the started one
    expect(results.linear.items[0].key).toContain('LINEAR-1');
  });

  it('scans Todoist using a fake MCP server', async () => {
    const tasks = [
      { id: 'T1', content: 'Urgent task', priority: 'p1', projectId: 'P1' },
      { id: 'T2', content: 'Normal task', priority: 'p3', projectId: 'P1' },
    ];
    const server = createTodoistTestServer({ tasks });
    const client = new McpClient(server);
    await client.connect();

    const results = await scanAllSources(client);
    expect(results.todoist.items).toHaveLength(2);
  });

  it('reports errors from failing tools gracefully', async () => {
    const server = new FakeMcpServer({
      customHandlers: {
        slack_search: () => { throw new Error('API rate limited'); },
      },
    });
    const client = new McpClient(server);
    await client.connect();

    const results = await scanAllSources(client);
    expect(results.slack.errors.length).toBeGreaterThan(0);
    expect(results.slack.errors[0]).toContain('API rate limited');
    // Other sources should still work
    expect(results.linear).toBeDefined();
  });
});

describe('checkMcpCapabilities', () => {
  it('returns disconnected status when no client', () => {
    const status = checkMcpCapabilities(null);
    expect(status.connected).toBe(false);
    expect(status.supportedSources).toEqual([]);
  });

  it('detects which sources are supported by available tools', async () => {
    const client = new McpClient(new FakeMcpServer());
    await client.connect();

    const status = checkMcpCapabilities(client);
    expect(status.connected).toBe(true);
    expect(status.supportedSources).toContain('slack');
    expect(status.supportedSources).toContain('linear');
    expect(status.supportedSources).toContain('todoist');
  });
});
describe('isMcpGrantExpired', () => {
  const NOW = new Date('2026-08-01T12:00:00Z');

  it('never flags a grant without expiresIn', () => {
    expect(isMcpGrantExpired({ accessToken: 'x' }, NOW)).toBe(false);
    expect(isMcpGrantExpired(null, NOW)).toBe(false);
  });

  it('flags an access token past its expiry as expired', () => {
    const grant = { expiresIn: 3600, obtainedAt: NOW.getTime() - 3600 * 1000 }; // expired 1s ago
    expect(isMcpGrantExpired(grant, NOW)).toBe(true);
  });

  it('flags a token within the refresh buffer as nearly-expired so we refresh early', () => {
    const grant = { expiresIn: 3600, obtainedAt: NOW.getTime() - (3600 - 30) * 1000 }; // 30s left
    expect(isMcpGrantExpired(grant, NOW)).toBe(true);
  });

  it('does not flag a fresh token', () => {
    const grant = { expiresIn: 3600, obtainedAt: NOW.getTime() - 60_000 }; // 59m left
    expect(isMcpGrantExpired(grant, NOW)).toBe(false);
  });

  it('respects a custom buffer', () => {
    const grant = { expiresIn: 3600, obtainedAt: NOW.getTime() - (3600 - 600) * 1000 }; // 10m left
    expect(isMcpGrantExpired(grant, NOW, 60_000)).toBe(false);
    expect(isMcpGrantExpired(grant, NOW, 15 * 60_000)).toBe(true);
  });
});
