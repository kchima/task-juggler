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

// --- Connector shape probe ------------------------------------------------
// Twice now, code has been written against a *description* of an MCP
// response instead of the response itself, and been subtly wrong both times
// (the Slack `{messages, pagination_info}` envelope being the expensive
// one). This reports what a tool ACTUALLY returned, from inside whatever
// sandbox the artifact is running in — which is also the only place that can
// answer whether a tool is reachable from an artifact at all, since the
// host's callMcpTool bridge may expose a narrower allowlist than chat does.
//
// Deliberately reports the raw envelope AND what unwrapMcpResult makes of
// it, because the gap between those two is exactly where the bugs live.
const PROBE_PREVIEW_LIMIT = 4000;

export function summarizeMcpShape(raw) {
  const unwrapped = unwrapMcpResult(raw);
  const unwrappedType = unwrapped === null ? 'null' : Array.isArray(unwrapped) ? 'array' : typeof unwrapped;
  return {
    isError: Boolean(raw?.isError),
    hasStructuredContent: raw?.structuredContent !== undefined,
    contentTextType: typeof raw?.content?.[0]?.text,
    unwrappedType,
    // The envelope question, answered directly: if this is an object, these
    // keys are the candidates for where the real payload lives.
    unwrappedKeys: unwrappedType === 'object' ? Object.keys(unwrapped) : null,
    stringValuedKeys: unwrappedType === 'object'
      ? Object.entries(unwrapped).filter(([, v]) => typeof v === 'string').map(([k]) => k)
      : null,
    // The raw dump is JSON, so a prose payload comes out escaped onto one
    // line ("...\n - id \"title\"..."), which is unreadable for exactly the
    // case this tool exists to inspect. These are the same strings with
    // their real line breaks, so the literal format can actually be read.
    payloadPreviews: stringPayloads(unwrapped),
    rawJson: safeStringify(raw).slice(0, PROBE_PREVIEW_LIMIT),
  };
}

function stringPayloads(unwrapped) {
  if (typeof unwrapped === 'string') {
    return [{ key: '(whole response)', text: unwrapped.slice(0, PROBE_PREVIEW_LIMIT) }];
  }
  if (unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) {
    return Object.entries(unwrapped)
      .filter(([, v]) => typeof v === 'string')
      .map(([key, v]) => ({ key, text: v.slice(0, PROBE_PREVIEW_LIMIT) }));
  }
  return [];
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

// Calls one tool and reports what came back, never throwing — a name that
// isn't reachable is itself a result worth seeing, not an error to swallow.
export async function probeTool(callMcpTool, name, args) {
  try {
    const raw = await callMcpTool(name, args);
    return { name, args, reachable: true, error: null, shape: summarizeMcpShape(raw) };
  } catch (err) {
    return { name, args, reachable: false, error: err?.message ?? 'call failed', shape: null };
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
