import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ProcessManager } from '../../src/agent/process-manager.js';
import { CommandVerifier } from '../../src/verification/command-verifier.js';
import { GitVerifier } from '../../src/verification/git-verifier.js';
import { FileVerifier } from '../../src/verification/file-verifier.js';
import { TestVerifier } from '../../src/verification/test-verifier.js';
import { BuildVerifier } from '../../src/verification/build-verifier.js';
import { AcceptanceVerifier } from '../../src/verification/acceptance-verifier.js';
import { SecurityVerifier } from '../../src/verification/security-verifier.js';
import { CoverageVerifier } from '../../src/verification/coverage-verifier.js';
import { TestIntegrityVerifier } from '../../src/verification/test-integrity-verifier.js';
import { BypassDetector } from '../../src/verification/bypass-detector.js';
import { EvidenceStore } from '../../src/verification/evidence-store.js';
import { openDatabase, runMigrations } from '../../src/persistence/database.js';
import { VerificationPipeline } from '../../src/verification/pipeline.js';
import type { VerificationPlan } from '../../src/verification/verification-result.js';
import type { AcceptanceCriterion } from '../../src/verification/verification-result.js';

const MIGRATIONS_DIR = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'src',
  'persistence',
  'migrations',
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function runCmd(
  executable: string,
  args: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on('close', (exitCode) => {
      resolve({ exitCode: exitCode ?? 1, stdout, stderr });
    });
    child.on('error', reject);
  });
}

async function initGitRepo(dir: string): Promise<void> {
  await runCmd('git', ['init'], dir);
  await runCmd('git', ['config', 'user.name', 'Test Agent'], dir);
  await runCmd('git', ['config', 'user.email', 'test-agent@god-orchestrator.test'], dir);
}

async function gitAddAndCommit(dir: string, message: string): Promise<void> {
  await runCmd('git', ['add', '.'], dir);
  await runCmd('git', ['commit', '-m', message], dir);
}

/**
 * Create a minimal real fixture project with:
 *   - A git repo
 *   - package.json (ESM, vitest devDependency)
 *   - vitest.config.ts
 *   - src/math.ts (small module)
 *   - tests/math.test.ts (real test suite that passes)
 *   - Initial commit
 */
async function createCleanFixture(tmpDir: string): Promise<string> {
  const projectDir = fs.mkdtempSync(path.join(tmpDir, 'god-pipeline-fixture-'));

  // package.json
  const pkg = {
    name: 'fixture-pipeline',
    version: '1.0.0',
    type: 'module',
    scripts: {
      test: 'vitest run',
      build: 'tsc --noEmit',
      lint: 'echo lint-ok',
      typecheck: 'tsc --noEmit',
    },
    devDependencies: {
      vitest: '^2.0.0',
      typescript: '^5.6.0',
    },
  };
  fs.writeFileSync(
    path.join(projectDir, 'package.json'),
    JSON.stringify(pkg, null, 2),
    'utf8',
  );

  // tsconfig.json
  const tsconfig = {
    compilerOptions: {
      target: 'ES2022',
      module: 'ESNext',
      moduleResolution: 'bundler',
      strict: true,
      outDir: 'dist',
      rootDir: 'src',
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    include: ['src/**/*'],
  };
  fs.writeFileSync(
    path.join(projectDir, 'tsconfig.json'),
    JSON.stringify(tsconfig, null, 2),
    'utf8',
  );

  // vitest.config.ts — minimal, no external imports needed
  const vitestConfig = 'export default { test: { globals: true } };\n';
  fs.writeFileSync(path.join(projectDir, 'vitest.config.ts'), vitestConfig, 'utf8');

  // src/math.ts
  const mathSrc = `export function add(a: number, b: number): number { return a + b; }\nexport function multiply(a: number, b: number): number { return a * b; }\n`;
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'math.ts'), mathSrc, 'utf8');

  // tests/math.test.ts
  const testSrc = `import { describe, it, expect } from 'vitest';\nimport { add, multiply } from '../src/math.js';\n\ndescribe('math', () => {\n  it('adds correctly', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n  it('multiplies correctly', () => {\n    expect(multiply(2, 3)).toBe(6);\n  });\n});\n`;
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tests', 'math.test.ts'), testSrc, 'utf8');

  // Init git and commit
  await initGitRepo(projectDir);
  await gitAddAndCommit(projectDir, 'initial commit');

  // Install dependencies so npx commands work reliably.
  // On Windows, npm is a .cmd file; use cmd wrapper via runCmd's spawn.
  await runCmd('cmd', ['/c', 'npm', 'install', '--prefer-offline', '--no-audit', '--no-fund'], projectDir);

  // Write a minimal coverage-summary.json so coverage_delta can evaluate
  // rather than returning inconclusive (no coverage report found).
  const coverageSummary = {
    total: { lines: { total: 100, covered: 95, skipped: 0, pct: 95 } },
    files: {},
  };
  fs.mkdirSync(path.join(projectDir, 'coverage'), { recursive: true });
  fs.writeFileSync(
    path.join(projectDir, 'coverage', 'coverage-summary.json'),
    JSON.stringify(coverageSummary),
    'utf8',
  );

  return projectDir;
}

function makeVerifiers(projectRoot: string, dbPath: string, fsRoot: string) {
  const pm = new ProcessManager();
  const cmdVerifier = new CommandVerifier(projectRoot, pm);
  const dbConn = openDatabase({ filepath: dbPath });
  runMigrations(dbConn, MIGRATIONS_DIR);
  const store = new EvidenceStore(dbConn, fsRoot);
  const gitVerifier = new GitVerifier(projectRoot, store); // pass evidence store so git check produces evidence
  const fileVerifier = new FileVerifier(projectRoot);
  const testVerifier = new TestVerifier(projectRoot, cmdVerifier);
  const buildVerifier = new BuildVerifier(projectRoot, cmdVerifier);
  const acceptanceVerifier = new AcceptanceVerifier(fileVerifier, cmdVerifier, dbConn, store);
  const securityVerifier = new SecurityVerifier(projectRoot);
  const coverageVerifier = new CoverageVerifier(projectRoot);
  const testIntegrityVerifier = new TestIntegrityVerifier(projectRoot);
  const bypassDetector = new BypassDetector(projectRoot);

  return {
    git: gitVerifier,
    file: fileVerifier,
    command: cmdVerifier,
    test: testVerifier,
    build: buildVerifier,
    acceptance: acceptanceVerifier,
    security: securityVerifier,
    coverage: coverageVerifier,
    testIntegrity: testIntegrityVerifier,
    bypass: bypassDetector,
    store,
    db: dbConn,
  };
}

function makePipeline(verifiers: ReturnType<typeof makeVerifiers>) {
  return new VerificationPipeline({
    gitVerifier: verifiers.git,
    fileVerifier: verifiers.file,
    commandVerifier: verifiers.command,
    testVerifier: verifiers.test,
    buildVerifier: verifiers.build,
    acceptanceVerifier: verifiers.acceptance,
    securityVerifier: verifiers.security,
    coverageVerifier: verifiers.coverage,
    testIntegrityVerifier: verifiers.testIntegrity,
    bypassDetector: verifiers.bypass,
    evidenceStore: verifiers.store,
  });
}

function fullPlan(): VerificationPlan {
  return { checks: [] }; // empty plan = run all canonical checks
}

function fullPlanWithChecks(...names: string[]): VerificationPlan {
  return { checks: names.map((n) => ({ check: n })) };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VerificationPipeline', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'god-pipeline-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* Windows may hold handles */ }
  });

  // ------------------------------------------------------------------ real integration: clean fixture → passed

  it(
    'full pipeline on a clean fixture project returns passed',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'clean.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      // Capture baseline snapshot so coverage_delta, test_integrity, and
      // bypass_prevention can compare against it rather than being inconclusive.
      const beforeSnapshot = await verifiers.testIntegrity.captureSnapshot();

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
        testCommand: {
          executable: path.join(projectDir, 'node_modules', '.bin', 'vitest.cmd'),
          args: ['run'],
          cwd: projectDir,
          timeoutMs: 60_000,
        },
      };

      const result = await pipeline.run(1, contract, fullPlan());

      expect(result.status).toBe('passed');
      expect(result.checks).toHaveLength(11); // canonical order minus semantic

      // Every check should have evidence attached.
      for (const check of result.checks) {
        expect(check.evidence.length).toBeGreaterThan(0);
      }

      // Evidence rows should exist in the store.
      const evidence = verifiers.store.getByRun(1);
      expect(evidence.length).toBeGreaterThan(0);
    },
    60_000,
  );

  // ------------------------------------------------------------------ failing test → failed

  it(
    'pipeline with a failing test returns failed',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Tamper: make one test fail.
      const testPath = path.join(projectDir, 'tests', 'math.test.ts');
      const tampered = `import { describe, it, expect } from 'vitest';\nimport { add } from '../src/math.js';\n\ndescribe('math', () => {\n  it('adds correctly', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n  it('always fails', () => {\n    expect(1).toBe(2);\n  });\n});\n`;
      fs.writeFileSync(testPath, tampered, 'utf8');
      // Amend the git commit so security check sees the diff.
      await runCmd('git', ['add', '.'], projectDir);
      await runCmd('git', ['commit', '-m', 'tampered test'], projectDir);

      const dbPath = path.join(tmpDir, 'fail.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        testCommand: {
          executable: path.join(projectDir, 'node_modules', '.bin', 'vitest.cmd'),
          args: ['run'],
          cwd: projectDir,
          timeoutMs: 60_000,
        },
      };

      const result = await pipeline.run(2, contract, fullPlanWithChecks('git', 'test'));

      expect(result.status).toBe('failed');
      const testCheck = result.checks.find((c) => c.name === 'test');
      expect(testCheck).toBeDefined();
      expect(testCheck!.status).toBe('failed');
      // The summary reports the number of failed tests; we just assert it
      // indicates a failure rather than checking the exact count.
      expect(testCheck!.summary).toContain('test(s) failed');
    },
    60_000,
  );

  // ------------------------------------------------------------------ deleted test → failed via integrity

  it(
    'pipeline with a deleted test returns failed (via test_integrity)',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Capture baseline snapshot BEFORE deleting the test.
      const dbPath = path.join(tmpDir, 'del.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const snapshotBefore = await verifiers.testIntegrity.captureSnapshot();
      expect(snapshotBefore.testFiles).toHaveLength(1);
      expect(snapshotBefore.assertionCount).toBeGreaterThan(0);

      // Delete the test file.
      const testPath = path.join(projectDir, 'tests', 'math.test.ts');
      fs.unlinkSync(testPath);
      // Amend git so the deletion is tracked in the working tree.
      await runCmd('git', ['add', '.'], projectDir);

      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot: snapshotBefore,
      };

      const result = await pipeline.run(3, contract, fullPlanWithChecks('git', 'test_integrity'));

      expect(result.status).toBe('failed');
      const integrityCheck = result.checks.find((c) => c.name === 'test_integrity');
      expect(integrityCheck).toBeDefined();
      expect(integrityCheck!.status).toBe('failed');
      expect(integrityCheck!.summary).toContain('Test file deleted');
    },
    30_000,
  );

  // ------------------------------------------------------------------ secret in diff → failed via security

  it(
    'pipeline with a secret in the diff returns failed (via security)',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // To get a diff, we need a committed baseline then a modification.
      // Create src/config.ts and commit it.
      const srcPath = path.join(projectDir, 'src', 'config.ts');
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(srcPath, 'export const API_KEY = "sk-FAKE0000initial";\n', 'utf8');
      await runCmd('git', ['add', '.'], projectDir);
      await runCmd('git', ['commit', '-m', 'add config'], projectDir);

      // Now modify it to contain a real secret token (not a placeholder).
      // sk- + 25 alphanumeric chars (>= 20 required after prefix)
      fs.writeFileSync(
        srcPath,
        'export const API_KEY = "sk-REALSECRET1234567890abcdefghijXYZ";\n',
        'utf8',
      );
      // Do NOT git add — leave as uncommitted change so git diff picks it up.

      const dbPath = path.join(tmpDir, 'sec.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
      };

      const result = await pipeline.run(4, contract, fullPlanWithChecks('git', 'security'));

      expect(result.status).toBe('failed');
      const secCheck = result.checks.find((c) => c.name === 'security');
      expect(secCheck).toBeDefined();
      expect(secCheck!.status).toBe('failed');
      expect(secCheck!.summary).toContain('secret token');
    },
    30_000,
  );

  // ------------------------------------------------------------------ inconclusive case

  it(
    'pipeline returns inconclusive when a required check is inconclusive with no fallback',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Remove the coverage-summary.json that createCleanFixture writes,
      // so coverage_delta has no report to read and returns inconclusive.
      const covFile = path.join(projectDir, 'coverage', 'coverage-summary.json');
      if (fs.existsSync(covFile)) {
        fs.unlinkSync(covFile);
      }

      const dbPath = path.join(tmpDir, 'inc.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      // Capture a baseline snapshot so coverage_delta has something to compare.
      const beforeSnapshot = await verifiers.testIntegrity.captureSnapshot();
      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
      };

      const result = await pipeline.run(5, contract, fullPlanWithChecks('coverage_delta'));

      expect(result.status).toBe('inconclusive');
      const covCheck = result.checks.find((c) => c.name === 'coverage_delta');
      expect(covCheck).toBeDefined();
      expect(covCheck!.status).toBe('inconclusive');
    },
    30_000,
  );

  // ------------------------------------------------------------------ evidence storage

  it(
    'every check stores evidence through the EvidenceStore',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'ev.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        testCommand: {
          executable: path.join(projectDir, 'node_modules', '.bin', 'vitest.cmd'),
          args: ['run'],
          cwd: projectDir,
          timeoutMs: 60_000,
        },
      };

      const result = await pipeline.run(6, contract, fullPlanWithChecks('git', 'test'));

      expect(result.status).toBe('passed');
      const allEvidenceIds = result.evidenceRefs;
      expect(allEvidenceIds.length).toBeGreaterThan(0);

      // Verify each evidence id is readable from the store.
      for (const id of allEvidenceIds) {
        const evidence = verifiers.store.get(id);
        expect(evidence).not.toBeNull();
        expect(evidence!.evidence_type).toBeTruthy();
      }
    },
    60_000,
  );

  // ------------------------------------------------------------------ acceptance criteria in contract

  it(
    'pipeline evaluates acceptance criteria from the contract',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      // Ensure a known file exists.
      fs.writeFileSync(path.join(projectDir, 'deploy.sh'), '#!/bin/sh\necho deployed\n', 'utf8');

      const dbPath = path.join(tmpDir, 'acc.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const criterion: AcceptanceCriterion = {
        type: 'file_exists',
        payload: { path: 'deploy.sh' },
      };
      const contract = {
        projectRoot: projectDir,
        acceptanceCriteria: [criterion],
      };

      const result = await pipeline.run(7, contract, fullPlanWithChecks('acceptance'));

      expect(result.status).toBe('passed');
      const accCheck = result.checks.find((c) => c.name === 'acceptance');
      expect(accCheck).toBeDefined();
      expect(accCheck!.status).toBe('passed');
    },
    10_000,
  );

  // ------------------------------------------------------------------ required-check semantics

  it(
    'overall is failed when any required check fails',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Make the test fail.
      const testPath = path.join(projectDir, 'tests', 'math.test.ts');
      const tampered = `import { describe, it, expect } from 'vitest';\n\ndescribe('math', () => {\n  it('fails', () => { expect(1).toBe(2); });\n});\n`;
      fs.writeFileSync(testPath, tampered, 'utf8');
      await runCmd('git', ['add', '.'], projectDir);

      const dbPath = path.join(tmpDir, 'req.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        testCommand: {
          executable: path.join(projectDir, 'node_modules', '.bin', 'vitest.cmd'),
          args: ['run'],
          cwd: projectDir,
          timeoutMs: 60_000,
        },
      };

      const result = await pipeline.run(8, contract, fullPlanWithChecks('git', 'test'));

      expect(result.status).toBe('failed');
    },
    60_000,
  );

  it(
    'never passes when a required check is missing or failing (INV-01, INV-12)',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Capture baseline before deleting.
      const dbPath = path.join(tmpDir, 'inv.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const snapshotBefore = await verifiers.testIntegrity.captureSnapshot();

      // Delete the only test file — this will fail test_integrity.
      const testPath = path.join(projectDir, 'tests', 'math.test.ts');
      fs.unlinkSync(testPath);
      await runCmd('git', ['add', '.'], projectDir);

      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot: snapshotBefore,
      };

      const result = await pipeline.run(9, contract, fullPlanWithChecks('test_integrity'));

      // INV-01 / INV-12: never passed with a failing required check.
      expect(result.status).not.toBe('passed');
      expect(result.status).toBe('failed');
    },
    30_000,
  );

  // ------------------------------------------------------------------ execution order

  it(
    'checks execute in canonical order',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'order.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        testCommand: {
          executable: path.join(projectDir, 'node_modules', '.bin', 'vitest.cmd'),
          args: ['run'],
          cwd: projectDir,
          timeoutMs: 60_000,
        },
      };

      const result = await pipeline.run(10, contract, fullPlan());

      const names = result.checks.map((c) => c.name);
      // Canonical order: git, file, build, test, lint, typecheck, acceptance,
      // coverage_delta, test_integrity, security, bypass_prevention
      const expectedOrder = [
        'git', 'file', 'build', 'test', 'lint', 'typecheck',
        'acceptance', 'coverage_delta', 'test_integrity', 'security', 'bypass_prevention',
      ];
      expect(names).toEqual(expectedOrder);
    },
    60_000,
  );

  // ------------------------------------------------------------------ semantic check is optional/off-by-default

  it(
    'semantic check is not run by default',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'sem.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = { projectRoot: projectDir };
      const result = await pipeline.run(11, contract, fullPlan());

      const names = result.checks.map((c) => c.name);
      expect(names).not.toContain('semantic');
    },
    60_000,
  );

  it(
    'semantic check runs when explicitly requested',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'sem2.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = { projectRoot: projectDir };
      const result = await pipeline.run(12, contract, fullPlanWithChecks('semantic'));

      const names = result.checks.map((c) => c.name);
      expect(names).toContain('semantic');
      const semanticCheck = result.checks.find((c) => c.name === 'semantic');
      expect(semanticCheck!.status).toBe('passed');
    },
    60_000,
  );

  // ------------------------------------------------------------------ partial plan: only specified checks run

  it(
    'only the checks listed in the plan are run',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'partial.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = { projectRoot: projectDir };
      const result = await pipeline.run(13, contract, fullPlanWithChecks('git'));

      const names = result.checks.map((c) => c.name);
      expect(names).toEqual(['git']);
    },
    60_000,
  );
});
