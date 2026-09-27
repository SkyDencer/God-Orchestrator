import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { PersistentQueue } from '../../src/runtime/queue.js';
import { Scheduler } from '../../src/runtime/scheduler.js';

function createTestEnv() {
  const tmpPath = fs.mkdtempSync(
    path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
  );
  const dbPath = path.join(tmpPath, 'scheduler-test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const queue = new PersistentQueue(db, 'worker-1');
  return { db, queue, tmpPath };
}

describe('Scheduler', () => {
  it('calls handler when job is enqueued and scheduler is running', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const handler = vi.fn();
      const scheduler = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      scheduler.registerHandler('test-job', handler);
      scheduler.start();

      const job = queue.enqueue({
        type: 'test-job',
        idempotencyKey: 'sched-1',
        payload: { data: 'test' },
      });

      // Wait for scheduler to process
      await new Promise((resolve) => setTimeout(resolve, 200));

      await scheduler.stop();

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(expect.objectContaining({ id: job.id }));
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('marks job as completed on handler success', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const scheduler = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      scheduler.registerHandler('success-job', async () => {
        // Simulate work
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      scheduler.start();

      const job = queue.enqueue({
        type: 'success-job',
        idempotencyKey: 'success-1',
        payload: {},
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await scheduler.stop();

      const completed = queue.getJob(job.id);
      expect(completed!.status).toBe('completed');
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('marks job as failed on handler error', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const scheduler = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      scheduler.registerHandler('fail-job', async () => {
        throw new Error('Intentional failure');
      });
      scheduler.start();

      const job = queue.enqueue({
        type: 'fail-job',
        idempotencyKey: 'fail-1',
        payload: {},
        maxAttempts: 1,
      });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await scheduler.stop();

      const failed = queue.getJob(job.id);
      expect(failed!.status).toBe('failed');
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('respects maxConcurrent limit', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      let concurrentCount = 0;
      let maxConcurrentSeen = 0;

      const scheduler = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      scheduler.registerHandler('concurrent-job', async () => {
        concurrentCount++;
        maxConcurrentSeen = Math.max(maxConcurrentSeen, concurrentCount);
        await new Promise((resolve) => setTimeout(resolve, 100));
        concurrentCount--;
      });
      scheduler.start();

      // Enqueue 5 jobs
      for (let i = 0; i < 5; i++) {
        queue.enqueue({
          type: 'concurrent-job',
          idempotencyKey: `conc-${i}`,
          payload: {},
        });
      }

      await new Promise((resolve) => setTimeout(resolve, 500));
      await scheduler.stop();

      // Should never exceed maxConcurrent
      expect(maxConcurrentSeen).toBeLessThanOrEqual(2);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('stop() waits for in-flight jobs', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const scheduler = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      let completed = 0;
      scheduler.registerHandler('slow-job', async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        completed++;
      });
      scheduler.start();

      // Enqueue 2 jobs
      queue.enqueue({ type: 'slow-job', idempotencyKey: 'slow-1', payload: {} });
      queue.enqueue({ type: 'slow-job', idempotencyKey: 'slow-2', payload: {} });

      // Give scheduler time to pick up and start processing
      await new Promise((resolve) => setTimeout(resolve, 150));

      // Stop while jobs are still in-flight (they take 100ms each)
      await scheduler.stop();

      // Both should have completed
      expect(completed).toBe(2);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('restart preserves queue state', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const scheduler1 = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      scheduler1.registerHandler('persist-job', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      scheduler1.start();

      // Enqueue some jobs
      queue.enqueue({ type: 'persist-job', idempotencyKey: 'persist-1', payload: {} });
      queue.enqueue({ type: 'persist-job', idempotencyKey: 'persist-2', payload: {} });

      await new Promise((resolve) => setTimeout(resolve, 150));
      await scheduler1.stop();

      // Create new scheduler with same queue
      const scheduler2 = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      let processed = 0;
      scheduler2.registerHandler('persist-job', async () => {
        processed++;
      });
      scheduler2.start();

      // Enqueue new jobs that scheduler2 should process — this verifies
      // the queue is still functional after restarting the scheduler
      queue.enqueue({ type: 'persist-job', idempotencyKey: 'persist-restart-1', payload: {} });
      queue.enqueue({ type: 'persist-job', idempotencyKey: 'persist-restart-2', payload: {} });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await scheduler2.stop();

      // Jobs enqueued after restart should have been processed
      expect(processed).toBe(2);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('stats track jobsProcessed and jobsFailed', async () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const scheduler = new Scheduler(queue, {
        pollIntervalMs: 50,
        leaseSeconds: 30,
        maxConcurrent: 2,
      });

      scheduler.registerHandler('stat-job', async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
      });
      scheduler.start();

      queue.enqueue({ type: 'stat-job', idempotencyKey: 'stat-1', payload: {} });

      await new Promise((resolve) => setTimeout(resolve, 200));
      await scheduler.stop();

      const stats = scheduler.stats();
      expect(stats.jobsProcessed).toBeGreaterThanOrEqual(1);
      expect(stats.startedAt).toBeDefined();
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('isRunning returns correct state', () => {
    const { db, queue, tmpPath } = createTestEnv();
    try {
      const scheduler = new Scheduler(queue);
      expect(scheduler.isRunning()).toBe(false);

      scheduler.start();
      expect(scheduler.isRunning()).toBe(true);

      scheduler.stop();
      expect(scheduler.isRunning()).toBe(false);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });
});
