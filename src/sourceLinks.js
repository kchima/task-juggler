// Resolves a task to the place the work actually lives, so a title can be
// clicked to jump straight back into context.
//
// Only builds links this project has actually verified. A source with no
// known-good URL scheme returns null rather than a plausible-looking guess —
// a link that silently does nothing is worse than no link, because the user
// can't tell the difference until they need it.

// Set once the Claude Desktop per-session deep-link path is confirmed. The
// `claude://` scheme IS registered by the desktop app (verified in
// Claude.app/Contents/Info.plist), but the path format for opening a
// specific session was not discoverable from the app bundle, so this stays
// off by default. To enable: set this to a template containing {sessionId},
// e.g. 'claude://session/{sessionId}', and verify by running
//   open "claude://<whatever>/<a-real-session-id>"
// in a terminal — if the app focuses that session, the template is right.
export const CLAUDE_SESSION_LINK_TEMPLATE = null;

export function sourceLinkFor(task, { claudeSessionTemplate = CLAUDE_SESSION_LINK_TEMPLATE } = {}) {
  const ref = task?.sourceRef ?? {};

  // A URL captured at add-by-link time is always the most trustworthy thing
  // we have — it came from the user or from a real permalink.
  if (ref.url) return { url: ref.url, kind: task.source };

  if (task?.source === 'slack' && ref.channelId && ref.threadTs) {
    // Slack permalinks need the workspace domain; discovery captures it off
    // the search-result permalink. Without it we can't build a valid link.
    if (!ref.workspaceDomain) return null;
    const tsDigits = ref.threadTs.replace('.', '');
    return {
      url: `https://${ref.workspaceDomain}/archives/${ref.channelId}/p${tsDigits}`,
      kind: 'slack',
    };
  }

  if (task?.source === 'linear' && ref.workspaceLabel && ref.issueId) {
    return { url: `https://linear.app/${ref.workspaceLabel}/issue/${ref.issueId}`, kind: 'linear' };
  }

  if (task?.source === 'todoist' && ref.taskId) {
    return { url: `https://app.todoist.com/app/task/${ref.taskId}`, kind: 'todoist' };
  }

  if (task?.source === 'claude_session' && ref.sessionId && claudeSessionTemplate) {
    return { url: claudeSessionTemplate.replace('{sessionId}', ref.sessionId), kind: 'claude_session' };
  }

  return null;
}

// Stable per-task window name so clicking the same task twice refocuses the
// tab it already opened instead of piling up duplicates. This is as close to
// "reuse the existing tab" as a sandboxed page can get — it cannot focus a
// tab it didn't open itself.
export function windowNameFor(task) {
  return `jg-${task.source}-${task.id}`;
}
