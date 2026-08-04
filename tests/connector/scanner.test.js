// Tests for the source scanner
import { describe, it, expect, beforeEach } from 'vitest';
import { scanAllSources, checkMcpCapabilities } from '../../app/connector/scanner.js';
import { getSource, getEnabledSources } from '../../app/connector/registry.js';
import { FakeMcpServer, createSlackTestServer, createLinearTestServer, createTodoistTestServer } from '../../app/connector/fakeMcpServer.js';
import { McpClient } from '../../app/connector/mcpClient.js';

describe('registry', () => {
  it('returns source definitions for all known sources', () => {
    expect(getSource('slack').label).toBe('Slack');
    expect(getSource('linear').label).toBe('Linear');
    expect(getSource('todoist').label).toBe('Todoist');
    expect(getSource('devin').label).toBe('Devin');
    expect(getSource('claude').label).toContain('Claude');
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
  it('returns unconfigured status for all sources when no MCP client', async () => {
    const results = await scanAllSources(null);
    expect(results.slack.status).toBe('unconfigured');
    expect(results.linear.status).toBe('unconfigured');
    expect(results.todoist.status).toBe('unconfigured');
    expect(results.devin.status).toBe('unconfigured');
    expect(results.claude.status).toBe('unconfigured');
  });

  it('includes helpful error messages about what is needed', async () => {
    const results = await scanAllSources(null);
    expect(results.slack.errors.length).toBeGreaterThan(0);
    expect(results.slack.errors[0]).toContain('MCP server');
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