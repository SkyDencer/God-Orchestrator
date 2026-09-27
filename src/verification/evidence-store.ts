import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { computeHash, type Evidence } from './evidence.js';

/** Content larger than this many bytes is written to disk; smaller content stays in the DB row. */
const IN_DB_SIZE_THRESHOLD = 4096;

export class EvidenceStore {
  constructor(
    private readonly db: Database.Database,
    private readonly filesystemRoot: string,
  ) {
    fs.mkdirSync(filesystemRoot, { recursive: true });
  }

  /**
   * Store evidence for a verification run.
   *
   * The store accepts a `runId` (verification_runs.id) and internally records the
   * evidence against the run.  The original schema links evidence to
   * verification_checks via `verification_check_id`; EvidenceStore stores the
   * direct `verification_run_id` linkage and leaves `verification_check_id` as
   * null unless the caller supplies it through an alternate path.  Callers that
   * need check-level linking should insert a verification_check row first and
   * pass its id via the optional `checkId` parameter.
   *
   * @param runId          FK to verification_runs
   * @param type           Human-readable evidence_type label
   * @param source         Source label (e.g. "terminal-output", "agent-report")
   * @param content        The evidence payload (UTF-8 string)
   * @param checkId        Optional FK to verification_checks; null means run-level only
   */
  store(
    runId: number,
    type: string,
    source: string,
    content: string,
    checkId: number | null = null,
  ): Evidence {
    const hash = computeHash(content);
    const size = Buffer.byteLength(content, 'utf8');
    let evidenceData: string | null = null;
    let fsPath: string | null = null;

    if (size > IN_DB_SIZE_THRESHOLD) {
      const safeName = `${runId}-${type}-${hash}.dat`;
      fsPath = path.join(this.filesystemRoot, safeName);
      fs.writeFileSync(fsPath, content, 'utf8');
    } else {
      evidenceData = content;
    }

    const info = this.db
      .prepare(
        `INSERT INTO evidence (
          verification_check_id,
          verification_run_id,
          evidence_type,
          evidence_data,
          fs_path,
          hash,
          size,
          source
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(checkId, runId, type, evidenceData, fsPath, hash, size, source);

    const id = Number(info.lastInsertRowid);

    return this.findById(id)!;
  }

  get(id: number): Evidence | null {
    return this.findById(id);
  }

  getByRun(runId: number): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE verification_run_id = ? ORDER BY id')
      .all(runId) as Evidence[];
    return rows;
  }

  getByType(type: string): Evidence[] {
    const rows = this.db
      .prepare('SELECT * FROM evidence WHERE evidence_type = ? ORDER BY id')
      .all(type) as Evidence[];
    return rows;
  }

  /**
   * Re-read the stored content (from DB or disk) and compare its SHA-256
   * against the hash persisted in the row.  Returns true when the content
   * is intact.
   */
  verifyHash(id: number): boolean {
    const row = this.findById(id);
    if (!row) return false;

    const content = this.readContent(row);
    if (content === null) return false;

    return computeHash(content) === row.hash;
  }

  delete(id: number): void {
    const row = this.findById(id);
    if (!row) return;

    // Remove the disk file if one exists.
    if (row.fs_path && fs.existsSync(row.fs_path)) {
      fs.unlinkSync(row.fs_path);
    }

    this.db.prepare('DELETE FROM evidence WHERE id = ?').run(id);
  }

  // ------------------------------------------------------------------ internals
  private findById(id: number): Evidence | null {
    const row = this.db
      .prepare('SELECT * FROM evidence WHERE id = ?')
      .get(id) as Evidence | undefined;
    if (!row) return null;
    // Normalise createdAt to a Date object.
    return {
      ...row,
      created_at: new Date(row.created_at as unknown as string),
    };
  }

  private readContent(row: Evidence): string | null {
    if (row.evidence_data !== null) {
      return row.evidence_data;
    }
    if (row.fs_path !== null && fs.existsSync(row.fs_path)) {
      return fs.readFileSync(row.fs_path, 'utf8');
    }
    return null;
  }
}
