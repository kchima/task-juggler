// Tests for the local-first server API
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import { initTestDb, closeDb, createTask } from '../app/database.js';
import express from 'express';

// We need to mount the routes on a fresh express app,
// importing from server.js will start listening which we don't want.
// Instead, let's set up the API routes directly.
function buildTestApp() {
  const app = express();
  app.use(express.json());

  // Import and mount the router from server.js
  // Actually, let's replicate the routes here for isolation
  const { app: serverApp } = require_dynamic('../app/server.js');
  return serverApp;
}

// Since server.js exports the app, we can just import it.
// But it also has the static file serving. Let's just import the app.
import { app } from '../app/server.js';

describe('Server API', () => {
  beforeEach(() => {
    initTestDb();
  });

  afterEach(() => {
    closeDb();
  });

  describe('GET /api/health', () => {
    it('returns healthy status', async () => {
      const res = await request(app).get('/api/health');
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('ok');
    });
  });

  describe('GET /api/tasks', () => {
    it('returns empty list initially', async () => {
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body.tasks).toEqual([]);
      expect(res.body.counts).toBeDefined();
    });

    it('returns created tasks', async () => {
      createTask({ id: 't1', title: 'Test task' });
      const res = await request(app).get('/api/tasks');
      expect(res.status).toBe(200);
      expect(res.body.tasks).toHaveLength(1);
      expect(res.body.tasks[0].title).toBe('Test task');
    });
  });

  describe('GET /api/tasks/tree', () => {
    it('returns nested tree', async () => {
      createTask({ id: 'root', title: 'Root' });
      createTask({ id: 'child', title: 'Child', parentId: 'root' });
      const res = await request(app).get('/api/tasks/tree');
      expect(res.status).toBe(200);
      expect(res.body.tree).toHaveLength(1);
      expect(res.body.tree[0].children).toHaveLength(1);
    });
  });

  describe('POST /api/tasks', () => {
    it('creates a task', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'New task', priority: 'high' });
      expect(res.status).toBe(201);
      expect(res.body.task.title).toBe('New task');
      expect(res.body.task.priority).toBe('high');
      expect(res.body.task.id).toBeTruthy();
    });

    it('rejects empty title', async () => {
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: '' });
      expect(res.status).toBe(400);
    });

    it('creates subtask with parentId', async () => {
      createTask({ id: 'parent', title: 'Parent' });
      const res = await request(app)
        .post('/api/tasks')
        .send({ title: 'Subtask', parentId: 'parent' });
      expect(res.status).toBe(201);
      expect(res.body.task.parentId).toBe('parent');
    });
  });

  describe('PATCH /api/tasks/:id', () => {
    it('updates a task', async () => {
      createTask({ id: 't1', title: 'Original' });
      const res = await request(app)
        .patch('/api/tasks/t1')
        .send({ title: 'Updated', status: 'in_progress' });
      expect(res.status).toBe(200);
      expect(res.body.task.title).toBe('Updated');
      expect(res.body.task.status).toBe('in_progress');
    });

    it('returns 404 for missing task', async () => {
      const res = await request(app)
        .patch('/api/tasks/nope')
        .send({ title: 'x' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/tasks/:id', () => {
    it('deletes a task', async () => {
      createTask({ id: 't1', title: 'Delete me' });
      const res = await request(app).delete('/api/tasks/t1');
      expect(res.status).toBe(204);
    });
  });

  describe('POST /api/tasks/batch', () => {
    it('deletes multiple tasks', async () => {
      createTask({ id: 'a', title: 'A' });
      createTask({ id: 'b', title: 'B' });
      const res = await request(app)
        .post('/api/tasks/batch')
        .send({ ids: ['a', 'b'], action: 'delete' });
      expect(res.status).toBe(200);
      expect(res.body.affected).toBe(2);
    });

    it('completes multiple tasks', async () => {
      createTask({ id: 'a', title: 'A' });
      createTask({ id: 'b', title: 'B' });
      const res = await request(app)
        .post('/api/tasks/batch')
        .send({ ids: ['a', 'b'], action: 'complete' });
      expect(res.status).toBe(200);
    });

    it('rejects missing action', async () => {
      const res = await request(app)
        .post('/api/tasks/batch')
        .send({ ids: ['a'], action: 'unknown' });
      expect(res.status).toBe(400);
    });
  });
});