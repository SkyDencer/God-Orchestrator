import Database from 'better-sqlite3';
import { EventInput, StoredEvent } from './events.js';
import { generateId } from './id.js';

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS events_store (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    project_id TEXT,
    entity_type TEXT,
    entity_id TEXT,
    actor TEXT NOT NULL,
    payload TEXT NOT NULL,
    correlation_id TEXT,
    causation_id TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`;

const INDEXES = `
  CREATE INDEX IF NOT EXISTS idx_events_project ON events_store(project_id);
  CREATE INDEX IF NOT EXISTS idx_events_type ON events_store(type);
  CREATE INDEX IF NOT EXISTS idx_events_correlation ON events_store(correlation_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events_store(created_at);
`;

export class EventStore {
  private readonly db: Database.Database;
  private readonly insertStmt: Database.Statement;
  private readonly getByProjectStmt: Database.Statement;
  private readonly getByTypeStmt: Database.Statement;
  private readonly getByCorrelationStmt: Database.Statement;
  private readonly countStmt: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.db.exec(CREATE_TABLE);
    this.db.exec(INDEXES);

    this.insertStmt = db.prepare(`
      INSERT INTO events_store (
        id, type, project_id, entity_type, entity_id,
        actor, payload, correlation_id, causation_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.getByProjectStmt = db.prepare(`
      SELECT * FROM events_store WHERE project_id = ? ORDER BY created_at DESC
    `);

    this.getByTypeStmt = db.prepare(`
      SELECT * FROM events_store WHERE type = ? ORDER BY created_at DESC
    `);

    this.getByCorrelationStmt = db.prepare(`
      SELECT * FROM events_store WHERE correlation_id = ? ORDER BY created_at
    `);

    this.countStmt = db.prepare('SELECT COUNT(*) as count FROM events_store');
  }

  /**
   * Append an event atomically. Returns the stored event.
   */
  append(input: EventInput): StoredEvent {
    const id = generateId();
    const now = new Date();
    const payloadJson = JSON.stringify(input.payload);
    const correlationId = input.correlationId ?? generateId();

    this.insertStmt.run(
      id,
      input.type,
      input.projectId ?? null,
      input.entityType ?? null,
      input.entityId ?? null,
      input.actor,
      payloadJson,
      correlationId,
      input.causationId ?? null,
      now.toISOString(),
    );

    return {
      id,
      type: input.type,
      projectId: input.projectId,
      entityType: input.entityType,
      entityId: input.entityId,
      actor: input.actor,
      payload: input.payload,
      correlationId,
      causationId: input.causationId,
      createdAt: now,
    };
  }

  /**
   * Get events for a project, ordered newest first.
   */
  getByProject(projectId: string, limit?: number): StoredEvent[] {
    if (limit !== undefined && limit > 0) {
      const rows = this.getByProjectStmt.all(projectId, limit) as StoredEvent[];
      return rows.map((r) => this.mapRowToStoredEvent(r));
    }
    const rows = this.getByProjectStmt.all(projectId) as StoredEvent[];
    return rows.map((r) => this.mapRowToStoredEvent(r));
  }

  /**
   * Get events by type, ordered newest first.
   */
  getByType(type: string, limit?: number): StoredEvent[] {
    if (limit !== undefined && limit > 0) {
      const rows = this.getByTypeStmt.all(type, limit) as StoredEvent[];
      return rows.map((r) => this.mapRowToStoredEvent(r));
    }
    const rows = this.getByTypeStmt.all(type) as StoredEvent[];
    return rows.map((r) => this.mapRowToStoredEvent(r));
  }

  /**
   * Get events by correlation ID, ordered oldest first.
   */
  getByCorrelation(correlationId: string): StoredEvent[] {
    const rows = this.getByCorrelationStmt.all(correlationId) as StoredEvent[];
    return rows.map((r) => this.mapRowToStoredEvent(r));
  }

  /**
   * Count all stored events.
   */
  count(): number {
    const row = this.countStmt.get() as { count: number };
    return row.count;
  }

  private mapRowToStoredEvent(row: Record<string, unknown> | StoredEvent): StoredEvent {
    const r = row as Record<string, unknown>;
    return {
      id: r.id as string,
      type: r.type as string,
      projectId: r.project_id as string | undefined,
      entityType: r.entity_type as string | undefined,
      entityId: r.entity_id as string | undefined,
      actor: r.actor as string,
      payload: JSON.parse(r.payload as string),
      correlationId: r.correlation_id as string | undefined,
      causationId: r.causation_id as string | undefined,
      createdAt: new Date(r.created_at as string),
    };
  }
}
