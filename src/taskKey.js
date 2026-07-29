// Single canonical identity for a task across every subsystem: seed merge
// dedup, dismissal, and discovery watermarks all key off this. Lives in its
// own module so seedMerge/discovery/app can share one definition — the
// concatenating build has no module isolation, so two copies of a function
// named sourceRefKey in different files would be a hard SyntaxError.
export function sourceRefKey(task) {
  const ref = task.sourceRef ?? {};
  if (task.source === 'slack') return `slack:${ref.channelId}:${ref.threadTs}`;
  if (task.source === 'linear') return `linear:${ref.workspaceLabel}:${ref.issueId}`;
  if (task.source === 'todoist') return `todoist:${ref.taskId}`;
  if (task.source === 'claude_session') return `claude_session:${ref.sessionId}`;
  if (task.source === 'claude_code_session') return `claude_code_session:${ref.sessionId}`;
  if (ref.url) return `url:${ref.url}`;
  return `manual:${task.id}`;
}
