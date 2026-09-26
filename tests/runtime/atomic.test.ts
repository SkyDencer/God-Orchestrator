import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/runtime/event-store.js';
import { /* StateMachine */ } from '../../src/runtime/state-machine.js';
import { /* PROJECT_TRANSITIONS */ } from '../../src/runtime/transitions.js';
import { ProjectState } from '../../src/runtime/states.js';
import { /* ProjectManager */ } from '../../src/runtime/project-manager.js';
import { atomicTransition } from '../../src/runtime/atomic.js';

describe('Atomic Transition', () => {
  let db: Database.Database;
  let eventStore: EventStore;
  let _stateMachine;
  let tmpPath: string;

  beforeAll(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'atomic-test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');
    eventStore = new EventStore(db);
    // stateMachine = new StateMachine<ProjectState>("project", PROJECT_TRANSITIONS);
  });

  afterAll(() => {
    db.close();
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('atomic transition persists all-or-nothing', () => {
    // Create the projects table
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'CREATED',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS transitions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        triggered_by TEXT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert a project
    db.prepare(
      'INSERT INTO projects (id, name, status) VALUES (?, ?, ?)',
    ).run('proj-test', 'Atomic Test', ProjectState.CREATED);

    // Perform atomic transition
    atomicTransition(db, eventStore, {
      type: 'project.state_changed',
      projectId: 'proj-test',
      fromState: ProjectState.CREATED,
      toState: ProjectState.ANALYZING,
      entityType: 'project',
      entityId: 'proj-test',
      actor: 'system',
      payload: { reason: 'starting analysis' },
    });

    // Debug: check all events
    const allEvents = eventStore.getByProject('proj-test');
    console.log('All events for proj-test:', allEvents.length);
    console.log('Event types:', allEvents.map(e => e.type));

    // Verify all three effects persisted
    const project = db.prepare('SELECT status FROM projects WHERE id = ?').get('proj-test') as { status: string };
    expect(project.status).toBe(ProjectState.ANALYZING);

    // Check all events for this project
    const stateChangeEvents = allEvents.filter(e => e.type === 'project.state_changed');
    expect(stateChangeEvents.length).toBeGreaterThan(0);
    expect(stateChangeEvents[0].projectId).toBe('proj-test');

    const transitions = db.prepare(
      "SELECT * FROM transitions WHERE entity_id = ? ORDER BY timestamp DESC LIMIT 1",
    ).get('proj-test') as { from_state: string; to_state: string } | undefined;
    expect(transitions).toBeDefined();
    expect(transitions!.from_state).toBe(ProjectState.CREATED);
    expect(transitions!.to_state).toBe(ProjectState.ANALYZING);
  });

  it('rollback on error', () => {
    // Create test_entities table
    db.exec(`
      CREATE TABLE IF NOT EXISTS test_entities (
        id TEXT PRIMARY KEY,
        status TEXT DEFAULT 'pending',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    db.prepare('INSERT INTO test_entities (id, status) VALUES (?, ?)').run(
      'entity-fail',
      'pending',
    );

    // Monkey-patch the transaction to throw after event insertion
    const originalTransaction = db.transaction.bind(db);
    let shouldFail = false;
    db.transaction = ((fn: (...args: unknown[]) => unknown) => {
      return (...args: unknown[]) => {
        if (shouldFail) {
          throw new Error('Simulated failure during transaction');
        }
        return originalTransaction(fn)(...args);
      };
    }) as typeof db.transaction;

    // Set up to fail on the state update
    shouldFail = true;

    try {
      atomicTransition(db, eventStore, {
        type: 'test.state_changed',
        fromState: 'pending',
        toState: 'failed',
        entityType: 'test',
        entityId: 'entity-fail',
        actor: 'system',
      });
      expect.fail('Should have thrown');
    } catch (error) {
      expect(error).toBeDefined();
    }

    // Restore transaction
    db.transaction = originalTransaction;

    // Verify nothing was persisted
    const entity = db.prepare('SELECT status FROM test_entities WHERE id = ?').get('entity-fail') as { status: string } | undefined;
    expect(entity!.status).toBe('pending'); // Should still be pending due to rollback
  });
});
