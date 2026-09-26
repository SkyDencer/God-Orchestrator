import Database from 'better-sqlite3';
import { ProjectState } from './states.js';

export interface ReconciliationResult {
  staleRuns: number;
  orphanedPhases: number;
  uncommittedChanges: number;
  lastValidState: string | null;
  recommendedAction: 'resume' | 'retry' | 'verify' | 'block';
  reasoning: string;
}

/**
 * Reconcile the database state after a crash.
 * Detects stale agent runs, orphaned phases, and uncommitted changes.
 */
export function reconcile(db: Database.Database): ReconciliationResult {
  const staleRuns = countStaleRuns(db);
  const orphanedPhases = countOrphanedPhases(db);
  const uncommittedChanges = countUncommittedChanges(db);
  const lastValidState = getLastValidState(db);

  let recommendedAction: ReconciliationResult['recommendedAction'];
  let reasoning: string;

  if (staleRuns > 0 && uncommittedChanges > 0) {
    recommendedAction = 'block';
    reasoning = `Found ${staleRuns} stale runs and ${uncommittedChanges} uncommitted changes. Recommend blocking until manual review resolves both issues.`;
  } else if (staleRuns > 0) {
    recommendedAction = 'retry';
    reasoning = `Found ${staleRuns} stale agent runs. Recommend retrying failed jobs.`;
  } else if (orphanedPhases > 0) {
    recommendedAction = 'verify';
    reasoning = `Found ${orphanedPhases} orphaned phases without active runs. Recommend manual verification.`;
  } else if (uncommittedChanges > 0) {
    recommendedAction = 'verify';
    reasoning = `Found ${uncommittedChanges} uncommitted changes. Recommend review before resuming.`;
  } else if (lastValidState === ProjectState.FAILED) {
    recommendedAction = 'retry';
    reasoning = 'Last valid state is FAILED. Recommend retrying from the last known good state.';
  } else if (lastValidState === ProjectState.BLOCKED) {
    recommendedAction = 'verify';
    reasoning = 'Last valid state is BLOCKED. Recommend investigating blockers before resuming.';
  } else if (lastValidState === ProjectState.RUNNING) {
    recommendedAction = 'resume';
    reasoning = 'Last valid state is RUNNING. Safe to resume operations.';
  } else if (lastValidState === ProjectState.COMPLETED) {
    recommendedAction = 'resume';
    reasoning = 'Last valid state is COMPLETED. Project is finished.';
  } else {
    recommendedAction = 'resume';
    reasoning = 'No stale or orphaned items found. Database is in a consistent state.';
  }

  return {
    staleRuns,
    orphanedPhases,
    uncommittedChanges,
    lastValidState,
    recommendedAction,
    reasoning,
  };
}

function countStaleRuns(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM agent_runs
      WHERE status = 'running'
        AND updated_at < datetime('now', '-5 minutes')
    `).get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

function countOrphanedPhases(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM phases
      WHERE status = 'RUNNING'
        AND NOT EXISTS (
          SELECT 1 FROM agent_runs ar
          WHERE ar.task_id = phases.id AND ar.status = 'running'
        )
    `).get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

function countUncommittedChanges(db: Database.Database): number {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) as count
      FROM transitions t
      WHERE NOT EXISTS (
        SELECT 1 FROM events_store e
        WHERE e.entity_id = t.entity_id
          AND e.type LIKE '%.state_changed%'
      )
    `).get() as { count: number };
    return row.count;
  } catch {
    return 0;
  }
}

function getLastValidState(db: Database.Database): string | null {
  // Query both possible project tables
  try {
    const pmRow = db.prepare(`
      SELECT status
      FROM project_manager
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { status: string } | undefined;
    if (pmRow) return pmRow.status;
  } catch {
    // Table doesn't exist, continue
  }

  try {
    const projRow = db.prepare(`
      SELECT status
      FROM projects
      ORDER BY updated_at DESC
      LIMIT 1
    `).get() as { status: string } | undefined;
    return projRow?.status ?? null;
  } catch {
    return null;
  }
}
