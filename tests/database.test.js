// Tests for the local-first database layer
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  initTestDb, closeDb,
  createTask, getTaskById, updateTask, deleteTask,
  getAllTasks, getTaskTree, getChildren,
  batchDelete, batchComplete, batchUpdateStatus,
  countByStatus, getDescendantIds,
} from '../app/database.js';

const TEST_ID = 'test-1';
const TEST_ID_2 = 'test-2';
const TEST_ID_3 = 'test-3';

describe('database', () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeDb();
  });

  describe('createTask', () => {
    it('creates a task with default values', () => {
      const task = createTask({ id: TEST_ID, title: 'My task' });
      expect(task.id).toBe(TEST_ID);
      expect(task.title).toBe('My task');
      expect(task.status).toBe('not_started');
      expect(task.priority).toBe('medium');
      expect(task.estRemaining).toBe('medium');
      expect(task.parentId).toBeNull();
      expect(task.createdAt).toBeTruthy();
      expect(task.updatedAt).toBeTruthy();
    });

    it('creates a task with custom fields', () => {
      const task = createTask({
        id: TEST_ID,
        title: 'Urgent task',
        description: 'Do this now',
        status: 'in_progress',
        priority: 'urgent',
        estRemaining: 'small',
        dueDate: '2026-12-31',
        ballInUsersCourt: true,
      });
      expect(task.status).toBe('in_progress');
      expect(task.priority).toBe('urgent');
      expect(task.description).toBe('Do this now');
      expect(task.dueDate).toBe('2026-12-31');
      expect(task.ballInUsersCourt).toBe(true);
    });
  });

  describe('getTaskById', () => {
    it('returns null for missing task', () => {
      expect(getTaskById('nonexistent')).toBeNull();
    });

    it('returns the task', () => {
      createTask({ id: TEST_ID, title: 'Find me' });
      const task = getTaskById(TEST_ID);
      expect(task.title).toBe('Find me');
    });
  });

  describe('updateTask', () => {
    it('updates task fields', () => {
      createTask({ id: TEST_ID, title: 'Original' });
      const updated = updateTask(TEST_ID, { title: 'Updated', priority: 'high' });
      expect(updated.title).toBe('Updated');
      expect(updated.priority).toBe('high');
      expect(updated.updatedAt).not.toBe(updated.createdAt);
    });

    it('returns null for missing task', () => {
      expect(updateTask('nope', { title: 'x' })).toBeNull();
    });

    it('handles boolean ballInUsersCourt', () => {
      createTask({ id: TEST_ID, title: 'Test' });
      const updated = updateTask(TEST_ID, { ballInUsersCourt: true });
      expect(updated.ballInUsersCourt).toBe(true);
    });
  });

  describe('deleteTask', () => {
    it('deletes a task', () => {
      createTask({ id: TEST_ID, title: 'Delete me' });
      deleteTask(TEST_ID);
      expect(getTaskById(TEST_ID)).toBeNull();
    });

    it('cascades to children', () => {
      createTask({ id: TEST_ID, title: 'Parent' });
      createTask({ id: TEST_ID_2, title: 'Child', parentId: TEST_ID });
      deleteTask(TEST_ID);
      expect(getTaskById(TEST_ID_2)).toBeNull();
    });
  });

  describe('getAllTasks', () => {
    it('returns all non-cancelled tasks ordered by sort_order', () => {
      createTask({ id: TEST_ID, title: 'A', sortOrder: 2 });
      createTask({ id: TEST_ID_2, title: 'B', sortOrder: 1 });
      const tasks = getAllTasks();
      expect(tasks).toHaveLength(2);
      expect(tasks[0].title).toBe('B');
      expect(tasks[1].title).toBe('A');
    });

    it('excludes cancelled tasks', () => {
      createTask({ id: TEST_ID, title: 'Active' });
      createTask({ id: TEST_ID_2, title: 'Cancelled', status: 'cancelled' });
      expect(getAllTasks()).toHaveLength(1);
    });
  });

  describe('parent/child relationships', () => {
    it('createTask with parentId links correctly', () => {
      createTask({ id: TEST_ID, title: 'Parent' });
      createTask({ id: TEST_ID_2, title: 'Child', parentId: TEST_ID });
      const children = getChildren(TEST_ID);
      expect(children).toHaveLength(1);
      expect(children[0].title).toBe('Child');
    });

    it('getTaskTree builds nested structure', () => {
      createTask({ id: TEST_ID, title: 'Root' });
      createTask({ id: TEST_ID_2, title: 'Child', parentId: TEST_ID });
      createTask({ id: TEST_ID_3, title: 'Grandchild', parentId: TEST_ID_2 });
      const tree = getTaskTree();
      expect(tree).toHaveLength(1);
      expect(tree[0].children).toHaveLength(1);
      expect(tree[0].children[0].children).toHaveLength(1);
      expect(tree[0].children[0].children[0].title).toBe('Grandchild');
    });
  });

  describe('getDescendantIds', () => {
    it('returns all descendant IDs', () => {
      createTask({ id: 'r1', title: 'Root' });
      createTask({ id: 'c1', title: 'Child1', parentId: 'r1' });
      createTask({ id: 'c2', title: 'Child2', parentId: 'r1' });
      createTask({ id: 'gc1', title: 'GC1', parentId: 'c1' });
      const ids = getDescendantIds('r1');
      expect(ids.sort()).toEqual(['c1', 'c2', 'gc1'].sort());
    });

    it('returns empty for leaf task', () => {
      createTask({ id: 'leaf', title: 'Leaf' });
      expect(getDescendantIds('leaf')).toEqual([]);
    });
  });

  describe('batch operations', () => {
    it('batchDelete removes multiple tasks', () => {
      createTask({ id: TEST_ID, title: 'A' });
      createTask({ id: TEST_ID_2, title: 'B' });
      batchDelete([TEST_ID, TEST_ID_2]);
      expect(getAllTasks()).toHaveLength(0);
    });

    it('batchComplete marks multiple tasks done', () => {
      createTask({ id: TEST_ID, title: 'A' });
      createTask({ id: TEST_ID_2, title: 'B' });
      batchComplete([TEST_ID, TEST_ID_2]);
      expect(getTaskById(TEST_ID).status).toBe('completed');
      expect(getTaskById(TEST_ID_2).status).toBe('completed');
    });

    it('batchUpdateStatus changes status', () => {
      createTask({ id: TEST_ID, title: 'A', status: 'not_started' });
      createTask({ id: TEST_ID_2, title: 'B', status: 'not_started' });
      batchUpdateStatus([TEST_ID, TEST_ID_2], 'in_progress');
      expect(getTaskById(TEST_ID).status).toBe('in_progress');
    });
  });

  describe('countByStatus', () => {
    it('returns correct counts', () => {
      createTask({ id: TEST_ID, title: 'Active', status: 'in_progress' });
      createTask({ id: TEST_ID_2, title: 'Not started' });
      createTask({ id: TEST_ID_3, title: 'Done', status: 'completed' });
      const counts = countByStatus();
      expect(counts.in_progress).toBe(1);
      expect(counts.not_started).toBe(1);
      expect(counts.completed).toBe(1);
    });
  });
});