/**
 * Fake MCP server for CI-safe integration testing.
 * Implements a minimal MCP protocol over stdio using JSON-RPC 2.0.
 * No real credentials or network access needed — all data is injected.
 */

import { EventEmitter } from 'events';

// --- JSON-RPC helpers -----------------------------------------------------

function jsonRpcRequest(id, method, params = {}) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function jsonRpcSuccess(id, result) {
  return JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
}

function jsonRpcError(id, code, message) {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
}

// --- Standard MCP tool schemas --------------------------------------------

const TOOL_SCHEMAS = {
  slack_search: {
    name: 'slack_search',
    description: 'Search Slack messages and threads',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', default: 20 },
      },
    },
  },
  slack_read_thread: {
    name: 'slack_read_thread',
    description: 'Read a Slack thread',
    inputSchema: {
      type: 'object',
      properties: {
        channel_id: { type: 'string' },
        message_ts: { type: 'string' },
      },
    },
  },
  linear_list_issues: {
    name: 'linear_list_issues',
    description: 'List Linear issues assigned to me',
    inputSchema: {
      type: 'object',
      properties: {
        assignee: { type: 'string', default: 'me' },
      },
    },
  },
  todoist_find_tasks: {
    name: 'todoist_find_tasks',
    description: 'Find Todoist tasks',
    inputSchema: {
      type: 'object',
      properties: {
        filter: { type: 'string' },
        limit: { type: 'number', default: 50 },
      },
    },
  },
};

// --- FakeMcpServer --------------------------------------------------------

export class FakeMcpServer extends EventEmitter {
  constructor(options = {}) {
    super();
    this.tools = { ...TOOL_SCHEMAS };
    this.handlers = {};
    this.output = [];
    this._nextId = 1;

    // Default handlers that return plausible empty responses
    this.setHandler('slack_search', () => ({
      content: [{ type: 'text', text: '# Search Results\n\nNo results found.' }],
      isError: false,
    }));
    this.setHandler('slack_read_thread', () => ({
      content: [{ type: 'text', text: JSON.stringify({ messages: 'No messages', pagination_info: {} }) }],
      isError: false,
    }));
    this.setHandler('linear_list_issues', () => ({
      content: [{ type: 'text', text: JSON.stringify({ issues: [] }) }],
      isError: false,
    }));
    this.setHandler('todoist_find_tasks', () => ({
      content: [{ type: 'text', text: JSON.stringify({ tasks: [] }) }],
      isError: false,
    }));

    if (options.customHandlers) {
      for (const [name, handler] of Object.entries(options.customHandlers)) {
        this.setHandler(name, handler);
      }
    }
  }

  setHandler(toolName, handler) {
    this.handlers[toolName] = handler;
  }

  // Process a single JSON-RPC message and return response lines
  processMessage(rawLine) {
    let request;
    try {
      request = JSON.parse(rawLine);
    } catch {
      return [jsonRpcError(null, -32700, 'Parse error')];
    }

    if (request.jsonrpc !== '2.0' || !request.method) {
      return [jsonRpcError(request.id ?? null, -32600, 'Invalid Request')];
    }

    const id = request.id ?? null;
    const { method, params = {} } = request;

    switch (method) {
      case 'initialize':
        return [jsonRpcSuccess(id, {
          protocolVersion: '2024-11-05',
          capabilities: {
            tools: {},
            resources: {},
          },
          serverInfo: { name: 'fake-mcp-server', version: '1.0.0' },
        })];

      case 'notifications/initialized':
        return []; // no response for notifications

      case 'tools/list':
        return [jsonRpcSuccess(id, { tools: Object.values(this.tools) })];

      case 'tools/call': {
        const toolName = params.name;
        const handler = this.handlers[toolName];
        if (!handler) {
          return [jsonRpcError(id, -32601, `Tool not found: ${toolName}`)];
        }
        try {
          const result = handler(params.arguments ?? {});
          return [jsonRpcSuccess(id, result)];
        } catch (err) {
          return [jsonRpcError(id, -32603, err.message || 'Internal error')];
        }
      }

      default:
        return [jsonRpcError(id, -32601, `Method not found: ${method}`)];
    }
  }

  // Simulate stdio interaction: receive a line, produce response lines
  receive(line) {
    const responses = this.processMessage(line);
    for (const r of responses) {
      this.output.push(r);
      this.emit('response', r);
    }
    return responses;
  }

  // Generate an initialize sequence as a client would
  initializeSequence() {
    return [
      jsonRpcRequest(this._nextId++, 'initialize'),
      jsonRpcRequest(this._nextId++, 'notifications/initialized'),
      jsonRpcRequest(this._nextId++, 'tools/list'),
    ];
  }

  // Process a full initialize sequence (all three messages)
  processInitialize() {
    const allResponses = [];
    for (const msg of this.initializeSequence()) {
      const responses = this.processMessage(msg.trim());
      allResponses.push(...responses);
    }
    return allResponses;
  }

  // Call a tool and return response
  callTool(toolName, args = {}) {
    const msg = jsonRpcRequest(this._nextId++, 'tools/call', { name: toolName, arguments: args });
    return this.processMessage(msg.trim());
  }
}

// --- Convenience: create a pre-configured fake server with test data -------

export function createSlackTestServer(options = {}) {
  const searchResults = options.searchResults || [];
  const threadResults = options.threadResults || {};

  return new FakeMcpServer({
    customHandlers: {
      slack_search: (args) => {
        const results = searchResults.length > 0
          ? searchResults
          : [{ channelId: 'C0TEST', threadTs: '1784829904.373009', workspaceDomain: 'test.slack.com' }];
        const lines = ['# Search Results'];
        results.forEach((r, i) => {
          lines.push(`### Result ${i + 1}`);
          lines.push(`Channel: #test (ID: ${r.channelId})`);
          lines.push(`Permalink: [link](https://${r.workspaceDomain}/archives/${r.channelId}/p${r.threadTs.replace('.', '')}?thread_ts=${r.threadTs}&cid=${r.channelId})`);
        });
        return { content: [{ type: 'text', text: lines.join('\n') }], isError: false };
      },
      slack_read_thread: (args) => {
        const key = `${args.channel_id}:${args.message_ts}`;
        const text = threadResults[key] ?? 'Test: this is a test thread message.';
        return {
          content: [{ type: 'text', text: JSON.stringify({ messages: text, pagination_info: {} }) }],
          isError: false,
        };
      },
      ...options.customHandlers,
    },
  });
}

export function createLinearTestServer(options = {}) {
  const issues = options.issues || [];
  return new FakeMcpServer({
    customHandlers: {
      linear_list_issues: () => ({
        content: [{ type: 'text', text: JSON.stringify({ issues }) }],
        isError: false,
      }),
      ...options.customHandlers,
    },
  });
}

export function createTodoistTestServer(options = {}) {
  const tasks = options.tasks || [];
  return new FakeMcpServer({
    customHandlers: {
      todoist_find_tasks: () => ({
        content: [{ type: 'text', text: JSON.stringify({ tasks }) }],
        isError: false,
      }),
      ...options.customHandlers,
    },
  });
}