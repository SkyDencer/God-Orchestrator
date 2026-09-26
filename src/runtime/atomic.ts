import Database from 'better-sqlite3';
import { EventStore } from './event-store.js';
import { EventInput } from './events.js';

export interface Transition {
  type: string;
  fromState: string;
  toState: string;
  entityType: string;
  entityId: string;
  actor: string;
  projectId?: string;
  payload?: Record<string, unknown>;
  /** Optional custom table name; defaults to `${entityType}s` */
  tableName?: string;
}

/**
 * Perform an atomic state transition:
 * 1. BEGIN TRANSACTION
 * 2. Insert event
 * 3. Update entity state
 * 4. Insert transition record
 * 5. COMMIT
 *
 * If any step fails, the entire transaction is rolled back.
 */
export function atomicTransition(
  db: Database.Database,
  eventStore: EventStore,
  transition: Transition,
): void {
  const tx = db.transaction(() => {
    // Step 1: Append event to event store
    const eventInput: EventInput = {
      type: transition.type,
      projectId: transition.projectId,
      entityId: transition.entityId,
      entityType: transition.entityType,
      actor: transition.actor,
      payload: transition.payload ?? {},
    };
    eventStore.append(eventInput);

    // Step 2: Update entity state in the appropriate table
    // Use dynamic table name based on entity type, or custom tableName if provided
    const tableName = transition.tableName ?? `${transition.entityType}s`;
    const updateSql = `
      UPDATE ${tableName}
      SET status = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `;
    db.prepare(updateSql).run(transition.toState, transition.entityId);

    // Step 3: Record the transition
    db.prepare(`
      INSERT INTO transitions (from_state, to_state, entity_type, entity_id, triggered_by, timestamp)
      VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    `).run(
      transition.fromState,
      transition.toState,
      transition.entityType,
      transition.entityId,
      transition.actor,
    );
  });

  tx();
}
