export function normalizeLinearIssue(issue) {
  const canonical = {
    status: issue?.status ?? null,
    statusType: issue?.statusType ?? null,
    assignee: issue?.assignee ?? null,
    priority: issue?.priority?.name ?? null,
    dueDate: issue?.dueDate ?? null,
    labels: [...(issue?.labels ?? [])].sort(),
    title: issue?.title ?? null,
    updatedAt: issue?.updatedAt ?? null,
  };
  return JSON.stringify(canonical, Object.keys(canonical).sort());
}

export function normalizeSlackThread(rawText) {
  return typeof rawText === 'string' ? rawText.trim() : '';
}
