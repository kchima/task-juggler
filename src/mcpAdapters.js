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

// Live-verified: slack_read_thread does NOT return a bare text blob. It
// returns an envelope — {messages: "<the thread text>", pagination_info:
// "..."} — which unwrapMcpResult parses into an OBJECT, not a string. Code
// that assumed a string silently treated every real thread as unfetchable.
// (The old fixture was a bare non-JSON blob, so JSON.parse threw and it fell
// through to a string — which is exactly why the mock passed and production
// didn't.) Accepts a bare string too, since that costs nothing and keeps
// this robust to a connector that returns the simpler shape.
export function slackThreadText(unwrapped) {
  if (typeof unwrapped === 'string') return unwrapped;
  const messages = unwrapped?.messages;
  return typeof messages === 'string' ? messages : null;
}

// Returns the canonical workspace label from the configured linearWorkspaces
// map by matching case-insensitively against the input label. When no match
// is found, returns the input label unchanged so that tasks with an unknown
// workspace label still have a sensible identity key for display and dismissal.
export function normalizeLinearWorkspace(label, linearWorkspaces) {
  const target = String(label ?? '').toLowerCase();
  const match = Object.keys(linearWorkspaces ?? {}).find((k) => k.toLowerCase() === target);
  return match ?? label;
}

function findWorkspacePrefix(linearWorkspaces, workspaceLabel) {
  const canonical = normalizeLinearWorkspace(workspaceLabel, linearWorkspaces);
  return (linearWorkspaces ?? {})[canonical] ?? null;
}

export async function fetchRawContext(task, callMcpTool, toolNames) {
  if (task.source === 'slack') {
    const result = await callMcpTool(toolNames.slackReadThread, {
      channel_id: task.sourceRef.channelId,
      message_ts: task.sourceRef.threadTs,
    });
    return slackThreadText(unwrapMcpResult(result));
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
