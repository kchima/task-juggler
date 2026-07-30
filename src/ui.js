import { sortTasks, completedTasks } from './scoring.js';
import { sourceLinkFor, windowNameFor } from './sourceLinks.js';

const STATUS_CYCLE = ['not_started', 'in_progress', 'waiting_other', 'waiting_ai', 'completed'];
const STATUS_LABEL = {
  not_started: 'Not started',
  in_progress: 'In progress',
  waiting_other: 'Waiting (other)',
  waiting_ai: 'Waiting (AI)',
  completed: 'Completed',
};

// Connector/fetch failures degrade gracefully everywhere in app.js (one
// source failing never blocks the others), but "degrade gracefully" must not
// mean "vanish silently" — this surfaces exactly what each catch caught, in
// a dropdown collapsed by default so it's invisible on the happy path.
export function renderErrors(container, errors) {
  const list = container.querySelector('ul');
  if (!errors.length) {
    container.hidden = true;
    list.innerHTML = '';
    return;
  }
  container.hidden = false;
  container.querySelector('summary').textContent = `⚠ ${errors.length} issue${errors.length === 1 ? '' : 's'}`;
  list.innerHTML = '';
  for (const message of errors) {
    const li = document.createElement('li');
    li.textContent = message;
    list.appendChild(li);
  }
}

export function nextStatus(status) {
  const idx = STATUS_CYCLE.indexOf(status);
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}

// A task that came from somewhere real gets a clickable, visually distinct
// title that jumps back to the source. Tasks with no resolvable source (manual
// ones, or sources with no verified URL scheme) render as plain text — the
// underline is a promise that clicking will work.
function buildTitleEl(task, className) {
  const link = sourceLinkFor(task);
  if (!link) {
    const span = document.createElement('span');
    span.className = className;
    span.textContent = task.title;
    return span;
  }

  const anchor = document.createElement('a');
  anchor.className = `${className} jg-title-linked`;
  anchor.textContent = task.title;
  anchor.href = link.url;
  anchor.rel = 'noopener noreferrer';
  anchor.title = `Open in ${link.kind}: ${link.url}`;
  anchor.dataset.linkKind = link.kind;
  // Named target so re-clicking the same task refocuses the tab it opened
  // before rather than stacking up duplicates.
  anchor.target = windowNameFor(task);
  return anchor;
}

function renderRow(task, handlers, isCompleted) {
  const row = document.createElement('div');
  row.className = 'jg-row' + (isCompleted ? ' jg-row-completed' : '');
  row.dataset.taskId = task.id;

  const chip = document.createElement('button');
  chip.className = `jg-chip jg-chip-${task.status}`;
  chip.textContent = STATUS_LABEL[task.status] ?? task.status;
  chip.addEventListener('click', () => handlers.onCycleStatus(task.id));
  row.appendChild(chip);

  row.appendChild(buildTitleEl(task, 'jg-title'));

  if (task.summary) {
    const summary = document.createElement('span');
    summary.className = 'jg-summary';
    summary.textContent = task.summary;
    row.appendChild(summary);
  }

  if (task.waitingOn) {
    const badge = document.createElement('span');
    badge.className = 'jg-badge' + (task.waitingOn === 'user' ? ' jg-badge-user' : '');
    badge.textContent = `waiting on ${task.waitingOn}`;
    row.appendChild(badge);
  }

  if (isCompleted) {
    const reopen = document.createElement('button');
    reopen.className = 'jg-reopen';
    reopen.textContent = 'Reopen';
    reopen.addEventListener('click', () => handlers.onReopen(task.id));
    row.appendChild(reopen);
  } else {
    const refresh = document.createElement('button');
    refresh.className = 'jg-refresh';
    refresh.textContent = '⟳';
    refresh.addEventListener('click', () => handlers.onRefreshOne(task.id));
    row.appendChild(refresh);

    const del = document.createElement('button');
    del.className = 'jg-delete';
    del.textContent = '✕';
    del.addEventListener('click', () => handlers.onDelete(task.id));
    row.appendChild(del);
  }

  return row;
}

export function renderList(container, tasks, handlers) {
  container.innerHTML = '';
  const active = sortTasks(tasks);
  const done = completedTasks(tasks);

  for (const task of active) container.appendChild(renderRow(task, handlers, false));

  if (done.length) {
    const header = document.createElement('div');
    header.className = 'jg-completed-header';
    header.textContent = `Completed (${done.length})`;
    container.appendChild(header);
    for (const task of done) container.appendChild(renderRow(task, handlers, true));
  }
}

export function renderCard(container, task, handlers) {
  container.innerHTML = '';
  if (!task) {
    container.textContent = 'No tasks.';
    return;
  }

  const card = document.createElement('div');
  card.className = 'jg-card';
  card.dataset.taskId = task.id;

  const title = document.createElement('h2');
  title.appendChild(buildTitleEl(task, 'jg-card-title'));
  card.appendChild(title);

  const summary = document.createElement('p');
  summary.className = 'jg-card-summary';
  summary.textContent = task.summary || '(no summary yet)';
  card.appendChild(summary);

  const next = document.createElement('p');
  next.className = 'jg-card-next';
  next.textContent = `Next: ${task.nextAction || '(none)'}`;
  card.appendChild(next);

  if (task.sourceRef?.url) {
    const link = document.createElement('a');
    link.href = task.sourceRef.url;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open source';
    card.appendChild(link);
  }

  const skip = document.createElement('button');
  skip.className = 'jg-skip';
  skip.textContent = 'Skip →';
  skip.addEventListener('click', () => handlers.onSkip(task.id));
  card.appendChild(skip);

  container.appendChild(card);
}
