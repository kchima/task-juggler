/**
 * MCP client adapter for local-first Task Juggler.
 * Communicates with MCP servers using JSON-RPC 2.0.
 * For testing, use in-process FakeMcpServer instead of spawning children.
 */

import { FakeMcpServer } from './fakeMcpServer.js';

// --- McpClient (in-process, for testing) ----------------------------------

export class McpClient {
  /**
   * @param {FakeMcpServer} server - An in-process FakeMcpServer instance
   */
  constructor(server) {
    this.server = server;
    this._nextId = 1;
    this._initialized = false;
    this._toolList = [];
  }

  async connect() {
    if (this._initialized) return;

    const initResp = this._send('initialize');
    this._verifySuccess(initResp, 'initialize');

    this._send('notifications/initialized');

    const toolResp = this._send('tools/list');
    const toolResult = this._extractResult(toolResp, 'tools/list');
    this._toolList = (toolResult && toolResult.tools) || [];
    this._initialized = true;
  }

  get tools() {
    return this._toolList;
  }

  hasTool(name) {
    return this._toolList.some((t) => t.name === name);
  }

  toolNames() {
    return this._toolList.map((t) => t.name);
  }

  async callTool(name, args = {}) {
    if (!this._initialized) {
      throw new Error('MCP client not initialized. Call connect() first.');
    }
    const resp = this._send('tools/call', { name, arguments: args });
    return this._extractResult(resp, `tools/call (${name})`);
  }

  // --- Internal -----------------------------------------------------------

  _send(method, params = {}) {
    const id = this._nextId++;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    const responses = this.server.processMessage(msg);
    if (responses.length === 0) return null;
    return responses.map((r) => JSON.parse(r)).pop();
  }

  _verifySuccess(response, label) {
    if (!response) throw new Error(`${label}: no response`);
    if (response.error) throw new Error(`${label}: ${response.error.message}`);
  }

  _extractResult(response, label) {
    this._verifySuccess(response, label);
    return response.result;
  }
}

// --- Convenience factory ---------------------------------------------------

/**
 * Create an McpClient pre-connected to a FakeMcpServer with optional custom handlers.
 * For creating clients with Slack/Linear-specific test servers, import the
 * appropriate factory from fakeMcpServer.js and pass the server here.
 */
export function createMcpClient(customHandlers = {}) {
  const server = new FakeMcpServer({ customHandlers });
  const client = new McpClient(server);
  return { client, server };
}