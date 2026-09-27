import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/runtime/event-store.js';
import { StateMachine } from '../../src/runtime/state-machine.js';
import { PROJECT_TRANSITIONS } from '../../src/runtime/transitions.js';
import { ProjectState } from '../../src/runtime/states.js';
import { ProjectManager } from '../../src/runtime/project-manager.js';

function makeEnvironment(tmpPath: string) {
  const dbPath = path.join(tmpPath, `atomic-test-${Date.now()}.db`);
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

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
  `);

  const eventStore = new EventStore(db);
  const stateMachine = new StateMachine<ProjectState>('project', PROJECT_TRANSITIONS);
  const pm = new ProjectManager(db, eventStore, stateMachine);
  return { db, eventStore, stateMachine, pm };
}

describe('ProjectManager atomic transaction', () => {
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
  });

  afterAll(() => {
    try {
      fs.rmSync(tmpPath, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors on Windows
    }
  });

  it('updateStatus rolls back when transition recording fails', () => {
    const { db, eventStore, pm } = makeEnvironment(tmpPath);

    const project = pm.create({
      name: 'Atomic Rollback Project',
      rootPath: '/tmp/atomic-rollback',
      specificationPath: '/tmp/spec.json',
    });

    const eventCountBefore = eventStore.count();

    // Monkey-patch db.prepare so the transitions INSERT throws
    const originalPrepare = db.prepare.bind(db);
    const origRunMap = new Map<Database.Statement, (...args: unknown[]) => void>();

    db.prepare = ((sql: string, ...args: unknown[]) => {
      const stmt = originalPrepare(sql, ...args);
      if (sql.includes('INSERT INTO transitions')) {
        const origRun = stmt.run.bind(stmt);
        origRunMap.set(stmt, origRun);
        stmt.run = (() => {
          throw new Error('Simulated failure during transition recording');
        }) as Database.Statement['run'];
      }
      return stmt;
    }) as typeof db.prepare;

    expect(() => pm.updateStatus(project.id, ProjectState.ANALYZING)).toThrow(
      'Simulated failure during transition recording',
    );

    // Restore
    db.prepare = originalPrepare;
    for (const [stmt, origRun] of origRunMap) {
      (stmt as unknown as { run: (...args: unknown[]) => void }).run = origRun;
    }

    // Verify rollback: status unchanged
    const updated = pm.get(project.id);
    expect(updated!.status).toBe(ProjectState.CREATED);

    // Verify rollback: event count unchanged
    expect(eventStore.count()).toBe(eventCountBefore);
  });

  it('delete rolls back when transition recording fails', () => {
    const { db, eventStore, pm } = makeEnvironment(tmpPath);

    const project = pm.create({
      name: 'Atomic Delete Project',
      rootPath: '/tmp/atomic-delete',
      specificationPath: '/tmp/spec.json',
    });

    const eventCountBefore = eventStore.count();
    const initialStatus = project.status;

    // Monkey-patch db.prepare so the transitions INSERT throws
    const originalPrepare = db.prepare.bind(db);
    const origRunMap = new Map<Database.Statement, (...args: unknown[]) => void>();

    db.prepare = ((sql: string, ...args: unknown[]) => {
      const stmt = originalPrepare(sql, ...args);
      if (sql.includes('INSERT INTO transitions')) {
        const origRun = stmt.run.bind(stmt);
        origRunMap.set(stmt, origRun);
        stmt.run = (() => {
          throw new Error('Simulated failure during delete transition recording');
        }) as Database.Statement['run'];
      }
      return stmt;
    }) as typeof db.prepare;

    expect(() => pm.delete(project.id)).toThrow(
      'Simulated failure during delete transition recording',
    );

    // Restore
    db.prepare = originalPrepare;
    for (const [stmt, origRun] of origRunMap) {
      (stmt as unknown as { run: (...args: unknown[]) => void }).run = origRun;
    }

    // Verify rollback: status unchanged
    const deleted = pm.get(project.id);
    expect(deleted!.status).toBe(initialStatus);

    // Verify rollback: event count unchanged
    expect(eventStore.count()).toBe(eventCountBefore);
  });

  it('updateStatus appends event with previousStatus and newStatus payload', () => {
    const { eventStore, pm } = makeEnvironment(tmpPath);

    const project = pm.create({
      name: 'Payload Check Project',
      rootPath: '/tmp/payload-check',
      specificationPath: '/tmp/spec.json',
    });

    pm.updateStatus(project.id, ProjectState.ANALYZING);

    const events = eventStore.getByType('project.status_changed');
    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[0];
    expect(lastEvent.payload).toEqual({
      previousStatus: ProjectState.CREATED,
      newStatus: ProjectState.ANALYZING,
    });
  });

  it('delete appends event with projectId and finalStatus payload', () => {
    const { eventStore, pm } = makeEnvironment(tmpPath);

    const project = pm.create({
      name: 'Delete Payload Project',
      rootPath: '/tmp/delete-payload',
      specificationPath: '/tmp/spec.json',
    });

    pm.delete(project.id);

    const events = eventStore.getByType('project.deleted');
    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[0];
    expect(lastEvent.payload).toEqual({
      projectId: project.id,
      finalStatus: ProjectState.CANCELLED,
    });
  });
});
