/**
 * Phase 2 Acceptance Audit (mission 2.13)
 *
 * End-to-end tests exercising the VerificationPipeline against a real fixture
 * project to verify the nine canonical acceptance criteria:
 *   C1 — false-success rejection (INV-06, INV-13, Rule 18)
 *   C2 — evidence stored for every check
 *   C3 — reproducibility (same input → same result)
 *   C4 — failed test causes overall failure
 *   C5 — deleted test detected (adversarial, INV-13)
 *   C6 — coverage drop detected
 *   C7 — bypass attempt rejected (INV-12)
 *   C8 — secret in diff rejected
 *   C9 — clean test-integrity → overall passed
 *
 * Plus invariant checks:
 *   INV-01 — a phase cannot PASS without a verification result
 *   INV-12 — every verification has a bypass check
 *   INV-13 — test deletion causes failure
 */
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
import type { TestSnapshot } from '../../src/verification/verification-result.js';

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
 * Create a minimal real fixture project with passing tests.
 */
async function createCleanFixture(tmpDir: string): Promise<string> {
  const projectDir = fs.mkdtempSync(path.join(tmpDir, 'god-phase2a-fixture-'));

  const pkg = {
    name: 'fixture-phase2a',
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

  fs.writeFileSync(
    path.join(projectDir, 'vitest.config.ts'),
    'export default { test: { globals: true } };\n',
    'utf8',
  );

  const mathSrc = `export function add(a: number, b: number): number { return a + b; }\nexport function multiply(a: number, b: number): number { return a * b; }\n`;
  fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'src', 'math.ts'), mathSrc, 'utf8');

  const testSrc = `import { describe, it, expect } from 'vitest';\nimport { add, multiply } from '../src/math.js';\n\ndescribe('math', () => {\n  it('adds correctly', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n  it('multiplies correctly', () => {\n    expect(multiply(2, 3)).toBe(6);\n  });\n});\n`;
  fs.mkdirSync(path.join(projectDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, 'tests', 'math.test.ts'), testSrc, 'utf8');

  await initGitRepo(projectDir);
  await gitAddAndCommit(projectDir, 'initial commit');

  // Install deps.
  await runCmd('cmd', ['/c', 'npm', 'install', '--prefer-offline', '--no-audit', '--no-fund'], projectDir);

  // Write coverage summary so coverage_delta is conclusive.
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
  const gitVerifier = new GitVerifier(projectRoot, store);
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
  return { checks: [] };
}

function planWithChecks(...names: string[]): VerificationPlan {
  return { checks: names.map((n) => ({ check: n })) };
}

function safeRmSync(dir: string): void {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* Windows handles */ }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Phase 2 Acceptance Audit (2.13)', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'god-phase2a-'));
  });

  afterEach(() => {
    safeRmSync(tmpDir);
  });

  // ==========================================================================
  // C1 — false success rejected
  //   A fixture test suite that lies (drops assertions) must cause overall FAILED.
  //   INV-06 / INV-13 / Rule 18.
  // ==========================================================================

  it(
    'C1 — false-success rejected: dropping assertions in a test file causes pipeline failure',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'c1.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      // Capture baseline snapshot BEFORE dropping assertions.
      const beforeSnapshot: TestSnapshot = await verifiers.testIntegrity.captureSnapshot();
      expect(beforeSnapshot.assertionCount).toBeGreaterThan(0);
      expect(beforeSnapshot.testFiles).toHaveLength(1);

      // ADVERSARIAL: drop all assertions from the test file, leaving a stub
      // that still runs but produces no asserts (test-count stays the same
      // but assertion count drops — Rule 18 territory).
      const stubbedTest = `import { describe, it } from 'vitest';\nimport { add } from '../src/math.js';\n\ndescribe('math', () => {\n  it('adds correctly', () => {\n    add(2, 3); // no assertion — stub\n  });\n});\n`;
      fs.writeFileSync(path.join(projectDir, 'tests', 'math.test.ts'), stubbedTest, 'utf8');
      await runCmd('git', ['add', '.'], projectDir);
      await runCmd('git', ['commit', '-m', 'stubbed assertions'], projectDir);

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
      };

      const result = await pipeline.run(101, contract, planWithChecks('test_integrity', 'bypass_prevention'));

      // The pipeline must NOT pass — dropping assertions is an adversarial change.
      expect(result.status).not.toBe('passed');
      // The test_integrity check should flag the assertion-count decrease.
      const integrityCheck = result.checks.find((c) => c.name === 'test_integrity');
      expect(integrityCheck).toBeDefined();
      expect(integrityCheck!.status).toBe('failed');
      expect(integrityCheck!.summary).toContain('Assertion count decreased');
    },
    60_000,
  );

  // ==========================================================================
  // C2 — evidence stored for every check
  //   After a pipeline run, every check's evidence IDs must be queryable.
  // ==========================================================================

  it(
    'C2 — evidence stored for every check: all evidence refs are queryable from the store',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'c2.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

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

      const result = await pipeline.run(102, contract, fullPlan());

      expect(result.status).toBe('passed');
      expect(result.evidenceRefs.length).toBeGreaterThan(0);

      // Every evidence ref must be retrievable from the EvidenceStore.
      for (const id of result.evidenceRefs) {
        const evidence = verifiers.store.get(id);
        expect(evidence).not.toBeNull();
        expect(evidence!.id).toBe(id);
        expect(evidence!.verification_run_id).toBe(102);
        expect(evidence!.evidence_type).toBeTruthy();
        expect(evidence!.hash.length).toBe(64); // SHA-256 hex
      }

      // All evidence rows for this run should be present in the DB too.
      const dbEvidence = verifiers.store.getByRun(102);
      expect(dbEvidence.length).toBe(result.evidenceRefs.length);
    },
    90_000,
  );

  // ==========================================================================
  // C3 — reproducibility
  //   Running the pipeline twice with identical input must produce identical
  //   result status and matching check list (ignoring timestamps in summaries).
  // ==========================================================================

  it(
    'C3 — reproducibility: same input yields same result on two runs',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath1 = path.join(tmpDir, 'c3a.db');
      const dbPath2 = path.join(tmpDir, 'c3b.db');

      // Both runs use the SAME project directory and snapshot.
      const beforeSnapshot = await (
        new TestIntegrityVerifier(projectDir)
      ).captureSnapshot();

      const verifiers1 = makeVerifiers(projectDir, dbPath1, tmpDir);
      const verifiers2 = makeVerifiers(projectDir, dbPath2, tmpDir);
      const pipeline1 = makePipeline(verifiers1);
      const pipeline2 = makePipeline(verifiers2);

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

      const resultA = await pipeline1.run(103, contract, fullPlan());
      const resultB = await pipeline2.run(104, contract, fullPlan());

      // Same overall status.
      expect(resultA.status).toBe(resultB.status);

      // Same number of checks, in the same order, with the same status per check.
      expect(resultA.checks).toHaveLength(resultB.checks.length);
      for (let i = 0; i < resultA.checks.length; i++) {
        expect(resultA.checks[i]!.name).toBe(resultB.checks[i]!.name);
        expect(resultA.checks[i]!.status).toBe(resultB.checks[i]!.status);
      }

      // Both should pass on a clean fixture.
      expect(resultA.status).toBe('passed');
      expect(resultB.status).toBe('passed');
    },
    90_000,
  );

  // ==========================================================================
  // C4 — failed test causes failure
  // ==========================================================================

  it(
    'C4 — failed test causes overall failure',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Tamper: introduce a failing assertion.
      const tampered = `import { describe, it, expect } from 'vitest';\nimport { add } from '../src/math.js';\n\ndescribe('math', () => {\n  it('adds correctly', () => {\n    expect(add(2, 3)).toBe(5);\n  });\n  it('always fails', () => {\n    expect(1).toBe(99);\n  });\n});\n`;
      fs.writeFileSync(path.join(projectDir, 'tests', 'math.test.ts'), tampered, 'utf8');
      await runCmd('git', ['add', '.'], projectDir);

      const dbPath = path.join(tmpDir, 'c4.db');
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

      const result = await pipeline.run(104, contract, planWithChecks('test'));

      expect(result.status).toBe('failed');
      const testCheck = result.checks.find((c) => c.name === 'test');
      expect(testCheck).toBeDefined();
      expect(testCheck!.status).toBe('failed');
      // Summary contains "test(s) failed" — exact count varies by framework output format.
      expect(testCheck!.summary).toContain('test(s) failed');
    },
    60_000,
  );

  // ==========================================================================
  // C5 — deleted test detected (adversarial), INV-13
  // ==========================================================================

  it(
    'C5 — deleted test detected (adversarial): removing a test file causes test_integrity failure (INV-13)',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Capture baseline BEFORE deletion.
      const dbPath = path.join(tmpDir, 'c5.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const snapshotBefore = await verifiers.testIntegrity.captureSnapshot();
      expect(snapshotBefore.testFiles).toHaveLength(1);
      expect(snapshotBefore.assertionCount).toBeGreaterThan(0);

      // ADVERSARIAL: delete the test file.
      const testPath = path.join(projectDir, 'tests', 'math.test.ts');
      fs.unlinkSync(testPath);
      await runCmd('git', ['add', '.'], projectDir);

      const pipeline = makePipeline(verifiers);

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot: snapshotBefore,
      };

      const result = await pipeline.run(105, contract, planWithChecks('test_integrity'));

      expect(result.status).toBe('failed');
      const integrityCheck = result.checks.find((c) => c.name === 'test_integrity');
      expect(integrityCheck).toBeDefined();
      expect(integrityCheck!.status).toBe('failed');
      expect(integrityCheck!.summary).toContain('Test file deleted');
    },
    30_000,
  );

  // ==========================================================================
  // C6 — coverage drop detected
  // ==========================================================================

  it(
    'C6 — coverage drop detected: lowering coverage by > 2 pp causes coverage_delta failure',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'c6.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      // Capture baseline with 95% coverage.
      const beforeSnapshot = await verifiers.coverage.captureBaseline();
      expect(beforeSnapshot.coveragePct).toBe(95);

      // Lower coverage by writing a new summary at 80%.
      const lowCoverage = {
        total: { lines: { total: 100, covered: 80, skipped: 0, pct: 80 } },
        files: {},
      };
      fs.writeFileSync(
        path.join(projectDir, 'coverage', 'coverage-summary.json'),
        JSON.stringify(lowCoverage),
        'utf8',
      );

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
      };

      const result = await pipeline.run(106, contract, planWithChecks('coverage_delta'));

      expect(result.status).toBe('failed');
      const covCheck = result.checks.find((c) => c.name === 'coverage_delta');
      expect(covCheck).toBeDefined();
      expect(covCheck!.status).toBe('failed');
      expect(covCheck!.summary).toContain('Coverage dropped');
    },
    30_000,
  );

  // ==========================================================================
  // C7 — bypass attempt rejected (INV-12)
  // ==========================================================================

  it(
    'C7 — bypass attempt rejected: deliberate stubbing of test file triggers bypass_prevention failure (INV-12)',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'c7.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      // Capture baseline.
      const beforeSnapshot = await verifiers.testIntegrity.captureSnapshot();

      // ADVERSARIAL: rewrite the test to stub out all assertions but keep
      // the it() structure so test-count appears normal (classic bypass).
      const stubbedTest = `import { describe, it } from 'vitest';\nimport { add } from '../src/math.js';\n\ndescribe('math', () => {\n  it('adds correctly', () => {\n    add(2, 3); // stubbed — no expect\n  });\n});\n`;
      fs.writeFileSync(path.join(projectDir, 'tests', 'math.test.ts'), stubbedTest, 'utf8');
      await runCmd('git', ['add', '.'], projectDir);

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
      };

      const result = await pipeline.run(107, contract, planWithChecks('bypass_prevention'));

      expect(result.status).toBe('failed');
      const bypassCheck = result.checks.find((c) => c.name === 'bypass_prevention');
      expect(bypassCheck).toBeDefined();
      expect(bypassCheck!.status).toBe('failed');
      // The bypass detector should flag either test-deletion or assertion-weakening.
      expect(bypassCheck!.summary).toMatch(/bypass|Detected|assertion|stub/i);
    },
    30_000,
  );

  // ==========================================================================
  // C8 — secret in diff rejected
  // ==========================================================================

  it(
    'C8 — secret in diff rejected: adding a real secret token to a changed file fails security check',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);

      // Create and commit a config file.
      const srcPath = path.join(projectDir, 'src', 'config.ts');
      fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true });
      fs.writeFileSync(srcPath, 'export const API_KEY = "sk-FAKE0000baseline";\n', 'utf8');
      await runCmd('git', ['add', '.'], projectDir);
      await runCmd('git', ['commit', '-m', 'add config'], projectDir);

      // Modify to contain a real-looking secret (long enough to pass pattern match).
      // sk- + 25 alphanumeric chars (>= 20 required after prefix).
      fs.writeFileSync(
        srcPath,
        'export const API_KEY = "sk-REALSECRET1234567890abcdefghijXYZ";\n',
        'utf8',
      );
      // Leave uncommitted so git diff picks it up.

      const dbPath = path.join(tmpDir, 'c8.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = { projectRoot: projectDir };
      const result = await pipeline.run(108, contract, planWithChecks('git', 'security'));

      expect(result.status).toBe('failed');
      const secCheck = result.checks.find((c) => c.name === 'security');
      expect(secCheck).toBeDefined();
      expect(secCheck!.status).toBe('failed');
      expect(secCheck!.summary).toContain('secret token');
    },
    30_000,
  );

  // ==========================================================================
  // C9 — test-integrity clean → overall passed
  // ==========================================================================

  it(
    'C9 — clean test-integrity: unchanged fixture passes all checks',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'c9.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const beforeSnapshot = await verifiers.testIntegrity.captureSnapshot();
      expect(beforeSnapshot.assertionCount).toBeGreaterThan(0);
      expect(beforeSnapshot.testFiles).toHaveLength(1);

      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
      };

      const result = await pipeline.run(109, contract, planWithChecks('git', 'file', 'test_integrity', 'bypass_prevention'));

      expect(result.status).toBe('passed');
      for (const check of result.checks) {
        expect(check.status).toBe('passed');
      }
    },
    30_000,
  );

  // ==========================================================================
  // INV-01 — a phase cannot PASS without a verification result
  //   The pipeline must never return 'passed' when there are zero checks.
  // ==========================================================================

  it(
    'INV-01 — pipeline never passes with zero checks',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'inv01.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const contract = { projectRoot: projectDir };
      // Empty plan = no checks at all.
      const result = await pipeline.run(110, contract, { checks: [] });

      // An empty plan produces zero checks, so computeOverall returns 'passed'
      // (no failing checks). However, INV-01 says a phase CANNOT pass without
      // a verification result. The spec interpretation here: if the plan is
      // explicitly empty (caller opted out of all checks), the pipeline
      // returns passed-by-default because there are no required checks to fail.
      // This is consistent with the current implementation where an empty
      // plan runs DEFAULT_CHECK_ORDER — but if the caller explicitly passes
      // an empty checks array, we respect that.
      //
      // To satisfy INV-01 literally, we assert that an explicit empty plan
      // does NOT return passed. If the implementation currently does, this
      // test documents the deviation.
      expect(result.status).not.toBe('passed');
    },
    10_000,
  );

  // ==========================================================================
  // INV-12 — every verification has a bypass check
  //   When bypass_prevention is included in the plan, it must be present
  //   in the result checks whenever a beforeSnapshot is supplied.
  // ==========================================================================

  it(
    'INV-12 — bypass check present when beforeSnapshot is supplied',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'inv12.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

      const beforeSnapshot = await verifiers.testIntegrity.captureSnapshot();
      const contract = {
        projectRoot: projectDir,
        beforeSnapshot,
      };

      const result = await pipeline.run(111, contract, fullPlan());

      // The full canonical plan includes bypass_prevention.
      const bypassCheck = result.checks.find((c) => c.name === 'bypass_prevention');
      expect(bypassCheck).toBeDefined();
      expect(bypassCheck!.status).toBe('passed');
    },
    30_000,
  );

  // ==========================================================================
  // INV-13 — test deletion causes failure
  //   Independent of C5, verify that the full pipeline (not just test_integrity)
  //   returns failed when a test file is deleted.
  // ==========================================================================

  it(
    'INV-13 — full pipeline fails when a test file is deleted',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'inv13.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const snapshotBefore = await verifiers.testIntegrity.captureSnapshot();

      // Delete the test file.
      const testPath = path.join(projectDir, 'tests', 'math.test.ts');
      fs.unlinkSync(testPath);
      await runCmd('git', ['add', '.'], projectDir);

      const pipeline = makePipeline(verifiers);
      const contract = {
        projectRoot: projectDir,
        beforeSnapshot: snapshotBefore,
      };

      const result = await pipeline.run(112, contract, fullPlan());

      expect(result.status).toBe('failed');
      // Both test_integrity and bypass_prevention should flag the deletion.
      const integrityCheck = result.checks.find((c) => c.name === 'test_integrity');
      expect(integrityCheck).toBeDefined();
      expect(integrityCheck!.status).toBe('failed');
      const bypassCheck = result.checks.find((c) => c.name === 'bypass_prevention');
      expect(bypassCheck).toBeDefined();
      expect(bypassCheck!.status).toBe('failed');
    },
    30_000,
  );

  // ==========================================================================
  // Additional: full clean pipeline returns passed with evidence for every check
  // ==========================================================================

  it(
    'full clean pipeline: passes and every check has non-empty evidence',
    async () => {
      const projectDir = await createCleanFixture(tmpDir);
      const dbPath = path.join(tmpDir, 'full-clean.db');
      const verifiers = makeVerifiers(projectDir, dbPath, tmpDir);
      const pipeline = makePipeline(verifiers);

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

      const result = await pipeline.run(113, contract, fullPlan());

      expect(result.status).toBe('passed');
      expect(result.checks).toHaveLength(11); // canonical checks (minus semantic)

      for (const check of result.checks) {
        expect(check.evidence.length).toBeGreaterThan(0);
      }
    },
    90_000,
  );
});
