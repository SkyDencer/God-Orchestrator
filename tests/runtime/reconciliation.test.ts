import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { reconcile } from '../../src/runtime/reconciliation.js';

describe('Reconciliation', () => {
  let db: Database.Database;
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'reconcile-test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

    // Create all necessary tables for reconciliation
    db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'CREATED',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS phases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL,
        phase_id TEXT NOT NULL,
        name TEXT NOT NULL,
        status TEXT DEFAULT 'PENDING',
        order_index INTEGER DEFAULT 0,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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

      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL UNIQUE,
        agent_id TEXT,
        status TEXT DEFAULT 'active',
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
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('crash before commit → nothing persisted', () => {
    // Insert a project
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-crash',
      'Crash Test',
      'CREATED',
    );

    // Simulate crash: insert transition but no event
    db.prepare(
      'INSERT INTO transitions (from_state, to_state, entity_type, entity_id) VALUES (?, ?, ?, ?)',
    ).run('CREATED', 'ANALYZING', 'project', 'proj-crash');

    const result = reconcile(db);

    // Should detect inconsistency (transitions without matching events)
    expect(result.uncommittedChanges).toBeGreaterThan(0);
    expect(result.lastValidState).toBe('CREATED');
  });

  it('crash after commit → all persisted', () => {
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-ok',
      'OK Test',
      'RUNNING',
    );

    const result = reconcile(db);
    expect(result.lastValidState).toBe('RUNNING');
    expect(result.staleRuns).toBe(0);
    expect(result.orphanedPhases).toBe(0);
    expect(result.uncommittedChanges).toBe(0);
  });

  it('detects stale agent runs', () => {
    // Insert stale agent run (older than 5 minutes)
    db.prepare(`
      INSERT INTO agent_runs (session_id, task_id, status, updated_at)
      VALUES (?, ?, ?, datetime('now', '-10 minutes'))
    `).run('session-stale', 1, 'running');

    const result = reconcile(db);
    expect(result.staleRuns).toBeGreaterThan(0);
    expect(result.recommendedAction).toBe('retry');
  });

  it('detects orphaned phases', () => {
    // Insert phase with RUNNING status but no active agent_runs
    db.prepare(
      'INSERT INTO phases (project_id, phase_id, name, status) VALUES (?, ?, ?, ?)',
    ).run('proj-orphan', 'phase-1', 'Test Phase', 'RUNNING');

    const result = reconcile(db);
    expect(result.orphanedPhases).toBeGreaterThan(0);
    expect(result.recommendedAction).toBe('verify');
  });

  it('recommends resume for consistent state', () => {
    // Clean state - just a project
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-clean',
      'Clean Test',
      'RUNNING',
    );

    const result = reconcile(db);
    expect(result.recommendedAction).toBe('resume');
  });

  it('recommends block when stale runs and uncommitted changes coexist', () => {
    // Insert stale agent run
    db.prepare(`
      INSERT INTO agent_runs (session_id, task_id, status, updated_at)
      VALUES (?, ?, ?, datetime('now', '-10 minutes'))
    `).run('session-stale', 1, 'running');

    // Insert a transition without matching event → uncommitted change
    db.prepare(
      'INSERT INTO transitions (from_state, to_state, entity_type, entity_id) VALUES (?, ?, ?, ?)',
    ).run('CREATED', 'ANALYZING', 'project', 'proj-both');

    const result = reconcile(db);
    expect(result.staleRuns).toBeGreaterThan(0);
    expect(result.uncommittedChanges).toBeGreaterThan(0);
    expect(result.recommendedAction).toBe('block');
    expect(result.reasoning).toContain('blocking');
  });
});
