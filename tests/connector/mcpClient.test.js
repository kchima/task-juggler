// Tests for the McpClient
import { describe, it, expect, beforeEach } from 'vitest';
import { McpClient, createMcpClient } from '../../app/connector/mcpClient.js';
import { FakeMcpServer, createSlackTestServer, createLinearTestServer, createTodoistTestServer } from '../../app/connector/fakeMcpServer.js';

describe('McpClient', () => {
  describe('connect and tools discovery', () => {
    it('discovers tools after connecting', async () => {
      const { client } = createMcpClient();
      await client.connect();
      const names = client.toolNames();
      expect(names).toContain('slack_search');
      expect(names).toContain('slack_read_thread');
      expect(names).toContain('linear_list_issues');
      expect(names).toContain('todoist_find_tasks');
      expect(client.hasTool('slack_search')).toBe(true);
      expect(client.hasTool('nonexistent')).toBe(false);
    });

    it('is idempotent: calling connect twice does not re-initialize', async () => {
      const { client, server } = createMcpClient();
      // Track how many initialize calls are made
      let initCount = 0;
      const originalProcess = server.processMessage.bind(server);
      server.processMessage = (line) => {
        if (line.includes('"initialize"')) initCount++;
        return originalProcess(line);
      };
      await client.connect();
      await client.connect();
      expect(initCount).toBe(1);
    });
  });

  describe('callTool', () => {
    it('calls a default tool', async () => {
      const { client } = createMcpClient();
      await client.connect();
      const result = await client.callTool('slack_search', { query: 'hello' });
      expect(result.content).toBeDefined();
      expect(result.isError).toBe(false);
    });

    it('calls a custom handler', async () => {
      const { client } = createMcpClient({
        greet: (args) => ({
          content: [{ type: 'text', text: `Hi ${args.name}!` }],
          isError: false,
        }),
      });
      await client.connect();
      const result = await client.callTool('greet', { name: 'Test' });
      expect(result.content[0].text).toBe('Hi Test!');
    });

    it('throws for unknown tool', async () => {
      const { client } = createMcpClient();
      await client.connect();
      await expect(client.callTool('nope', {})).rejects.toThrow('Tool not found');
    });

    it('throws when not initialized', async () => {
      const { client } = createMcpClient();
      await expect(client.callTool('slack_search', {})).rejects.toThrow('not initialized');
    });
  });

  describe('handler that throws', () => {
    it('propagates handler errors as callTool rejections', async () => {
      const { client } = createMcpClient({
        broken: () => { throw new Error('handler failure'); },
      });
      await client.connect();
      await expect(client.callTool('broken', {})).rejects.toThrow('handler failure');
    });
  });
});

describe('Pre-configured test servers', () => {
  describe('createSlackTestServer', () => {
    it('returns search results matching the injected data', async () => {
      const results = [
        { channelId: 'C01TEST1', threadTs: '1784800000.100000', workspaceDomain: 'test.slack.com' },
        { channelId: 'C01TEST2', threadTs: '1784800001.200000', workspaceDomain: 'test.slack.com' },
      ];
      const { client } = createMcpClient();
      client.server = createSlackTestServer({ searchResults: results });

      const client2 = new McpClient(client.server);
      await client2.connect();

      const searchResult = await client2.callTool('slack_search', { query: 'test' });
      const text = searchResult.content[0].text;
      expect(text).toContain('C01TEST1');
      expect(text).toContain('C01TEST2');
    });

    it('custom thread results are returned by slack_read_thread', async () => {
      const threadResults = {
        'C01T:C02T:123.456': 'Custom thread content for testing',
      };
      const { client } = createMcpClient();
      client.server = createSlackTestServer({ threadResults });

      const client2 = new McpClient(client.server);
      await client2.connect();

      const result = await client2.callTool('slack_read_thread', {
        channel_id: 'C01T:C02T', message_ts: '123.456',
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.messages).toBe('Custom thread content for testing');
    });
  });

  describe('createLinearTestServer', () => {
    it('returns injected Linear issues', async () => {
      const issues = [
        { id: 'ACME-1', title: 'Fix login bug', statusType: 'started', priority: { label: 'High' } },
        { id: 'ACME-2', title: 'Add dark mode', statusType: 'backlog', priority: { label: 'Medium' } },
      ];
      const { client } = createMcpClient();
      client.server = createLinearTestServer({ issues });

      const client2 = new McpClient(client.server);
      await client2.connect();

      const result = await client2.callTool('linear_list_issues', { assignee: 'me' });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.issues).toHaveLength(2);
      expect(parsed.issues[0].title).toBe('Fix login bug');
    });
  });

  describe('createTodoistTestServer', () => {
    it('returns injected Todoist tasks', async () => {
      const tasks = [
        { id: 'T1', content: 'Urgent task', priority: 'p1', projectId: 'P1' },
        { id: 'T2', content: 'Normal task', priority: 'p3', projectId: 'P1' },
      ];
      const { client } = createMcpClient();
      client.server = createTodoistTestServer({ tasks });

      const client2 = new McpClient(client.server);
      await client2.connect();

      const result = await client2.callTool('todoist_find_tasks', { filter: 'p1', limit: 10 });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.tasks).toHaveLength(2);
    });
  });
});