import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { EvidenceStore } from '../../src/verification/evidence-store.js';
import { computeHash } from '../../src/verification/evidence.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/persistence/database.js';

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'persistence',
  'migrations',
);

function makeDbAndStore(tmpDir: string): { db: Database.Database; store: EvidenceStore; fsRoot: string } {
  const dbPath = path.join(tmpDir, 'evidence-test.db');
  const db = openDatabase({ filepath: dbPath });
  runMigrations(db, MIGRATIONS_DIR);
  const fsRoot = path.join(tmpDir, 'evidence-fs');
  const store = new EvidenceStore(db, fsRoot);
  return { db, store, fsRoot };
}

describe('EvidenceStore', () => {
  let tmpDir: string;
  let db: Database.Database;
  let store: EvidenceStore;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-evidence-'));
    ({ db, store } = makeDbAndStore(tmpDir));
  });

  afterAll(() => {
    closeDatabase(db);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('stores small evidence in the DB with a correct hash', () => {
    const content = 'small-payload';
    const evidence = store.store(1, 'text', 'test-source', content);

    expect(evidence.id).toBeGreaterThan(0);
    expect(evidence.evidence_type).toBe('text');
    expect(evidence.source).toBe('test-source');
    expect(evidence.verification_run_id).toBe(1);
    expect(evidence.evidence_data).toBe(content);
    expect(evidence.fs_path).toBeNull();
    expect(evidence.hash).toBe(computeHash(content));
    expect(evidence.size).toBe(Buffer.byteLength(content, 'utf8'));
    expect(evidence.created_at).toBeInstanceOf(Date);
  });

  it('stores large evidence on disk and keeps hash in DB', () => {
    const content = 'x'.repeat(5000);
    const evidence = store.store(2, 'large-file', 'disk-source', content);

    expect(evidence.evidence_data).toBeNull();
    expect(evidence.fs_path).not.toBeNull();
    expect(evidence.fs_path).toMatch(/2-large-file-.*\.dat$/);
    expect(fs.existsSync(evidence.fs_path!)).toBe(true);
    expect(evidence.hash).toBe(computeHash(content));
    expect(evidence.size).toBe(5000);
  });

  it('getByRun returns all evidence for a run', () => {
    store.store(10, 'text', 'src-a', 'payload-a');
    store.store(10, 'output', 'src-b', 'payload-b');
    store.store(20, 'text', 'src-c', 'payload-c');

    const run10 = store.getByRun(10);
    expect(run10).toHaveLength(2);
    expect(run10.map((e) => e.source)).toContain('src-a');
    expect(run10.map((e) => e.source)).toContain('src-b');

    const run20 = store.getByRun(20);
    expect(run20).toHaveLength(1);
    expect(run20[0].source).toBe('src-c');
  });

  it('getByType returns evidence across runs', () => {
    store.store(30, 'log', 'src-x', 'log-data');
    store.store(40, 'log', 'src-y', 'more-log');

    const logs = store.getByType('log');
    expect(logs).toHaveLength(2);
    expect(logs.every((e) => e.evidence_type === 'log')).toBe(true);
  });

  it('verifyHash returns true for untampered small evidence', () => {
    const evidence = store.store(50, 'text', 'src', 'intact');
    expect(store.verifyHash(evidence.id)).toBe(true);
  });

  it('verifyHash returns true for untampered large evidence', () => {
    const content = 'y'.repeat(6000);
    const evidence = store.store(51, 'large', 'src', content);
    expect(store.verifyHash(evidence.id)).toBe(true);
  });

  it('verifyHash detects tampering of in-DB content', () => {
    const evidence = store.store(60, 'text', 'src', 'secret');
    // Mutate the row directly to simulate tampering.
    db.prepare("UPDATE evidence SET evidence_data = ? WHERE id = ?").run('tampered', evidence.id);
    expect(store.verifyHash(evidence.id)).toBe(false);
  });

  it('verifyHash detects tampering of on-disk content', () => {
    const content = 'z'.repeat(7000);
    const evidence = store.store(61, 'large', 'src', content);
    // Tamper the disk file.
    fs.writeFileSync(evidence.fs_path!, 'corrupted-content', 'utf8');
    expect(store.verifyHash(evidence.id)).toBe(false);
  });

  it('verifyHash returns false for a non-existent id', () => {
    expect(store.verifyHash(99999)).toBe(false);
  });

  it('delete removes the DB row and the disk file', () => {
    const content = 'delete-me';
    const evidence = store.store(70, 'text', 'src', content);
    const fsPath = evidence.fs_path;

    store.delete(evidence.id);

    expect(store.get(evidence.id)).toBeNull();
    if (fsPath) {
      expect(fs.existsSync(fsPath)).toBe(false);
    }
  });

  it('delete is a no-op for a missing id', () => {
    expect(() => store.delete(99999)).not.toThrow();
  });

  it('creates evidence with an explicit checkId', () => {
    const evidence = store.store(80, 'text', 'src', 'check-linked', 42);
    expect(evidence.verification_check_id).toBe(42);
    expect(evidence.verification_run_id).toBe(80);
  });

  it('creates the filesystem root automatically on construction', () => {
    // Use a path inside the already-existing tmpDir to avoid Windows temp-dir locking.
    const fsRootNested = path.join(tmpDir, 'nested-fs', 'deep');
    const nestedStore = new EvidenceStore(db, fsRootNested);
    const ev = nestedStore.store(90, 'text', 'src', 'hello-nested');
    expect(ev).toBeDefined();
    expect(fs.existsSync(fsRootNested)).toBe(true);
  });
});
