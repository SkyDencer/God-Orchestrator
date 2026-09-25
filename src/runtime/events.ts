/**
 * Input shape for appending an event.
 */
export interface EventInput {
  type: string;
  projectId?: string;
  entityType?: string;
  entityId?: string;
  actor: string;
  payload: unknown;
  correlationId?: string;
  causationId?: string;
}

/**
 * A persisted event with system-generated fields.
 */
export interface StoredEvent extends EventInput {
  id: string;
  createdAt: Date;
}
