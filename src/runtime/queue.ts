import Database from 'better-sqlite3';

export interface JobInput {
  type: string;
  idempotencyKey: string;
  projectId?: string;
  priority?: number;
  payload: unknown;
  maxAttempts?: number;
}

export interface Job {
  id: string;
  type: string;
  idempotencyKey: string;
  projectId?: string;
  priority: number;
  payload: unknown;
  status: 'pending' | 'leased' | 'running' | 'completed' | 'failed';
  attempts: number;
  maxAttempts: number;
  availableAt?: Date;
  leasedAt?: Date;
  leaseExpiresAt?: Date;
  workerId?: string;
  lastError?: string;
  createdAt: Date;
  updatedAt: Date;
}

interface JobRow {
  id: string;
  type: string;
  idempotency_key: string;
  project_id: string | null;
  priority: number;
  payload: string;
  status: string;
  attempts: number;
  max_attempts: number;
  available_at: string | null;
  leased_at: string | null;
  lease_expires_at: string | null;
  worker_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS queue_jobs (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    idempotency_key TEXT NOT NULL UNIQUE,
    project_id TEXT,
    priority INTEGER DEFAULT 0,
    payload TEXT NOT NULL,
    status TEXT DEFAULT 'pending',
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    available_at DATETIME,
    leased_at DATETIME,
    lease_expires_at DATETIME,
    worker_id TEXT,
    last_error TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

export class PersistentQueue {
  private readonly db: Database.Database;
  private readonly workerId: string;

  // Statements
  private readonly insertStmt: Database.Statement;
  private readonly getByIdStmt: Database.Statement;
  private readonly updateStatusStmt: Database.Statement;
  private readonly leaseNextStmt: Database.Statement;
  private readonly releaseExpiredStmt: Database.Statement;
  private readonly statsStmt: Database.Statement;

  constructor(db: Database.Database, workerId: string) {
    this.db = db;
    this.workerId = workerId;

    db.exec(CREATE_TABLE);

    this.insertStmt = db.prepare(`
      INSERT OR IGNORE INTO queue_jobs (
        id, type, idempotency_key, project_id, priority,
        payload, status, attempts, max_attempts, available_at,
        leased_at, lease_expires_at, worker_id, last_error,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getByIdStmt = db.prepare('SELECT * FROM queue_jobs WHERE id = ?');

    this.updateStatusStmt = db.prepare(`
      UPDATE queue_jobs SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `);

    this.leaseNextStmt = db.prepare(`
      UPDATE queue_jobs SET
        status = 'leased',
        worker_id = ?,
        leased_at = CURRENT_TIMESTAMP,
        lease_expires_at = datetime('now', ?),
        updated_at = CURRENT_TIMESTAMP
      WHERE id = (
        SELECT id FROM queue_jobs
        WHERE status = 'pending'
          AND (available_at IS NULL OR available_at <= datetime('now'))
        ORDER BY priority DESC, created_at ASC
        LIMIT 1
      )
      RETURNING *
    `);

    this.releaseExpiredStmt = db.prepare(`
      UPDATE queue_jobs SET
        status = 'pending',
        worker_id = NULL,
        leased_at = NULL,
        lease_expires_at = NULL,
        updated_at = CURRENT_TIMESTAMP
      WHERE status = 'leased' AND lease_expires_at < datetime('now')
    `);

    this.statsStmt = db.prepare(`
      SELECT
        COUNT(CASE WHEN status = 'pending' THEN 1 END) as pending,
        COUNT(CASE WHEN status = 'leased' THEN 1 END) as leased,
        COUNT(CASE WHEN status = 'failed' THEN 1 END) as failed
      FROM queue_jobs
    `);
  }

  /**
   * Enqueue a job. Returns existing if idempotency_key matches (INV-05).
   */
  enqueue(input: JobInput): Job {
    const id = this.generateJobId(input.idempotencyKey, input.type);
    const now = new Date().toISOString();

    // Check if already exists
    const existing = this.getByIdStmt.get(id) as JobRow | undefined;
    if (existing) {
      return this.mapRowToJob(existing);
    }

    this.insertStmt.run(
      id,
      input.type,
      input.idempotencyKey,
      input.projectId ?? null,
      input.priority ?? 0,
      JSON.stringify(input.payload),
      'pending',
      0,
      input.maxAttempts ?? 3,
      null,
      null,
      null,
      null,
      null,
      now,
      now,
    );

    return this.mapRowToJob(this.getByIdStmt.get(id) as JobRow);
  }

  /**
   * Lease the next available job. Returns null if none available.
   */
  leaseNext(leaseSeconds: number): Job | null {
    const row = this.leaseNextStmt.get(
      this.workerId,
      `+${leaseSeconds} seconds`,
    ) as JobRow | undefined;
    return row ? this.mapRowToJob(row) : null;
  }

  /**
   * Mark a job as completed.
   */
  complete(jobId: string): void {
    this.updateStatusStmt.run('completed', jobId);
  }

  /**
   * Mark a job as failed with error message.
   */
  fail(jobId: string, error: string): void {
    const job = this.getRowById(jobId);
    if (!job) return;

    const newAttempts = job.attempts + 1;
    const maxAttempts = job.maxAttempts;

    if (newAttempts >= maxAttempts) {
      this.db.prepare(`
        UPDATE queue_jobs SET
          status = 'failed',
          last_error = ?,
          attempts = ?,
          updated_at = CURRENT_TIMESTAMP,
          worker_id = NULL,
          leased_at = NULL,
          lease_expires_at = NULL
        WHERE id = ?
      `).run(error, newAttempts, jobId);
    } else {
      // Retry: reset to pending with backoff
      this.db.prepare(`
        UPDATE queue_jobs SET
          status = 'pending',
          last_error = ?,
          attempts = ?,
          updated_at = CURRENT_TIMESTAMP,
          worker_id = NULL,
          leased_at = NULL,
          lease_expires_at = NULL,
          available_at = datetime('now', '+10 seconds')
        WHERE id = ?
      `).run(error, newAttempts, jobId);
    }
  }

  /**
   * Release all expired leases. Returns number of released jobs.
   */
  releaseExpiredLeases(): number {
    const result = this.releaseExpiredStmt.run();
    return result.changes;
  }

  /**
   * Get queue statistics.
   */
  stats(): { pending: number; leased: number; failed: number } {
    const row = this.statsStmt.get() as {
      pending: number;
      leased: number;
      failed: number;
    };
    return {
      pending: row.pending,
      leased: row.leased,
      failed: row.failed,
    };
  }

  /**
   * Get a job by ID (for testing).
   */
  getJob(jobId: string): Job | null {
    const row = this.getByIdStmt.get(jobId) as JobRow | undefined;
    return row ? this.mapRowToJob(row) : null;
  }

  private generateJobId(idempotencyKey: string, type: string): string {
    // Simple deterministic ID generation
    let hash = 0;
    const str = `${type}:${idempotencyKey}`;
    for (let i = 0; i < str.length; i++) {
      hash = ((hash << 5) - hash + str.charCodeAt(i)) | 0;
    }
    return `job-${Math.abs(hash).toString(36)}-${Date.now().toString(36)}`;
  }

  private mapRowToJob(row: JobRow): Job {
    return {
      id: row.id,
      type: row.type,
      idempotencyKey: row.idempotency_key,
      projectId: row.project_id ?? undefined,
      priority: row.priority,
      payload: JSON.parse(row.payload),
      status: row.status as Job['status'],
      attempts: row.attempts,
      maxAttempts: row.max_attempts,
      availableAt: row.available_at ? new Date(row.available_at) : undefined,
      leasedAt: row.leased_at ? new Date(row.leased_at) : undefined,
      leaseExpiresAt: row.lease_expires_at ? new Date(row.lease_expires_at) : undefined,
      workerId: row.worker_id ?? undefined,
      lastError: row.last_error ?? undefined,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }

  private getRowById(id: string): Job | null {
    const row = this.getByIdStmt.get(id) as JobRow | undefined;
    return row ? this.mapRowToJob(row) : null;
  }
}
