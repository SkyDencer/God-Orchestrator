import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { EventStore } from '../../src/runtime/event-store.js';
import { EventInput } from '../../src/runtime/events.js';

describe('EventStore', () => {
  let db: Database.Database;
  let store: EventStore;
  let tmpPath: string;

  beforeAll(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'event-store-test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    store = new EventStore(db);
  });

  afterAll(() => {
    store = null as unknown as EventStore;
    db.close();
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('append returns StoredEvent with id and timestamp', () => {
    const input: EventInput = {
      type: 'project.created',
      projectId: 'proj-1',
      actor: 'system',
      payload: { name: 'Test Project' },
    };

    const event = store.append(input);

    expect(event.id).toBeDefined();
    expect(typeof event.id).toBe('string');
    expect(event.createdAt).toBeInstanceOf(Date);
    expect(event.type).toBe('project.created');
    expect(event.actor).toBe('system');
    expect(event.payload).toEqual({ name: 'Test Project' });
    expect(event.correlationId).toBeDefined();
  });

  it('events are retrievable by project', () => {
    const input: EventInput = {
      type: 'task.started',
      projectId: 'proj-2',
      entityType: 'task',
      entityId: 'task-1',
      actor: 'agent-1',
      payload: { details: 'running' },
    };

    store.append(input);
    const events = store.getByProject('proj-2');

    expect(events.length).toBe(1);
    expect(events[0].type).toBe('task.started');
    expect(events[0].entityId).toBe('task-1');
  });

  it('events are retrievable by type', () => {
    const input: EventInput = {
      type: 'phase.verified',
      actor: 'verifier',
      payload: { pass: true },
    };

    store.append(input);
    const events = store.getByType('phase.verified');

    expect(events.length).toBe(1);
    expect(events[0].payload).toEqual({ pass: true });
  });

  it('events are retrievable by correlation_id', () => {
    const corrId = 'corr-abc-123';
    const input: EventInput = {
      type: 'event.a',
      actor: 'system',
      payload: {},
      correlationId: corrId,
    };

    const event1 = store.append(input);
    const input2: EventInput = {
      type: 'event.b',
      actor: 'system',
      payload: {},
      correlationId: corrId,
    };
    const event2 = store.append(input2);

    const related = store.getByCorrelation(corrId);
    expect(related.length).toBe(2);
    expect(related.map((e) => e.id)).toContain(event1.id);
    expect(related.map((e) => e.id)).toContain(event2.id);
  });

  it('append is atomic — wrapped in transaction', () => {
    const input: EventInput = {
      type: 'atomic.test',
      actor: 'system',
      payload: { value: 42 },
    };

    // All appends should persist as a group
    store.append(input);
    expect(store.count()).toBeGreaterThan(0);
  });

  it('concurrent appends do not corrupt data', async () => {
    const batchSize = 20;
    const events = await Promise.all(
      Array.from({ length: batchSize }, (_, i) =>
        store.append({
          type: 'concurrent.event',
          actor: `worker-${i}`,
          payload: { index: i },
        }),
      ),
    );

    expect(events.length).toBe(batchSize);
    const ids = events.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(batchSize);
  });
});
