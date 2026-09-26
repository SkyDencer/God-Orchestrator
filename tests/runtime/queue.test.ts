import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { PersistentQueue } from '../../src/runtime/queue.js';

function createTestQueue(workerId = 'worker-1'): { db: Database.Database; queue: PersistentQueue; tmpPath: string } {
  const tmpPath = fs.mkdtempSync(
    path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
  );
  const dbPath = path.join(tmpPath, 'queue-test.db');
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  const queue = new PersistentQueue(db, workerId);
  return { db, queue, tmpPath };
}

describe('PersistentQueue', () => {
  it('creates a job with new idempotency_key', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      const job = queue.enqueue({
        type: 'analyze',
        idempotencyKey: 'key-create',
        projectId: 'proj-1',
        priority: 5,
        payload: { data: 'test' },
        maxAttempts: 3,
      });

      expect(job.id).toBeDefined();
      expect(job.type).toBe('analyze');
      expect(job.idempotencyKey).toBe('key-create');
      expect(job.projectId).toBe('proj-1');
      expect(job.priority).toBe(5);
      expect(job.status).toBe('pending');
      expect(job.attempts).toBe(0);
      expect(job.maxAttempts).toBe(3);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('returns existing job for duplicate idempotency_key', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      const first = queue.enqueue({
        type: 'analyze',
        idempotencyKey: 'key-dup',
        payload: { data: 'first' },
      });

      const second = queue.enqueue({
        type: 'analyze',
        idempotencyKey: 'key-dup',
        payload: { data: 'duplicate' },
      });

      expect(first.id).toBe(second.id);
      expect(first.payload).toEqual({ data: 'first' });
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('leaseNext returns oldest pending job', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      queue.enqueue({ type: 'job-a', idempotencyKey: 'lease-a', payload: {} });
      queue.enqueue({ type: 'job-b', idempotencyKey: 'lease-b', payload: {} });

      const leased = queue.leaseNext(60);
      expect(leased).not.toBeNull();
      expect(leased!.status).toBe('leased');
      expect(leased!.workerId).toBe('worker-1');
      expect(leased!.idempotencyKey).toBe('lease-a'); // Oldest first
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('leaseNext skips future availableAt', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      queue.enqueue({
        type: 'future-job',
        idempotencyKey: 'future-job',
        payload: {},
      });

      // Set available_at in the future
      db.prepare(`
        UPDATE queue_jobs SET available_at = datetime('now', '+1 day')
        WHERE idempotency_key = ?
      `).run('future-job');

      const leased = queue.leaseNext(60);
      expect(leased).toBeNull();
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('complete marks job as completed', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      const _job = queue.enqueue({
        type: 'complete-test',
        idempotencyKey: 'complete-job',
        payload: {},
      });

      const leased = queue.leaseNext(60);
      expect(leased).not.toBeNull();
      expect(leased!.status).toBe('leased');

      queue.complete(leased!.id);

      const completed = queue.getJob(leased!.id);
      expect(completed!.status).toBe('completed');
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('fail increments attempts and fails at maxAttempts', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      const job = queue.enqueue({
        type: 'fail-test',
        idempotencyKey: 'fail-max',
        payload: {},
        maxAttempts: 2,
      });

      queue.leaseNext(60);
      queue.fail(job.id, 'error-1');

      const afterFirstFail = queue.getJob(job.id);
      expect(afterFirstFail!.status).toBe('pending'); // Retry
      expect(afterFirstFail!.attempts).toBe(1);

      queue.leaseNext(60);
      queue.fail(job.id, 'error-2');

      const afterSecondFail = queue.getJob(job.id);
      expect(afterSecondFail!.status).toBe('failed');
      expect(afterSecondFail!.attempts).toBe(2);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('expired leases are released and re-leasable', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      const job = queue.enqueue({
        type: 'expire-test',
        idempotencyKey: 'expire-job',
        payload: {},
      });

      // Lease with already-expired time
      db.prepare(`
        UPDATE queue_jobs SET
          status = 'leased',
          worker_id = 'worker-1',
          leased_at = datetime('now', '-1 hour'),
          lease_expires_at = datetime('now', '-1 second'),
          updated_at = datetime('now')
        WHERE idempotency_key = ?
      `).run('expire-job');

      const released = queue.releaseExpiredLeases();
      expect(released).toBeGreaterThan(0);

      const refreshed = queue.getJob(job.id);
      expect(refreshed!.status).toBe('pending');

      // Should be re-leasable
      const reLeased = queue.leaseNext(60);
      expect(reLeased).not.toBeNull();
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('concurrent leases do not double-lease', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      const batchSize = 5;
      for (let i = 0; i < batchSize; i++) {
        queue.enqueue({
          type: 'concurrent',
          idempotencyKey: `conc-${i}`,
          payload: {},
        });
      }

      const leasedJobs = new Set<string>();
      for (let i = 0; i < batchSize; i++) {
        const job = queue.leaseNext(60);
        expect(job).not.toBeNull();
        leasedJobs.add(job!.id);
      }

      expect(leasedJobs.size).toBe(batchSize);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });

  it('stats reflect correct counts', () => {
    const { db, queue, tmpPath } = createTestQueue();
    try {
      queue.enqueue({ type: 'stat-test', idempotencyKey: 'stat-1', payload: {} });
      queue.enqueue({ type: 'stat-test', idempotencyKey: 'stat-2', payload: {} });

      queue.leaseNext(60);
      queue.leaseNext(60);

      const stats = queue.stats();
      expect(stats.pending).toBe(0);
      expect(stats.leased).toBe(2);
      expect(stats.failed).toBe(0);
    } finally {
      db.close();
      fs.rmSync(tmpPath, { recursive: true, force: true });
    }
  });
});
