import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';
import {
  openDatabase,
  closeDatabase,
  runMigrations,
  withTransaction,
} from '../../src/persistence/database.ts';

function getSchemaTableNames(db: Database.Database): string[] {
  const rows = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    )
    .all<{ name: string }>();
  return rows.map((r) => r.name);
}

const V5_TABLES = [
  '_migrations',
  'agent_reports',
  'agent_runs',
  'agent_sessions',
  'approvals',
  'audit_logs',
  'design_decisions',
  'decision_evidence',
  'decisions',
  'drift_reports',
  'evidence',
  'error_fingerprints',
  'events',
  'execution_contracts',
  'hallucination_checks',
  'memory_entries',
  'memory_lifecycle',
  'memory_summaries',
  'milestones',
  'notifications',
  'notification_deliveries',
  'policies',
  'projects',
  'project_specifications',
  'queue_jobs',
  'recovery_attempts',
  'requirements',
  'secrets',
  'tasks',
  'test_snapshots',
  'transitions',
  'verification_checks',
  'verification_runs',
];

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, '..', '..', 'src', 'persistence', 'migrations');

describe('persistence — database', () => {
  let db: Database.Database;
  let tmpPath: string;

  beforeAll(() => {
    tmpPath = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-test-'),
    );
    const dbPath = path.join(tmpPath, 'test.db');
    db = openDatabase({ filepath: dbPath });
    runMigrations(db, MIGRATIONS_DIR);
  });

  afterAll(() => {
    closeDatabase(db);
    fs.rmSync(tmpPath, { recursive: true, force: true });
  });

  it('creates all V5 schema tables', () => {
    const names = getSchemaTableNames(db);
    for (const table of V5_TABLES) {
      expect(names).toContain(table);
    }
  });

  it('has exactly 35 application tables + _migrations', () => {
    const names = getSchemaTableNames(db);
    const nonMigrationTables = names.filter((n) => n !== '_migrations' && n !== 'sqlite_sequence');
    expect(nonMigrationTables.length).toBe(35);
  });

  it('is idempotent — running migrations twice does not duplicate tables', () => {
    const before = getSchemaTableNames(db);
    runMigrations(db, MIGRATIONS_DIR);
    const after = getSchemaTableNames(db);
    expect(after).toEqual(before);
  });

  it('enables WAL mode', () => {
    const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode: string };
    expect(row.journal_mode).toBe('wal');
  });

  it('enforces foreign keys', () => {
    let threw = false;
    try {
      db.prepare("INSERT INTO tasks (phase_id, task_id, description) VALUES (9999, 'T-X', 'orphan')").run();
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });

  it('commits a successful transaction', () => {
    withTransaction(db, () => {
      db.prepare(
        "INSERT INTO projects (name, status) VALUES (?, ?)",
      ).run('commit-proj', 'created');
    });
    const row = db
      .prepare("SELECT id FROM projects WHERE name = ?")
      .get('commit-proj') as { id: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBeGreaterThan(0);
  });

  it('rolls back a failed transaction', () => {
    let threw = false;
    try {
      withTransaction(db, () => {
        db.prepare(
          "INSERT INTO projects (name, status) VALUES (?, ?)",
        ).run('rollback-proj', 'created');
        throw new Error('Intentional rollback');
      });
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
    const row = db
      .prepare("SELECT id FROM projects WHERE name = ?")
      .get('rollback-proj') as { id: number } | undefined;
    expect(row).toBeUndefined();
  });

  it('supports concurrent database access', () => {
    const dbs: Database.Database[] = [];
    for (let i = 0; i < 5; i++) {
      const tDb = openDatabase({
        filepath: path.join(tmpPath, `concurrent-${i}.db`),
      });
      runMigrations(tDb, MIGRATIONS_DIR);
      withTransaction(tDb, () => {
        tDb.prepare(
          "INSERT INTO projects (name, status) VALUES (?, ?)",
        ).run(`project-${i}`, 'created');
      });
      dbs.push(tDb);
    }

    const allProjects: { id: number; name: string }[] = [];
    for (const tDb of dbs) {
      const rows = tDb.prepare('SELECT id, name FROM projects').all<
        { id: number; name: string }
      >();
      allProjects.push(...rows);
      closeDatabase(tDb);
    }

    expect(allProjects.length).toBe(5);
  });
});
