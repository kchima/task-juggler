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

// "Skip it, degrade gracefully" answers *whether* discovery kept working —
// it says nothing about *what discovery actually saw*. This panel is the
// answer to "is it even finding my threads" without needing to guess from
// the outside: every candidate the last scan looked at, and what happened
// to it. Unlike renderErrors, this never hides — "found nothing this scan"
// is itself something worth being able to confirm, not just failures.
export function renderCandidates(container, { slack = [], claude = [], linear = [] } = {}) {
  const total = slack.length + claude.length + linear.length;
  container.querySelector(':scope > summary').textContent = `Detected this scan (${total})`;
  renderCandidateGroup(container.querySelector('[data-group="slack"]'), 'Slack', slack);
  renderCandidateGroup(container.querySelector('[data-group="claude"]'), 'Claude', claude);
  renderCandidateGroup(container.querySelector('[data-group="linear"]'), 'Linear', linear);
}

function renderCandidateGroup(groupEl, label, items) {
  groupEl.querySelector('summary').textContent = `${label} (${items.length})`;
  const list = groupEl.querySelector('ul');
  list.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'jg-candidate-empty';
    li.textContent = 'none this scan';
    list.appendChild(li);
    return;
  }
  for (const item of items) {
    const li = document.createElement('li');
    li.textContent = `[${item.outcome}] ${item.label}`;
    list.appendChild(li);
  }
}

// Renders raw connector-probe output. Everything here is deliberately
// verbatim and in a <pre>: the whole point is to read the LITERAL response
// (exact indentation, quoting, line breaks), because a paraphrase of a
// response shape is what caused the bugs this exists to prevent. Normal HTML
// rendering would collapse exactly the whitespace we're trying to inspect.
export function renderProbe(container, reports) {
  const list = container.querySelector('ul');
  list.innerHTML = '';
  if (!reports.length) {
    container.hidden = true;
    return;
  }
  container.hidden = false;
  const ok = reports.filter((r) => r.outcome === 'ok').length;
  container.querySelector('summary').textContent = `Connector probe — ${ok}/${reports.length} call${reports.length === 1 ? '' : 's'} succeeded`;

  const ICON = { ok: '✓', 'tool-error': '⚠', unreachable: '✗' };

  for (const report of reports) {
    const li = document.createElement('li');

    const heading = document.createElement('div');
    heading.className = 'jg-probe-name';
    // Args are part of the identity of the attempt: the same name can fail
    // with one signature and succeed with another, and that difference is
    // the finding.
    heading.textContent = `${ICON[report.outcome] ?? '?'} ${report.name}  ${JSON.stringify(report.args)}`;
    li.appendChild(heading);

    const body = document.createElement('pre');
    body.className = 'jg-probe-body';
    body.textContent = report.outcome === 'ok'
      ? [
        `unwrapped type: ${report.shape.unwrappedType}`,
        `envelope keys:  ${report.shape.unwrappedKeys ? JSON.stringify(report.shape.unwrappedKeys) : '(not an object)'}`,
        `string-valued:  ${report.shape.stringValuedKeys ? JSON.stringify(report.shape.stringValuedKeys) : '(n/a)'}`,
        `structuredContent: ${report.shape.hasStructuredContent}  content[0].text: ${report.shape.contentTextType}`,
      ].join('\n')
      : report.outcome === 'tool-error'
        ? `tool was reached but refused the call:\n${report.error}`
        : `call could not be made at all:\n${report.error}`;
    li.appendChild(body);

    // Each string payload verbatim, with real line breaks — this is the
    // block to read when the response is prose, since the JSON dump below
    // escapes exactly the newlines and quoting being inspected.
    for (const payload of report.shape?.payloadPreviews ?? []) {
      const label = document.createElement('div');
      label.className = 'jg-probe-sublabel';
      label.textContent = `literal payload — ${payload.key}:`;
      li.appendChild(label);

      const pre = document.createElement('pre');
      pre.className = 'jg-probe-body jg-probe-literal';
      pre.textContent = payload.text;
      li.appendChild(pre);
    }

    // Shown for tool-errors too, not just successes — a refusal's raw body
    // often carries the actual reason (an allowlist name, a validation
    // message) that the summary line alone would lose.
    if (report.shape) {
      const label = document.createElement('div');
      label.className = 'jg-probe-sublabel';
      label.textContent = 'raw response (JSON-escaped):';
      li.appendChild(label);

      const pre = document.createElement('pre');
      pre.className = 'jg-probe-body';
      pre.textContent = report.shape.rawJson;
      li.appendChild(pre);
    }

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

// One paste-back-able report instead of "screenshot the errors dropdown,
// then the candidates panel, then the probe panel, then tell me the date
// field's value" — reads straight off the DOM, so it always matches exactly
// what's currently on screen rather than a separately-tracked copy of it.
export function buildDebugSnapshot(doc) {
  const lines = [`Task Juggler debug snapshot — ${new Date().toISOString()}`, ''];

  lines.push(`Status: ${doc.getElementById('jg-status')?.textContent || '(empty)'}`);
  lines.push(`Slack lookback override: ${doc.getElementById('jg-lookback-input')?.value || '(default — last 24h)'}`);
  lines.push('');

  lines.push('--- Errors ---');
  const errorsEl = doc.getElementById('jg-errors');
  if (!errorsEl || errorsEl.hidden) {
    lines.push('(none)');
  } else {
    for (const li of errorsEl.querySelectorAll('li')) lines.push(`- ${li.textContent.trim()}`);
  }
  lines.push('');

  lines.push('--- Detected this scan ---');
  const candidatesEl = doc.getElementById('jg-candidates');
  if (candidatesEl) {
    for (const group of candidatesEl.querySelectorAll('[data-group]')) {
      lines.push(`${group.querySelector('summary')?.textContent || group.dataset.group}:`);
      for (const li of group.querySelectorAll('li')) lines.push(`  - ${li.textContent.trim()}`);
    }
  }
  lines.push('');

  lines.push('--- Last connector probe ---');
  const probeEl = doc.getElementById('jg-probe');
  if (!probeEl || probeEl.hidden) {
    lines.push('(not run this session — click Probe first if relevant)');
  } else {
    // Preserved verbatim, not trimmed to one line — the probe's whole point
    // is the literal formatting of a raw connector response.
    for (const li of probeEl.querySelectorAll(':scope > ul > li')) {
      lines.push(`* ${li.textContent.trim()}`);
    }
  }

  return lines.join('\n');
}
