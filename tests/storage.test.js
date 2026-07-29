import { describe, it, expect, beforeEach } from 'vitest';
import { loadTasks, saveTasks, patchTask, addTask, deleteTask } from '../src/storage.js';

beforeEach(() => {
  localStorage.clear();
});

describe('storage interface', () => {
  it('loadTasks returns an empty array when nothing is stored', () => {
    expect(loadTasks()).toEqual([]);
  });

  it('addTask then loadTasks round-trips', () => {
    const task = { id: '1', title: 'Ship the release' };
    addTask(task);
    expect(loadTasks()).toEqual([task]);
  });

  it('saveTasks overwrites the full list', () => {
    addTask({ id: '1', title: 'a' });
    saveTasks([{ id: '2', title: 'b' }]);
    expect(loadTasks()).toEqual([{ id: '2', title: 'b' }]);
  });

  it('patchTask merges fields and bumps updatedAt', () => {
    addTask({ id: '1', title: 'a', status: 'not_started', updatedAt: '2020-01-01T00:00:00.000Z' });
    const patched = patchTask('1', { status: 'in_progress' });
    expect(patched.status).toBe('in_progress');
    expect(patched.title).toBe('a');
    expect(patched.updatedAt).not.toBe('2020-01-01T00:00:00.000Z');
    expect(loadTasks()[0].status).toBe('in_progress');
  });

  it('patchTask returns null for an unknown id', () => {
    expect(patchTask('missing', { status: 'in_progress' })).toBeNull();
  });

  it('deleteTask removes only the matching task', () => {
    addTask({ id: '1', title: 'a' });
    addTask({ id: '2', title: 'b' });
    deleteTask('1');
    expect(loadTasks().map((t) => t.id)).toEqual(['2']);
  });

  it('loadTasks recovers gracefully from corrupted JSON', () => {
    localStorage.setItem('task-juggler:tasks:v1', '{not valid json');
    expect(loadTasks()).toEqual([]);
  });

  it('loadTasks recovers gracefully from a stored non-array value', () => {
    localStorage.setItem('task-juggler:tasks:v1', JSON.stringify({ not: 'an array' }));
    expect(loadTasks()).toEqual([]);
  });

  it('supports an injected storage implementation instead of the global', () => {
    const fake = (() => {
      const map = new Map();
      return {
        getItem: (k) => (map.has(k) ? map.get(k) : null),
        setItem: (k, v) => map.set(k, v),
      };
    })();
    addTask({ id: '1', title: 'a' }, fake);
    expect(loadTasks(fake)).toEqual([{ id: '1', title: 'a' }]);
    expect(loadTasks()).toEqual([]);
  });
});
