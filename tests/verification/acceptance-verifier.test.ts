import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { FileVerifier } from '../../src/verification/file-verifier.js';
import { CommandVerifier } from '../../src/verification/command-verifier.js';
import { ProcessManager } from '../../src/agent/process-manager.js';
import { AcceptanceVerifier, type AcceptanceInput } from '../../src/verification/acceptance-verifier.js';
import type { AcceptanceCriterion } from '../../src/verification/verification-result.js';
import { openDatabase, runMigrations } from '../../src/persistence/database.js';

const PROJECT_ROOT = process.cwd();
const MIGRATIONS_DIR = path.resolve(PROJECT_ROOT, 'src', 'persistence', 'migrations');

function makeTmpDir(): string {
  const base = process.env.TEMP ?? process.env.TMP ?? '/tmp';
  return fs.mkdtempSync(path.join(base, 'god-acceptance-'));
}

function writeFixture(dir: string, relPath: string, content: string): string {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

function makeDbWithRequirements(projectId: number, reqs: { req_id: string; description: string }[]): Database.Database {
  const dbPath = path.join(makeTmpDir(), 'test.db');
  const db = openDatabase({ filepath: dbPath });
  runMigrations(db, MIGRATIONS_DIR);
  // Insert a project row first (required by foreign key).
  db.prepare('INSERT INTO projects (id, name, status) VALUES (?, ?, ?)').run(projectId, `project-${projectId}`, 'active');
  for (const r of reqs) {
    db.prepare('INSERT INTO requirements (project_id, req_id, description) VALUES (?, ?, ?)').run(
      projectId,
      r.req_id,
      r.description,
    );
  }
  return db;
}

function safeRmSync(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Windows may refuse to delete dirs while handles are still open;
    // swallow the error rather than let afterEach fail tests.
  }
}

describe('AcceptanceVerifier', () => {
  let tmpDir: string;
  let fileVerifier: FileVerifier;
  let commandVerifier: CommandVerifier;
  let verifier: AcceptanceVerifier;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    fileVerifier = new FileVerifier(tmpDir);
    commandVerifier = new CommandVerifier(PROJECT_ROOT, new ProcessManager());
    const dbPath = path.join(tmpDir, 'empty.db');
    const db = openDatabase({ filepath: dbPath });
    runMigrations(db, MIGRATIONS_DIR);
    verifier = new AcceptanceVerifier(fileVerifier, commandVerifier, db);
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  // ------------------------------------------------------------------ command

  describe('type: command', () => {
    it('passes when the command exits with the expected code', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'command',
        payload: {
          command: { executable: 'node', args: ['-e', 'process.exit(0)'] },
          expectedExitCode: 0,
        } as unknown as import('../../src/verification/verification-result.js').CommandPayload,
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.name).toContain('node');
    });

    it('fails when the command exits with a non-zero code', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'command',
        payload: {
          command: { executable: 'node', args: ['-e', 'process.exit(1)'] },
          expectedExitCode: 0,
        } as unknown as import('../../src/verification/verification-result.js').CommandPayload,
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('1');
      expect(check.summary).toContain('expected 0');
    });

    it('rejects a missing command field as failed', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'command',
        payload: {} as unknown as import('../../src/verification/verification-result.js').CommandPayload,
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Missing');
    });
  });

  // ------------------------------------------------------------------ file_exists

  describe('type: file_exists', () => {
    it('passes when the file exists', async () => {
      writeFixture(tmpDir, 'exists.txt', 'hello');
      const criterion: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'exists.txt' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.name).toBe('file_exists');
    });

    it('fails when the file does not exist', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'missing.txt' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.name).toBe('file_exists');
      expect(check.summary).toContain('missing.txt');
    });

    it('fails when path is missing from payload', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'file_exists',
        payload: {} as unknown as import('../../src/verification/verification-result.js').FileExistsPayload,
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Missing path');
    });
  });

  // ------------------------------------------------------------------ file_contains

  describe('type: file_contains', () => {
    it('passes when the file contains the pattern', async () => {
      writeFixture(tmpDir, 'content.txt', 'the quick brown fox');
      const criterion: AcceptanceCriterion = {
        type: 'file_contains',
        payload: { path: 'content.txt', pattern: 'quick brown' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.name).toBe('file_contains');
    });

    it('fails when the pattern is absent', async () => {
      writeFixture(tmpDir, 'content.txt', 'hello world');
      const criterion: AcceptanceCriterion = {
        type: 'file_contains',
        payload: { path: 'content.txt', pattern: 'GOODBYE' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Pattern not found');
    });

    it('fails when path or pattern is missing', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'file_contains',
        payload: { path: 'content.txt' } as unknown as import('../../src/verification/verification-result.js').FileContainsPayload,
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Missing path or pattern');
    });
  });

  // ------------------------------------------------------------------ file_not_contains

  describe('type: file_not_contains', () => {
    it('passes when the pattern is absent', async () => {
      writeFixture(tmpDir, 'content.txt', 'hello world');
      const criterion: AcceptanceCriterion = {
        type: 'file_not_contains',
        payload: { path: 'content.txt', pattern: 'secret' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.name).toBe('file_not_contains');
    });

    it('fails when the pattern IS present', async () => {
      writeFixture(tmpDir, 'content.txt', 'api_key=sk-FAKE0000');
      const criterion: AcceptanceCriterion = {
        type: 'file_not_contains',
        payload: { path: 'content.txt', pattern: 'sk-' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Pattern found');
    });

    it('fails when path or pattern is missing', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'file_not_contains',
        payload: { path: 'content.txt' } as unknown as import('../../src/verification/verification-result.js').FileContainsPayload,
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Missing path or pattern');
    });
  });

  // ------------------------------------------------------------------ custom

  describe('type: custom', () => {
    it('passes with label and details', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'custom',
        payload: { label: 'my-check', details: 'some detail' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.name).toBe('my-check');
      expect(check.summary).toContain('Custom criterion satisfied');
      expect(check.summary).toContain('some detail');
    });

    it('passes with only a label', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'custom',
        payload: { label: 'label-only' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.summary).not.toContain(':');
    });
  });

  // ------------------------------------------------------------------ requirement_ref

  describe('type: requirement_ref', () => {
    it('is inconclusive when no requirement_ref is provided', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'requirement_ref',
        payload: {},
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('inconclusive');
      expect(check.name).toBe('requirement_ref');
    });

    it('is inconclusive when the project has no requirements records', async () => {
      const criterion: AcceptanceCriterion = {
        type: 'requirement_ref',
        payload: { requirement_ref: '999:REQ-001' },
      };
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('inconclusive');
      expect(check.summary).toContain('No requirements record');
    });

    it('is inconclusive when the ref format is malformed (no colon)', async () => {
      const dbPath = path.join(tmpDir, 'malformed.db');
      const db = openDatabase({ filepath: dbPath });
      runMigrations(db, MIGRATIONS_DIR);
      const v = new AcceptanceVerifier(fileVerifier, commandVerifier, db);
      const criterion: AcceptanceCriterion = {
        type: 'requirement_ref',
        payload: { requirement_ref: 'bad-ref' },
      };
      const check = await v.verify(criterion);
      expect(check.status).toBe('inconclusive');
      expect(check.summary).toContain('Malformed');
      db.close();
    });

    it('is inconclusive when the requirement ref is not found', async () => {
      const db = makeDbWithRequirements(1, [{ req_id: 'REQ-001', description: 'Auth required' }]);
      const v = new AcceptanceVerifier(fileVerifier, commandVerifier, db);
      const criterion: AcceptanceCriterion = {
        type: 'requirement_ref',
        payload: { requirement_ref: '1:REQ-999' },
      };
      const check = await v.verify(criterion);
      expect(check.status).toBe('inconclusive');
      expect(check.summary).toContain('not found');
      db.close();
    });

    it('passes when the requirement ref exists and resolves', async () => {
      const db = makeDbWithRequirements(1, [
        { req_id: 'REQ-001', description: 'Auth required' },
        { req_id: 'REQ-002', description: 'Rate limiting' },
      ]);
      const v = new AcceptanceVerifier(fileVerifier, commandVerifier, db);
      const criterion: AcceptanceCriterion = {
        type: 'requirement_ref',
        payload: { requirement_ref: '1:REQ-001' },
      };
      const check = await v.verify(criterion);
      expect(check.status).toBe('passed');
      expect(check.name).toBe('requirement_ref');
      expect(check.summary).toContain('REQ-001');
      expect(check.summary).toContain('Auth required');
      db.close();
    });

    it('is inconclusive when project_id is not a number', async () => {
      const db = makeDbWithRequirements(1, []);
      const v = new AcceptanceVerifier(fileVerifier, commandVerifier, db);
      const criterion: AcceptanceCriterion = {
        type: 'requirement_ref',
        payload: { requirement_ref: 'abc:REQ-001' },
      };
      const check = await v.verify(criterion);
      expect(check.status).toBe('inconclusive');
      expect(check.summary).toContain('Invalid project_id');
      db.close();
    });
  });

  // ------------------------------------------------------------------ composite

  describe('composite criterion', () => {
    it('passes when all sub-criteria pass', async () => {
      writeFixture(tmpDir, 'a.txt', 'hello');
      writeFixture(tmpDir, 'b.txt', 'world');

      const sub1: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'a.txt' },
      };
      const sub2: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'b.txt' },
      };
      const composite: AcceptanceInput = {
        type: 'composite',
        payload: { criteria: [sub1, sub2], label: 'both-files' },
      };
      const check = await verifier.verify(composite);
      expect(check.status).toBe('passed');
      expect(check.name).toBe('both-files');
      expect(check.summary).toContain('All');
      expect(check.summary).toContain('2');
    });

    it('fails immediately when the first sub-criterion fails', async () => {
      writeFixture(tmpDir, 'a.txt', 'hello');

      const sub1: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'a.txt' },
      };
      const sub2: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'b.txt' },
      };
      const composite: AcceptanceInput = {
        type: 'composite',
        payload: { criteria: [sub1, sub2], label: 'both-files' },
      };
      const check = await verifier.verify(composite);
      expect(check.status).toBe('failed');
      expect(check.name).toBe('both-files');
      expect(check.summary).toContain('sub-criterion');
      expect(check.summary).toContain('file_exists');
      expect(check.summary).toContain('b.txt');
    });

    it('fails when a command sub-criterion fails inside a composite', async () => {
      const sub1: AcceptanceCriterion = {
        type: 'command',
        payload: {
          command: { executable: 'node', args: ['-e', 'process.exit(0)'] },
          expectedExitCode: 0,
        } as unknown as import('../../src/verification/verification-result.js').CommandPayload,
      };
      const sub2: AcceptanceCriterion = {
        type: 'command',
        payload: {
          command: { executable: 'node', args: ['-e', 'process.exit(1)'] },
          expectedExitCode: 0,
        } as unknown as import('../../src/verification/verification-result.js').CommandPayload,
      };
      const composite: AcceptanceInput = {
        type: 'composite',
        payload: { criteria: [sub1, sub2], label: 'cmd-pair' },
      };
      const check = await verifier.verify(composite);
      expect(check.status).toBe('failed');
      expect(check.name).toBe('cmd-pair');
      expect(check.summary).toContain('sub-criterion');
      expect(check.summary).toContain('node');
    });

    it('uses default label when none is provided', async () => {
      const sub: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'missing.txt' },
      };
      const composite: AcceptanceInput = {
        type: 'composite',
        payload: { criteria: [sub] },
      };
      const check = await verifier.verify(composite);
      expect(check.name).toBe('composite');
      expect(check.status).toBe('failed');
    });

    it('passes an empty composite', async () => {
      const composite: AcceptanceInput = {
        type: 'composite',
        payload: { criteria: [], label: 'empty' },
      };
      const check = await verifier.verify(composite);
      expect(check.status).toBe('passed');
      expect(check.summary).toContain('All');
    });
  });

  // ------------------------------------------------------------------ unknown type

  describe('unknown criterion type', () => {
    it('returns a failed check for an unrecognized type', async () => {
      const criterion = {
        type: 'nonexistent_type',
        payload: {},
      } as unknown as AcceptanceCriterion;
      const check = await verifier.verify(criterion);
      expect(check.status).toBe('failed');
      expect(check.summary).toContain('Unknown criterion type');
    });
  });
});
