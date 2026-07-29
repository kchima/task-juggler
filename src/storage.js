const STORAGE_KEY = 'task-juggler:tasks:v1';
const DISMISSED_KEY = 'task-juggler:dismissed:v1';
const WATERMARKS_KEY = 'task-juggler:watermarks:v1';

function readJson(storageImpl, key, fallback) {
  const raw = storageImpl.getItem(key);
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(fallback)) return Array.isArray(parsed) ? parsed : fallback;
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function readAll(storageImpl) {
  return readJson(storageImpl, STORAGE_KEY, []);
}

function writeAll(storageImpl, tasks) {
  storageImpl.setItem(STORAGE_KEY, JSON.stringify(tasks));
}

export function loadTasks(storageImpl = globalThis.localStorage) {
  return readAll(storageImpl);
}

export function saveTasks(tasks, storageImpl = globalThis.localStorage) {
  writeAll(storageImpl, tasks);
}

export function patchTask(id, patch, storageImpl = globalThis.localStorage) {
  const tasks = readAll(storageImpl);
  const idx = tasks.findIndex((t) => t.id === id);
  if (idx === -1) return null;
  const updated = { ...tasks[idx], ...patch, updatedAt: new Date().toISOString() };
  tasks[idx] = updated;
  writeAll(storageImpl, tasks);
  return updated;
}

export function addTask(task, storageImpl = globalThis.localStorage) {
  const tasks = readAll(storageImpl);
  tasks.push(task);
  writeAll(storageImpl, tasks);
  return task;
}

export function deleteTask(id, storageImpl = globalThis.localStorage) {
  writeAll(storageImpl, readAll(storageImpl).filter((t) => t.id !== id));
}

// --- Dismissals -----------------------------------------------------------
// A dismissed key is permanent-until-cleared: discovery must never re-add it,
// otherwise "delete" is meaningless for auto-detected tasks (they'd reappear
// on the very next scan).

export function loadDismissedKeys(storageImpl = globalThis.localStorage) {
  return readJson(storageImpl, DISMISSED_KEY, []);
}

export function addDismissedKey(key, storageImpl = globalThis.localStorage) {
  const keys = loadDismissedKeys(storageImpl);
  if (!keys.includes(key)) keys.push(key);
  storageImpl.setItem(DISMISSED_KEY, JSON.stringify(keys));
  return keys;
}

export function clearDismissedKeys(storageImpl = globalThis.localStorage) {
  storageImpl.setItem(DISMISSED_KEY, JSON.stringify([]));
}

// --- Discovery watermarks -------------------------------------------------
// { sourceRefKey -> last-seen change signal }. If a candidate's current
// signal matches the stored one, nothing about it has changed since we last
// looked, so it never needs to reach an LLM again — this is the main guard
// against burning tokens re-judging identical Slack threads / sessions on
// every poll.

export function loadWatermarks(storageImpl = globalThis.localStorage) {
  return readJson(storageImpl, WATERMARKS_KEY, {});
}

export function setWatermark(key, signal, storageImpl = globalThis.localStorage) {
  const marks = loadWatermarks(storageImpl);
  marks[key] = signal;
  storageImpl.setItem(WATERMARKS_KEY, JSON.stringify(marks));
  return marks;
}
