// Builds a validated tool-config object and its corresponding mcp_tools
// allowlist from the results of a chat-side connector probe. This is the
// producer side of the configuration seam: the skill calls these functions
// to determine what to inject into #juggler-tool-config and which tool names
// to declare in the artifact's mcp_tools allowlist.

/**
 * @typedef {Object} SlackProbe
 * @property {string} readThread  — full tool name for slack_read_thread
 * @property {string} search      — full tool name for slack_search
 */

/**
 * @typedef {Object} LinearWorkspaceProbe
 * @property {string} label  — user-visible workspace/team name
 * @property {string} prefix — connector server prefix (tool names start with this)
 */

/**
 * @typedef {Object} TodoistProbe
 * @property {string} findTasks — full tool name for find-tasks
 */

/**
 * @typedef {Object} ProbeResults
 * @property {SlackProbe|null}       slack
 * @property {LinearWorkspaceProbe[]} linearWorkspaces
 * @property {TodoistProbe|null}     todoist
 */

/**
 * Build a validated tool-config JSON object from connector probe results.
 * Returns null when the probe produced no usable connectors at all.
 * Missing or null sources default to empty strings/objects so the artifact
 * degrades gracefully rather than receiving an undefined field.
 *
 * @param {ProbeResults} results
 * @returns {object|null}
 */
export function buildToolConfig(results) {
  if (!results) return null;
  if (!results.slack && !results.todoist && !results.linearWorkspaces?.length) return null;

  const config = {
    slackReadThread: '',
    slackSearch: '',
    linearWorkspaces: {},
    todoistFindTasks: '',
  };

  if (results.slack) {
    if (typeof results.slack.readThread === 'string' && results.slack.readThread) {
      config.slackReadThread = results.slack.readThread;
    }
    if (typeof results.slack.search === 'string' && results.slack.search) {
      config.slackSearch = results.slack.search;
    }
  }

  if (Array.isArray(results.linearWorkspaces)) {
    for (const ws of results.linearWorkspaces) {
      if (ws && typeof ws.label === 'string' && ws.label && typeof ws.prefix === 'string' && ws.prefix) {
        config.linearWorkspaces[ws.label] = ws.prefix;
      }
    }
  }

  if (results.todoist) {
    if (typeof results.todoist.findTasks === 'string' && results.todoist.findTasks) {
      config.todoistFindTasks = results.todoist.findTasks;
    }
  }

  return config;
}

/**
 * Derive a deduplicated mcp_tools allowlist from a validated tool-config object.
 * Each Linear workspace contributes its list_issues and get_issue tool names
 * (prefixed by the connector prefix). The list preserves insertion order and
 * removes duplicates so the same tool name is never declared twice.
 *
 * @param {object} config — validated tool config (from buildToolConfig or validateToolConfig)
 * @returns {string[]}
 */
export function configToMcpTools(config) {
  const tools = [];

  function add(name) {
    if (typeof name === 'string' && name && !tools.includes(name)) {
      tools.push(name);
    }
  }

  if (config?.slackReadThread) add(config.slackReadThread);
  if (config?.slackSearch) add(config.slackSearch);

  if (config?.linearWorkspaces && typeof config.linearWorkspaces === 'object' && !Array.isArray(config.linearWorkspaces)) {
    for (const prefix of Object.values(config.linearWorkspaces)) {
      if (typeof prefix === 'string' && prefix) {
        add(`${prefix}list_issues`);
        add(`${prefix}get_issue`);
      }
    }
  }

  if (config?.todoistFindTasks) add(config.todoistFindTasks);

  return tools;
}