export function unwrapMcpResult(result) {
  if (!result || result.isError) return null;
  if (result.structuredContent !== undefined) return result.structuredContent;
  const text = result.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function findWorkspacePrefix(linearWorkspaces, workspaceLabel) {
  const target = workspaceLabel.toLowerCase();
  const match = Object.entries(linearWorkspaces ?? {}).find(([label]) => label.toLowerCase() === target);
  return match?.[1];
}

export async function fetchRawContext(task, callMcpTool, toolNames) {
  if (task.source === 'slack') {
    const result = await callMcpTool(toolNames.slackReadThread, {
      channel_id: task.sourceRef.channelId,
      message_ts: task.sourceRef.threadTs,
    });
    return unwrapMcpResult(result);
  }

  if (task.source === 'linear') {
    // workspaceLabel may come from a URL slug (lowercase, e.g. "acme") or
    // from a Linear team name (e.g. "Acme") — match case-insensitively.
    const prefix = findWorkspacePrefix(toolNames.linearWorkspaces, task.sourceRef.workspaceLabel);
    if (!prefix) return null;
    const result = await callMcpTool(`${prefix}get_issue`, { id: task.sourceRef.issueId });
    return unwrapMcpResult(result);
  }

  return null;
}
