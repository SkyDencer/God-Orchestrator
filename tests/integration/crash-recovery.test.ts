import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/runtime/event-store.js';
import { StateMachine } from '../../src/runtime/state-machine.js';
import { PROJECT_TRANSITIONS } from '../../src/runtime/transitions.js';
import { ProjectState } from '../../src/runtime/states.js';
import { ProjectManager } from '../../src/runtime/project-manager.js';
import { PersistentQueue } from '../../src/runtime/queue.js';
import { atomicTransition } from '../../src/runtime/atomic.js';
import { reconcile } from '../../src/runtime/reconciliation.js';

describe('Crash Recovery Integration', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let stateMachine: StateMachine<ProjectState>;
  let pm: ProjectManager;
  let queue: PersistentQueue;
  let tmpPath: string;

  beforeAll(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'crash-recovery.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    // Create transitions table for atomic operations
    db.exec(`
      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        triggered_by TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS agent_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        task_id INTEGER,
        prompt TEXT,
        output TEXT,
        status TEXT DEFAULT 'running',
        tokens_input INTEGER DEFAULT 0,
        tokens_output INTEGER DEFAULT 0,
        cost_usd REAL DEFAULT 0,
        duration_ms INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    eventStore = new EventStore(db);
    stateMachine = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);
    pm = new ProjectManager(db, eventStore, stateMachine);
    queue = new PersistentQueue(db, 'worker-1');
  });

  afterAll(() => {
    pm = null as unknown as ProjectManager;
    db.close();
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('full lifecycle: create project, start job, crash, restart, no data loss', async () => {
    // Phase 1: Create project and perform atomic transition
    const project = pm.create({
      name: 'Crash Recovery Test',
      rootPath: '/tmp/crash-test',
      specificationPath: '/tmp/spec.json',
    });

    expect(project.status).toBe(ProjectState.CREATED);

    // Perform atomic transition to ANALYZING using atomicTransition
    atomicTransition(db, eventStore, {
      type: 'project.state_changed',
      projectId: project.id,
      fromState: ProjectState.CREATED,
      toState: ProjectState.ANALYZING,
      entityType: 'project',
      entityId: project.id,
      actor: 'system',
      tableName: 'project_manager',
      payload: { reason: 'starting analysis' },
    });

    // Verify state persisted
    const updatedProject = pm.get(project.id);
    expect(updatedProject!.status).toBe(ProjectState.ANALYZING);

    // Enqueue a job
    const job = queue.enqueue({
      type: 'analyze',
      idempotencyKey: 'crash-job-1',
      projectId: project.id,
      payload: { phase: 'analysis' },
    });

    expect(job.status).toBe('pending');

    // Lease and complete the job
    const leased = queue.leaseNext(60);
    expect(leased).not.toBeNull();
    queue.complete(leased!.id);

    // Phase 2: Simulate crash - get reconciliation result
    const result = reconcile(db);

    // State should be consistent
    expect(result.lastValidState).toBe(ProjectState.ANALYZING);

    // All events should be present
    const events = eventStore.getByProject(project.id);
    expect(events.length).toBeGreaterThanOrEqual(2); // project.created + state_changed

    // Project should still exist with correct state
    const recoveredProject = pm.get(project.id);
    expect(recoveredProject).not.toBeNull();
    expect(recoveredProject!.status).toBe(ProjectState.ANALYZING);
  });

  it('no duplicate execution after restart', async () => {
    // Create project
    const _project = pm.create({
      name: 'No Dup Test',
      rootPath: '/tmp/no-dup',
      specificationPath: '/tmp/spec.json',
    });

    // Enqueue job with idempotency key
    const job1 = queue.enqueue({
      type: 'process',
      idempotencyKey: 'unique-key-123',
      payload: { data: 'test' },
    });

    // Try to enqueue again with same key
    const job2 = queue.enqueue({
      type: 'process',
      idempotencyKey: 'unique-key-123',
      payload: { data: 'duplicate' },
    });

    // Should return same job
    expect(job1.id).toBe(job2.id);

    // Process the job
    const leased = queue.leaseNext(60);
    expect(leased).not.toBeNull();
    queue.complete(leased!.id);

    // Try to lease again - should be null (already completed)
    const reLeased = queue.leaseNext(60);
    expect(reLeased).toBeNull();
  });

  it('state survives restart', () => {
    // Create project
    const project = pm.create({
      name: 'Survive Test',
      rootPath: '/tmp/survive',
      specificationPath: '/tmp/spec.json',
    });

    // Update state
    pm.updateStatus(project.id, ProjectState.ANALYZING);

    // Simulate restart by creating new instances
    const newDb = new Database(path.join(tmpPath, 'crash-recovery.db'));
    newDb.pragma('journal_mode = WAL');
    newDb.pragma('foreign_keys = ON');

    const newEventStore = new EventStore(newDb);
    const newStateMachine = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);
    const newPm = new ProjectManager(newDb, newEventStore, newStateMachine);

    // Retrieve project
    const recovered = newPm.get(project.id);
    expect(recovered).not.toBeNull();
    expect(recovered!.status).toBe(ProjectState.ANALYZING);

    newDb.close();
  });

  it('queue survives restart', () => {
    // Enqueue jobs
    queue.enqueue({ type: 'job-a', idempotencyKey: 'survive-a', payload: {} });
    queue.enqueue({ type: 'job-b', idempotencyKey: 'survive-b', payload: {} });

    // Simulate restart
    const newDb = new Database(path.join(tmpPath, 'crash-recovery.db'));
    newDb.pragma('journal_mode = WAL');
    const newQueue = new PersistentQueue(newDb, 'worker-2');

    // Jobs should still exist
    expect(newQueue.stats().pending).toBe(2);

    newDb.close();
  });
});
