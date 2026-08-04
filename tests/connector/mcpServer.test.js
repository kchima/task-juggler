// Tests for the FakeMcpServer
import { describe, it, expect } from 'vitest';
import { FakeMcpServer } from '../../app/connector/fakeMcpServer.js';

describe('FakeMcpServer', () => {
  describe('JSON-RPC protocol compliance', () => {
    it('responds to initialize with protocol version and capabilities', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'initialize',
      }));
      expect(responses).toHaveLength(1);
      const parsed = JSON.parse(responses[0]);
      expect(parsed.jsonrpc).toBe('2.0');
      expect(parsed.id).toBe(1);
      expect(parsed.error).toBeUndefined();
      expect(parsed.result.protocolVersion).toBe('2024-11-05');
      expect(parsed.result.serverInfo.name).toBe('fake-mcp-server');
    });

    it('acknowledges notifications without response', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage(JSON.stringify({
        jsonrpc: '2.0', method: 'notifications/initialized',
      }));
      expect(responses).toEqual([]);
    });

    it('lists available tools', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage(JSON.stringify({
        jsonrpc: '2.0', id: 2, method: 'tools/list',
      }));
      const parsed = JSON.parse(responses[0]);
      expect(parsed.result.tools.length).toBeGreaterThanOrEqual(3);
      const names = parsed.result.tools.map((t) => t.name);
      expect(names).toContain('slack_search');
      expect(names).toContain('linear_list_issues');
    });

    it('returns -32601 for unknown method', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage(JSON.stringify({
        jsonrpc: '2.0', id: 3, method: 'unknown_method',
      }));
      const parsed = JSON.parse(responses[0]);
      expect(parsed.error.code).toBe(-32601);
    });

    it('returns -32700 for parse errors', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage('not json at all');
      const parsed = JSON.parse(responses[0]);
      expect(parsed.error.code).toBe(-32700);
    });

    it('handles missing jsonrpc field', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage(JSON.stringify({ method: 'x' }));
      const parsed = JSON.parse(responses[0]);
      expect(parsed.error.code).toBe(-32600);
    });
  });

  describe('tool execution', () => {
    it('calls a tool and returns its result', () => {
      const server = new FakeMcpServer({
        customHandlers: {
          greet: (args) => ({ content: [{ type: 'text', text: `Hello, ${args.name}!` }], isError: false }),
        },
      });
      const responses = server.processMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'greet', arguments: { name: 'World' } },
      }));
      const parsed = JSON.parse(responses[0]);
      expect(parsed.result.content[0].text).toBe('Hello, World!');
    });

    it('returns -32601 for unknown tool', () => {
      const server = new FakeMcpServer();
      const responses = server.processMessage(JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'nonexistent_tool', arguments: {} },
      }));
      const parsed = JSON.parse(responses[0]);
      expect(parsed.error.code).toBe(-32601);
    });
  });

  describe('processInitialize', () => {
    it('handles the full initialize sequence', () => {
      const server = new FakeMcpServer();
      const responses = server.processInitialize();
      expect(responses).toHaveLength(2); // initialize response + tools/list response
      const initResp = JSON.parse(responses[0]);
      expect(initResp.result.serverInfo.name).toBe('fake-mcp-server');
      const toolsResp = JSON.parse(responses[1]);
      expect(toolsResp.result.tools).toBeDefined();
    });
  });

  describe('callTool convenience method', () => {
    it('calls a tool in-process', () => {
      const server = new FakeMcpServer({
        customHandlers: {
          slack_search: () => ({
            content: [{ type: 'text', text: '# Test search results' }],
            isError: false,
          }),
        },
      });
      const responses = server.callTool('slack_search', { query: 'test' });
      const parsed = JSON.parse(responses[0]);
      expect(parsed.result.content[0].text).toContain('Test search');
    });
  });

  describe('handler errors propagate as error responses', () => {
    it('returns -32603 when a handler throws', () => {
      const server = new FakeMcpServer({
        customHandlers: {
          failing_tool: () => { throw new Error('something broke'); },
        },
      });
      const responses = server.callTool('failing_tool');
      const parsed = JSON.parse(responses[0]);
      expect(parsed.error.code).toBe(-32603);
      expect(parsed.error.message).toContain('something broke');
    });
  });

  describe('default handlers', () => {
    it('slack_search returns no results by default', () => {
      const server = new FakeMcpServer();
      const responses = server.callTool('slack_search');
      const parsed = JSON.parse(responses[0]);
      expect(parsed.result.content[0].text).toContain('No results found');
    });

    it('linear_list_issues returns empty array by default', () => {
      const server = new FakeMcpServer();
      const responses = server.callTool('linear_list_issues');
      const parsed = JSON.parse(responses[0]);
      const result = JSON.parse(parsed.result.content[0].text);
      expect(result.issues).toEqual([]);
    });
  });
});