import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import { reconcile } from '../../src/runtime/reconciliation.js';

describe('Reconciliation — error fingerprint block', () => {
  let db: Database.Database;
  let tmpPath: string;

  beforeEach(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'reconcile-fp-test.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = OFF');

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

      CREATE TABLE IF NOT EXISTS error_fingerprints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        error_code TEXT NOT NULL,
        error_message TEXT,
        occurrence_count INTEGER DEFAULT 1,
        first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(error_code)
      );
    `);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('returns block when a fingerprint has been seen 3 times', () => {
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-fp',
      'FP Test',
      'RUNNING',
    );

    db.prepare(`
      INSERT INTO error_fingerprints (error_code, error_message, occurrence_count)
      VALUES (?, ?, ?)
    `).run('ERR-DOWNSTREAM-TIMEOUT', 'Connection reset by peer', 3);

    const result = reconcile(db);
    expect(result.recommendedAction).toBe('block');
    expect(result.reasoning).toContain('ERR-DOWNSTREAM-TIMEOUT');
    expect(result.reasoning).toContain('3');
  });

  it('returns block when a fingerprint has been seen more than 3 times', () => {
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-fp-high',
      'FP High Test',
      'RUNNING',
    );

    db.prepare(`
      INSERT INTO error_fingerprints (error_code, error_message, occurrence_count)
      VALUES (?, ?, ?)
    `).run('ERR-DOWNSTREAM-TIMEOUT', 'Connection reset by peer', 7);

    const result = reconcile(db);
    expect(result.recommendedAction).toBe('block');
    expect(result.reasoning).toContain('ERR-DOWNSTREAM-TIMEOUT');
    expect(result.reasoning).toContain('7');
  });

  it('does not return block when a fingerprint has been seen only 2 times', () => {
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-fp-low',
      'FP Low Test',
      'RUNNING',
    );

    db.prepare(`
      INSERT INTO error_fingerprints (error_code, error_message, occurrence_count)
      VALUES (?, ?, ?)
    `).run('ERR-DOWNSTREAM-TIMEOUT', 'Connection reset by peer', 2);

    const result = reconcile(db);
    expect(result.recommendedAction).not.toBe('block');
  });

  it('does not return block when no error fingerprints exist', () => {
    db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(
      'proj-no-fp',
      'No FP Test',
      'RUNNING',
    );

    const result = reconcile(db);
    expect(result.recommendedAction).not.toBe('block');
  });

  it('blocks on fingerprint even when other conditions would also trigger block', () => {
    // Both a fingerprint >= 3 and stale runs + uncommitted changes exist
    db.prepare(`
      INSERT INTO agent_runs (session_id, task_id, status, updated_at)
      VALUES (?, ?, ?, datetime('now', '-10 minutes'))
    `).run('session-stale', 1, 'running');

    db.prepare(
      'INSERT INTO transitions (from_state, to_state, entity_type, entity_id) VALUES (?, ?, ?, ?)',
    ).run('CREATED', 'ANALYZING', 'project', 'proj-both-fp');

    db.prepare(`
      INSERT INTO error_fingerprints (error_code, error_message, occurrence_count)
      VALUES (?, ?, ?)
    `).run('ERR-CASCADE', 'Cascade failure', 3);

    const result = reconcile(db);
    expect(result.recommendedAction).toBe('block');
    expect(result.reasoning).toContain('ERR-CASCADE');
  });
});
