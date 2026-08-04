import { describe, it, expect } from 'vitest';
import { buildToolConfig, configToMcpTools } from '../src/connectorConfig.js';

describe('buildToolConfig', () => {
  it('returns null for null input', () => {
    expect(buildToolConfig(null)).toBeNull();
  });

  it('returns null for undefined input', () => {
    expect(buildToolConfig(undefined)).toBeNull();
  });

  it('returns null when no connectors were discovered', () => {
    expect(buildToolConfig({ slack: null, linearWorkspaces: [], todoist: null })).toBeNull();
  });

  it('builds a full config from all three sources', () => {
    const result = buildToolConfig({
      slack: { readThread: 'mcp__s__slack_read_thread', search: 'mcp__s__slack_search' },
      linearWorkspaces: [
        { label: 'Acme', prefix: 'mcp__la__' },
        { label: 'Globex', prefix: 'mcp__lg__' },
      ],
      todoist: { findTasks: 'mcp__t__find-tasks' },
    });
    expect(result).toEqual({
      slackReadThread: 'mcp__s__slack_read_thread',
      slackSearch: 'mcp__s__slack_search',
      linearWorkspaces: { Acme: 'mcp__la__', Globex: 'mcp__lg__' },
      todoistFindTasks: 'mcp__t__find-tasks',
    });
  });

  it('builds config from Slack only', () => {
    const result = buildToolConfig({
      slack: { readThread: 'mcp__s__slack_read_thread', search: 'mcp__s__slack_search' },
      linearWorkspaces: [],
      todoist: null,
    });
    expect(result).toEqual({
      slackReadThread: 'mcp__s__slack_read_thread',
      slackSearch: 'mcp__s__slack_search',
      linearWorkspaces: {},
      todoistFindTasks: '',
    });
  });

  it('builds config from Linear only', () => {
    const result = buildToolConfig({
      slack: null,
      linearWorkspaces: [{ label: 'Acme', prefix: 'mcp__la__' }],
      todoist: null,
    });
    expect(result).toEqual({
      slackReadThread: '',
      slackSearch: '',
      linearWorkspaces: { Acme: 'mcp__la__' },
      todoistFindTasks: '',
    });
  });

  it('builds config from Todoist only', () => {
    const result = buildToolConfig({
      slack: null,
      linearWorkspaces: [],
      todoist: { findTasks: 'mcp__t__find-tasks' },
    });
    expect(result).toEqual({
      slackReadThread: '',
      slackSearch: '',
      linearWorkspaces: {},
      todoistFindTasks: 'mcp__t__find-tasks',
    });
  });

  it('preserves Slack readThread when search is missing', () => {
    const result = buildToolConfig({
      slack: { readThread: 'mcp__s__slack_read_thread', search: '' },
      linearWorkspaces: [],
      todoist: null,
    });
    expect(result.slackReadThread).toBe('mcp__s__slack_read_thread');
    expect(result.slackSearch).toBe('');
  });

  it('filters out invalid Linear workspace entries (missing label, missing prefix, non-string)', () => {
    const result = buildToolConfig({
      slack: null,
      linearWorkspaces: [
        { label: 'Acme', prefix: 'mcp__la__' },
        { label: '', prefix: 'mcp__empty__' },
        { prefix: 'mcp__nolabel__' },
        { label: 'NotAString', prefix: 42 },
        { label: 'Globex', prefix: 'mcp__lg__' },
      ],
      todoist: null,
    });
    expect(result.linearWorkspaces).toEqual({ Acme: 'mcp__la__', Globex: 'mcp__lg__' });
  });

  it('handles empty linearWorkspaces array gracefully', () => {
    const result = buildToolConfig({
      slack: { readThread: 't', search: 's' },
      linearWorkspaces: [],
      todoist: { findTasks: 'f' },
    });
    expect(result.linearWorkspaces).toEqual({});
  });

  it('handles non-array linearWorkspaces gracefully', () => {
    const result = buildToolConfig({
      slack: { readThread: 't', search: 's' },
      linearWorkspaces: null,
      todoist: { findTasks: 'f' },
    });
    expect(result.linearWorkspaces).toEqual({});
  });
});

describe('configToMcpTools', () => {
  it('returns empty array for null config', () => {
    expect(configToMcpTools(null)).toEqual([]);
  });

  it('returns empty array for undefined config', () => {
    expect(configToMcpTools(undefined)).toEqual([]);
  });

  it('returns empty array for config with all empty fields', () => {
    expect(configToMcpTools({
      slackReadThread: '',
      slackSearch: '',
      linearWorkspaces: {},
      todoistFindTasks: '',
    })).toEqual([]);
  });

  it('includes Slack read and search tools', () => {
    const tools = configToMcpTools({
      slackReadThread: 'mcp__s__slack_read_thread',
      slackSearch: 'mcp__s__slack_search',
      linearWorkspaces: {},
      todoistFindTasks: '',
    });
    expect(tools).toEqual(['mcp__s__slack_read_thread', 'mcp__s__slack_search']);
  });

  it('includes Linear list_issues and get_issue for each workspace prefix', () => {
    const tools = configToMcpTools({
      slackReadThread: '',
      slackSearch: '',
      linearWorkspaces: { Acme: 'mcp__la__', Globex: 'mcp__lg__' },
      todoistFindTasks: '',
    });
    expect(tools).toEqual([
      'mcp__la__list_issues',
      'mcp__la__get_issue',
      'mcp__lg__list_issues',
      'mcp__lg__get_issue',
    ]);
  });

  it('includes Todoist find-tasks', () => {
    const tools = configToMcpTools({
      slackReadThread: '',
      slackSearch: '',
      linearWorkspaces: {},
      todoistFindTasks: 'mcp__t__find-tasks',
    });
    expect(tools).toEqual(['mcp__t__find-tasks']);
  });

  it('deduplicates identical tool names', () => {
    // This shouldn't happen in practice but guards against it
    const tools = configToMcpTools({
      slackReadThread: 'mcp__x__tool',
      slackSearch: 'mcp__x__tool', // same name — unlikely but defensively handled
      linearWorkspaces: {},
      todoistFindTasks: '',
    });
    expect(tools).toEqual(['mcp__x__tool']);
  });

  it('includes all tools in order for a full config', () => {
    const tools = configToMcpTools({
      slackReadThread: 'mcp__s__read',
      slackSearch: 'mcp__s__search',
      linearWorkspaces: { Acme: 'mcp__la__', Globex: 'mcp__lg__' },
      todoistFindTasks: 'mcp__t__find',
    });
    expect(tools).toEqual([
      'mcp__s__read',
      'mcp__s__search',
      'mcp__la__list_issues',
      'mcp__la__get_issue',
      'mcp__lg__list_issues',
      'mcp__lg__get_issue',
      'mcp__t__find',
    ]);
  });

  it('skips Linear workspace when the prefix is an empty string', () => {
    const tools = configToMcpTools({
      slackReadThread: '',
      slackSearch: '',
      linearWorkspaces: { Acme: '' },
      todoistFindTasks: '',
    });
    expect(tools).toEqual([]);
  });
});