import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { TestVerifier } from '../../src/verification/test-verifier.js';
import type { CommandVerifier } from '../../src/verification/command-verifier.js';

// ─── Mock CommandVerifier ─────────────────────────────────────────────────────

/**
 * Minimal mock that satisfies the CommandVerifier validate() and captureStdout()
 * contract used by TestVerifier.
 */
class MockCommandVerifier implements Pick<CommandVerifier, 'validate' | 'captureStdout'> {
  constructor(
    private readonly stdoutToReturn: string = '',
    private readonly shouldRejectValidation: boolean = false,
    private readonly rejectReason: string = 'validation failed',
    private readonly shouldThrowOnCapture: boolean = false,
  ) {}

  validate(
    _command: unknown,
  ): { valid: true } | { valid: false; reason: string } {
    if (this.shouldRejectValidation) {
      return { valid: false, reason: this.rejectReason };
    }
    return { valid: true };
  }

  async captureStdout(_command: unknown): Promise<string> {
    if (this.shouldThrowOnCapture) {
      throw new Error(this.rejectReason);
    }
    return this.stdoutToReturn;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a temporary project directory that contains a vitest.config.ts so
 * framework detection resolves to 'vitest'.
 */
function createVitProject(tmpDir: string): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'vitest.config.ts'),
    "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n",
    'utf8',
  );
}

/**
 * Build a temporary project directory that contains a jest.config.js.
 */
function createJestProject(tmpDir: string): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'jest.config.js'),
    "module.exports = { testEnvironment: 'node' };\n",
    'utf8',
  );
}

/**
 * Build a temporary project directory that contains a .mocharc.json.
 */
function createMochaProject(tmpDir: string): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, '.mocharc.json'),
    '{"timeout": 10000}\n',
    'utf8',
  );
}

/**
 * Build a temporary project directory that contains pytest.ini.
 */
function createPytestProject(tmpDir: string): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'pytest.ini'),
    '[pytest]\ntestpaths = tests\n',
    'utf8',
  );
}

/**
 * Build a temporary project directory that contains Cargo.toml.
 */
function createCargoProject(tmpDir: string): void {
  fs.mkdirSync(tmpDir, { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'Cargo.toml'),
    '[package]\nname = "fixture"\nversion = "0.1.0"\n',
    'utf8',
  );
}

/**
 * Sample vitest passing output (default reporter).
 */
const VITEST_PASSING = ` ✓ tests/unit/example.test.ts > example > passes one
 ✓ tests/unit/example.test.ts > example > passes two

 Test Files  1 passed (1)
      Tests  2 passed (2)
   Duration  123ms
`;

/**
 * Sample vitest output with one failing test.
 */
const VITEST_MIXED = ` ✓ tests/unit/example.test.ts > example > passes one
 ❯ tests/unit/example.test.ts > example > fails
   × fails
     expected 1 to be 2

 Test Files  1 failed | 1 passed (2)
      Tests  1 failed | 1 passed (2)
   Duration  123ms
`;

/**
 * Sample jest passing output.
 */
const JEST_PASSING = ` PASS  tests/unit/example.test.ts
  example
    ✓ passes one
    ✓ passes two

Test Suites: 1 passed, 1 total
Tests:       2 passed, 2 total
`;

/**
 * Sample mocha passing output.
 */
const MOCHA_PASSING = `  example
    ✓ passes one
    ✓ passes two

  2 passing (10ms)
`;

/**
 * Sample pytest passing output.
 */
const PYTEST_PASSING = `tests/unit/test_example.py::test_passes_one PASSED
tests/unit/test_example.py::test_passes_two PASSED

========================= 2 passed in 0.01s ==========================
`;

/**
 * Sample cargo test passing output.
 */
const CARGO_PASSING = `running 2 tests
test tests::passes_one ... ok
test tests::passes_two ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
`;

/**
 * Sample empty / zero-test vitest output.
 */
const VITEST_ZERO = ` Test Files  0 passed (0)
      Tests  0 passed (0)
   Duration  12ms
`;

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TestVerifier — parseTestOutput', () => {
  let projectRoot: string;
  let verifier: TestVerifier;
  let mockCv: MockCommandVerifier;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-tv-parse-'),
    );
    createVitProject(projectRoot);
    mockCv = new MockCommandVerifier();
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('parses vitest passing output correctly', () => {
    const result = verifier.parseTestOutput(VITEST_PASSING);
    expect(result.passed).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.suites).toContain('tests/unit/example.test.ts');
  });

  it('parses jest passing output correctly', () => {
    const jestProject = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-tv-jest-'),
    );
    try {
      createJestProject(jestProject);
      const jestVerifier = new TestVerifier(
        jestProject,
        mockCv as unknown as CommandVerifier,
      );
      const result = jestVerifier.parseTestOutput(JEST_PASSING);
      // DEBUG: log what we got
      if (process.env.DEBUG_JEST) console.log('JEST RESULT:', JSON.stringify(result), 'suites:', result.suites);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.suites).toContain('tests/unit/example.test.ts');
    } finally {
      fs.rmSync(jestProject, { recursive: true, force: true });
    }
  });

  it('parses mocha passing output correctly', () => {
    const mochaProject = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-tv-mocha-'),
    );
    try {
      createMochaProject(mochaProject);
      const mochaVerifier = new TestVerifier(
        mochaProject,
        mockCv as unknown as CommandVerifier,
      );
      const result = mochaVerifier.parseTestOutput(MOCHA_PASSING);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
    } finally {
      fs.rmSync(mochaProject, { recursive: true, force: true });
    }
  });

  it('parses pytest passing output correctly', () => {
    const pytestProject = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-tv-pytest-'),
    );
    try {
      createPytestProject(pytestProject);
      const pytestVerifier = new TestVerifier(
        pytestProject,
        mockCv as unknown as CommandVerifier,
      );
      const result = pytestVerifier.parseTestOutput(PYTEST_PASSING);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.suites).toContain('tests/unit/test_example.py');
    } finally {
      fs.rmSync(pytestProject, { recursive: true, force: true });
    }
  });

  it('parses cargo test passing output correctly', () => {
    const cargoProject = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-tv-cargo-'),
    );
    try {
      createCargoProject(cargoProject);
      const cargoVerifier = new TestVerifier(
        cargoProject,
        mockCv as unknown as CommandVerifier,
      );
      const result = cargoVerifier.parseTestOutput(CARGO_PASSING);
      expect(result.passed).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.suites).toContain('tests');
    } finally {
      fs.rmSync(cargoProject, { recursive: true, force: true });
    }
  });
});

describe('TestVerifier — verify()', () => {
  let projectRoot: string;
  let mockCv: MockCommandVerifier;
  let verifier: TestVerifier;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(
      path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-tv-verify-'),
    );
    createVitProject(projectRoot);
    mockCv = new MockCommandVerifier();
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it('returns passed when all tests pass', async () => {
    mockCv = new MockCommandVerifier(VITEST_PASSING);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    const result = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });

    expect(result.status).toBe('passed');
    expect(result.name).toBe('test-verifier');
    expect(result.summary).toContain('2 passed');
  });

  it('returns failed when a test fails', async () => {
    mockCv = new MockCommandVerifier(VITEST_MIXED);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    const result = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });

    // The summary mentions the failure details but the check status is 'failed'
    // because there is 1 failed test. Actually wait — per spec, zero tests → failed,
    // test-count drop → failed. A single failing test doesn't necessarily make the
    // check fail by itself — it reports the result. Let me re-read the spec.
    //
    // Spec says: "a failing test → failed check". So yes, any failed test makes it fail.
    expect(result.status).toBe('failed');
  });

  it('returns failed when zero tests are executed', async () => {
    mockCv = new MockCommandVerifier(VITEST_ZERO);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    const result = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Zero tests executed');
  });

  it('detects test-count drop versus a prior snapshot', async () => {
    // First run: 2 tests pass.
    mockCv = new MockCommandVerifier(VITEST_PASSING);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    const first = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });
    expect(first.status).toBe('passed');

    // Second run: only 1 test passes (drop from 2 → 1).
    // Reuse the SAME verifier so the prior snapshot is retained.
    const reducedOutput = ` ✓ tests/unit/example.test.ts > example > passes one

 Test Files  1 passed (1)
      Tests  1 passed (1)
   Duration  12ms
`;
    mockCv = new MockCommandVerifier(reducedOutput);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    // Manually seed the prior snapshot since we created a fresh verifier.
    verifier['priorSnapshots'] = [
      { testCount: 2, passed: 2, failed: 0, capturedAt: '2026-09-27T00:00:00.000Z' },
    ];
    const second = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });

    expect(second.status).toBe('failed');
    expect(second.summary).toContain('Test-count drop');
  });

  it('returns failed when command validation is rejected', async () => {
    mockCv = new MockCommandVerifier('', true, 'shell string not allowed');
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    const result = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Rejected');
  });

  it('returns failed when command execution throws', async () => {
    // Validation passes, but captureStdout throws.
    mockCv = new MockCommandVerifier('', false, '', true);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    const result = await verifier.verify({
      executable: 'npx',
      args: ['vitest', 'run'],
      cwd: projectRoot,
    });

    expect(result.status).toBe('failed');
    expect(result.summary).toContain('Execution error');
  });

  it('stores and returns the last snapshot', async () => {
    mockCv = new MockCommandVerifier(VITEST_PASSING);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    await verifier.verify({ executable: 'npx', args: ['vitest', 'run'], cwd: projectRoot });

    const snap = verifier.getLastSnapshot();
    expect(snap).not.toBeNull();
    expect(snap!.testCount).toBe(2);
    expect(snap!.passed).toBe(2);
    expect(snap!.failed).toBe(0);
    expect(snap!.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('clearSnapshots empties stored snapshots', async () => {
    mockCv = new MockCommandVerifier(VITEST_PASSING);
    verifier = new TestVerifier(projectRoot, mockCv as unknown as CommandVerifier);
    await verifier.verify({ executable: 'npx', args: ['vitest', 'run'], cwd: projectRoot });
    expect(verifier.getLastSnapshot()).not.toBeNull();

    verifier.clearSnapshots();
    expect(verifier.getLastSnapshot()).toBeNull();
  });

  it('detects framework from vitest.config.ts', () => {
    // Use parseTestOutput with an output that only the vitest parser handles well
    // to confirm framework detection path.
    const result = verifier.parseTestOutput(VITEST_PASSING);
    expect(result.passed).toBe(2);
  });
});
