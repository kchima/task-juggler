const EST_BOOST = { small: 30, medium: 15, large: 0 };
const PRIORITY_BOOST = { urgent: 20, high: 12, medium: 6, low: 0 };

function dueProximityBoost(dueDate, now) {
  if (!dueDate) return 0;
  const days = (new Date(dueDate) - now) / (1000 * 60 * 60 * 24);
  if (days <= 0) return 40;
  if (days <= 2) return 25;
  if (days <= 7) return 10;
  return 0;
}

function stalenessNudge(updatedAt, now) {
  if (!updatedAt) return 0;
  const hours = (now - new Date(updatedAt)) / (1000 * 60 * 60);
  return Math.min(Math.max(hours, 0), 48) * 0.2;
}

export function scoreTask(task, now = new Date()) {
  return (
    (task.ballInUsersCourt ? 100 : 0) +
    (EST_BOOST[task.estRemaining] ?? 0) +
    dueProximityBoost(task.dueDate, now) +
    (PRIORITY_BOOST[(task.sourcePriority ?? '').toLowerCase()] ?? 0) +
    stalenessNudge(task.updatedAt, now)
  );
}

export function tierOf(task) {
  if (task.status === 'not_started' || task.status === 'in_progress') return 0;
  if (task.status === 'waiting_other' || task.status === 'waiting_ai') return 1;
  return 2;
}

export function sortTasks(tasks, now = new Date()) {
  return [...tasks]
    .filter((t) => tierOf(t) !== 2)
    .sort((a, b) => tierOf(a) - tierOf(b) || scoreTask(b, now) - scoreTask(a, now));
}

export function completedTasks(tasks) {
  return tasks.filter((t) => t.status === 'completed');
}
