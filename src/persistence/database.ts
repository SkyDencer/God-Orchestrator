import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface DatabaseConfig {
  filepath: string;
  timeout?: number;
  verbose?: (...args: unknown[]) => void;
}

/**
 * Open a SQLite database with WAL mode, foreign keys, and synchronous=NORMAL.
 */
export function openDatabase(config: DatabaseConfig): Database.Database {
  const db = new Database(config.filepath, {
    timeout: config.timeout ?? 30_000,
  });

  if (config.verbose) {
    db.pragma('query_log = true');
  }

  // Enable WAL mode for better concurrent access
  db.pragma('journal_mode = WAL');
  // Enable foreign key constraints
  db.pragma('foreign_keys = ON');
  // Set synchronous to NORMAL for a balance of safety and performance
  db.pragma('synchronous = NORMAL');

  return db;
}

/**
 * Close a database connection gracefully.
 */
export function closeDatabase(db: Database.Database): void {
  if (db.open) {
    db.close();
  }
}

/**
 * Run migrations from a directory. Tracks applied migrations in _migrations table.
 * Idempotent: re-running does not re-apply already-applied migrations.
 */
export function runMigrations(db: Database.Database, migrationsDir: string): void {
  // Ensure _migrations table exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL UNIQUE,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrationFiles = fs
    .readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort();

  for (const file of migrationFiles) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');

    const result = db
      .prepare('SELECT id FROM _migrations WHERE filename = ?')
      .get(file) as { id: number } | undefined;

    if (result !== undefined) {
      continue;
    }

    db.exec(sql);
    db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(file);
  }
}

/**
 * Wrap a callback in an atomic transaction. Rolls back on error.
 */
export function withTransaction<T>(
  db: Database.Database,
  fn: () => T,
): T {
  const tx = db.transaction(fn);
  return tx();
}
