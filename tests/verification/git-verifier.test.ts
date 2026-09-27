import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitVerifier } from '../../src/verification/git-verifier.js';
import { EvidenceStore } from '../../src/verification/evidence-store.js';
import { openDatabase, closeDatabase, runMigrations } from '../../src/persistence/database.js';

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'persistence',
  'migrations',
);

// ---------------------------------------------------------------------------
// Helper: run a git command inside a directory using structured spawn.
// ---------------------------------------------------------------------------
async function runGit(dir: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('git', args, {
      cwd: dir,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(`git ${args.join(' ')} exited with ${exitCode}: ${stderr}`));
      } else {
        resolve(stdout);
      }
    });
    child.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Helper: create a fresh temp git repo, make an initial commit, return path.
// ---------------------------------------------------------------------------
async function createFixtureRepo(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'god-git-verifier-'));
  await runGit(dir, ['init']);
  await runGit(dir, ['config', 'user.name', 'Test Agent']);
  await runGit(dir, ['config', 'user.email', 'test-agent@god-orchestrator.test']);

  // Write an initial file and commit.
  fs.writeFileSync(path.join(dir, 'README.md'), '# Test Repo\n');
  fs.writeFileSync(path.join(dir, 'app.ts'), '// app\n');
  await runGit(dir, ['add', '.']);
  await runGit(dir, ['commit', '-m', 'initial commit']);

  return dir;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('GitVerifier', () => {
  let tmpDir: string;

  beforeAll(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'god-git-test-'));
  });

  afterAll(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('verify() on a clean repo returns passed with clean-status evidence text', async () => {
    const repo = await createFixtureRepo();
    const verifier = new GitVerifier(repo);

    const check = await verifier.verify(1);

    expect(check.status).toBe('passed');
    expect(check.name).toBe('git-status');
    expect(check.summary).toContain('clean');
    expect(check.evidence).toHaveLength(0); // no EvidenceStore attached

    // Confirm git status is truly empty.
    const status = await verifier.getStatus();
    expect(status.trim()).toBe('');
  });

  it('verify() on a dirty repo records status text in evidence (not a failure)', async () => {
    const repo = await createFixtureRepo();
    // Modify a tracked file to make the repo dirty.
    fs.appendFileSync(path.join(repo, 'README.md'), '\n## Updated\n');

    const verifier = new GitVerifier(repo);
    const check = await verifier.verify(2);

    expect(check.status).toBe('passed'); // dirty is not a failure per spec
    expect(check.summary).toContain('changed');

    const status = await verifier.getStatus();
    expect(status).toContain('README.md');
  });

  it('getDiff captures the diff of uncommitted changes', async () => {
    const repo = await createFixtureRepo();
    fs.appendFileSync(path.join(repo, 'README.md'), '\n# new section\n');

    const verifier = new GitVerifier(repo);
    const diff = await verifier.getDiff();

    expect(diff).toContain('README.md');
    expect(diff).toContain('+# new section');
  });

  it('getLog returns recent commits', async () => {
    const repo = await createFixtureRepo();
    const verifier = new GitVerifier(repo);

    const log = await verifier.getLog(5);
    expect(log).toContain('initial commit');
  });

  it('getLog respects the limit parameter', async () => {
    const repo = await createFixtureRepo();
    // Add two more commits.
    fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
    await runGit(repo, ['add', 'a.txt']);
    await runGit(repo, ['commit', '-m', 'second commit']);

    fs.writeFileSync(path.join(repo, 'b.txt'), 'b\n');
    await runGit(repo, ['add', 'b.txt']);
    await runGit(repo, ['commit', '-m', 'third commit']);

    const verifier = new GitVerifier(repo);
    const log = await verifier.getLog(2);
    const lines = log.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('third commit');
    expect(lines[1]).toContain('second commit');
  });

  it('getChangedFiles returns only modified tracked files after a change', async () => {
    const repo = await createFixtureRepo();
    fs.appendFileSync(path.join(repo, 'app.ts'), '\n// change\n');

    const verifier = new GitVerifier(repo);
    const changed = await verifier.getChangedFiles();

    expect(changed).toContain('app.ts');
    // README.md was not touched, so it should not appear.
    expect(changed).not.toContain('README.md');
  });

  it('getChangedFiles is empty on a clean repo', async () => {
    const repo = await createFixtureRepo();
    const verifier = new GitVerifier(repo);
    const changed = await verifier.getChangedFiles();
    expect(changed).toHaveLength(0);
  });

  it('getForbiddenChanges detects a change to a forbidden path', async () => {
    const repo = await createFixtureRepo();
    fs.appendFileSync(path.join(repo, 'app.ts'), '\n// forbidden edit\n');

    const verifier = new GitVerifier(repo);
    const violations = await verifier.getForbiddenChanges(['app.ts']);
    expect(violations).toContain('app.ts');
  });

  it('getForbiddenChanges returns empty when no forbidden paths are touched', async () => {
    const repo = await createFixtureRepo();
    fs.appendFileSync(path.join(repo, 'app.ts'), '\n// safe edit\n');

    const verifier = new GitVerifier(repo);
    const violations = await verifier.getForbiddenChanges(['secret.env', 'config.json']);
    expect(violations).toHaveLength(0);
  });

  it('getForbiddenChanges returns empty when given an empty array', async () => {
    const repo = await createFixtureRepo();
    fs.appendFileSync(path.join(repo, 'app.ts'), '\n// any edit\n');

    const verifier = new GitVerifier(repo);
    const violations = await verifier.getForbiddenChanges([]);
    expect(violations).toHaveLength(0);
  });

  it('getForbiddenChanges matches path suffixes', async () => {
    const repo = await createFixtureRepo();
    const secretsDir = path.join(repo, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    fs.writeFileSync(path.join(secretsDir, 'keys.txt'), 'sk-FAKE0000\n');
    await runGit(repo, ['add', '.']);
    await runGit(repo, ['commit', '-m', 'add secrets']);
    // Now modify the forbidden file.
    fs.appendFileSync(path.join(secretsDir, 'keys.txt'), 'sk-FAKE0001\n');

    const verifier = new GitVerifier(repo);
    const violations = await verifier.getForbiddenChanges(['keys.txt']);
    // Git outputs forward-slash paths on all platforms; normalise for comparison.
    const normalized = violations.map((v) => v.replace(/\\/g, '/'));
    expect(normalized).toContain('secrets/keys.txt');
  });

  it('verify() attaches evidence rows when an EvidenceStore is supplied', async () => {
    const repo = await createFixtureRepo();
    fs.appendFileSync(path.join(repo, 'app.ts'), '\n// evidence test\n');

    const dbPath = path.join(tmpDir, 'git-evidence.db');
    const db = openDatabase({ filepath: dbPath });
    runMigrations(db, MIGRATIONS_DIR);
    const fsRoot = path.join(tmpDir, 'git-evidence-fs');
    const store = new EvidenceStore(db, fsRoot);

    const verifier = new GitVerifier(repo, store);
    const check = await verifier.verify(10);

    expect(check.status).toBe('passed');
    expect(check.evidence).toHaveLength(2); // status + diff

    // Verify the evidence rows exist and contain the expected content.
    const evidenceRows = store.getByRun(10);
    expect(evidenceRows).toHaveLength(2);
    const types = new Set(evidenceRows.map((e) => e.evidence_type));
    expect(types).toContain('git-status');
    expect(types).toContain('git-diff');

    // The diff evidence should be non-empty since we modified app.ts.
    const diffEvidence = evidenceRows.find((e) => e.evidence_type === 'git-diff');
    expect(diffEvidence).toBeDefined();
    expect(diffEvidence!.evidence_data).toContain('app.ts');

    closeDatabase(db);
  });

  it('verify() on a clean repo stores clean-status evidence', async () => {
    const repo = await createFixtureRepo();

    const dbPath = path.join(tmpDir, 'git-clean-evidence.db');
    const db = openDatabase({ filepath: dbPath });
    runMigrations(db, MIGRATIONS_DIR);
    const fsRoot = path.join(tmpDir, 'git-clean-evidence-fs');
    const store = new EvidenceStore(db, fsRoot);

    const verifier = new GitVerifier(repo, store);
    const check = await verifier.verify(20);

    expect(check.status).toBe('passed');
    expect(check.evidence).toHaveLength(2);

    const evidenceRows = store.getByRun(20);
    const statusRow = evidenceRows.find((e) => e.evidence_type === 'git-status');
    expect(statusRow).toBeDefined();
    // Clean repos produce empty porcelain output; we normalise to "(clean …)".
    expect(statusRow!.evidence_data).toContain('clean');

    closeDatabase(db);
  });

  it('projectRoot is resolved to an absolute path', () => {
    const repo = '/some/absolute/path';
    const verifier = new GitVerifier(repo);
    // On Windows, path.resolve normalises to the current drive.
    expect(path.isAbsolute(verifier.projectRoot)).toBe(true);
  });

  it('projectRoot resolves relative paths to absolute', async () => {
    const repo = await createFixtureRepo();
    const relative = path.relative(process.cwd(), repo);
    const verifier = new GitVerifier(relative);
    expect(path.isAbsolute(verifier.projectRoot)).toBe(true);
    expect(verifier.projectRoot).toBe(repo);
  });
});
