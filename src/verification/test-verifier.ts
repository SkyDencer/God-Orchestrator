import * as fs from 'node:fs';
import * as path from 'path';
import type { CommandRequest, TestCountSnapshot, VerificationCheck } from './verification-result.js';
import type { CommandVerifier } from './command-verifier.js';

/** Result shape returned by parseTestOutput. */
export interface TestOutputResult {
  passed: number;
  failed: number;
  suites: string[];
}

/** Parsed framework name used internally. */
type DetectedFramework = 'vitest' | 'jest' | 'mocha' | 'pytest' | 'cargo' | 'unknown';

/**
 * Verifier that runs test commands, parses their output, detects frameworks
 * via config-file presence, and flags suspicious conditions:
 *   - zero tests executed
 *   - test-count drop versus a prior snapshot (Rule 18 territory)
 *
 * Depends on CommandVerifier for validation and execution.
 */
export class TestVerifier {
  private readonly projectRoot: string;
  private readonly commandVerifier: CommandVerifier;
  /** Ordered list of prior TestCountSnapshots, newest last. */
  private readonly priorSnapshots: TestCountSnapshot[] = [];

  constructor(projectRoot: string, commandVerifier: CommandVerifier) {
    this.projectRoot = projectRoot;
    this.commandVerifier = commandVerifier;
  }

  /**
   * Run a structured test command and return a VerificationCheck.
   *
   * Steps:
   *   1. Validate the command via CommandVerifier.
   *   2. Capture stdout from the test run.
   *   3. Detect the test framework from config files in projectRoot.
   *   4. Parse the stdout with the matching output parser.
   *   5. If zero tests were executed, return a failed check (suspicious).
   *   6. Compare total test count against the most recent prior snapshot;
   *      a drop in count produces a failed check.
   *   7. Store a new TestCountSnapshot for future comparisons.
   */
  async verify(command: CommandRequest): Promise<VerificationCheck> {
    const validation = this.commandVerifier.validate(command);
    if (!validation.valid) {
      return {
        name: 'test-verifier',
        status: 'failed',
        summary: `Rejected: ${validation.reason}`,
        evidence: [],
      };
    }

    let stdout: string;
    try {
      stdout = await this.commandVerifier.captureStdout(command);
    } catch (err) {
      return {
        name: 'test-verifier',
        status: 'failed',
        summary: `Execution error: ${err instanceof Error ? err.message : String(err)}`,
        evidence: [],
      };
    }

    const framework = this.detectFramework();
    const parsed = this.parseTestOutput(stdout);
    const findings: string[] = [];

    // Rule: any failing test is a failed check.
    if (parsed.failed > 0) {
      findings.push(`${parsed.failed} test(s) failed`);
    }

    // Rule: zero tests executed is suspicious.
    const totalTests = parsed.passed + parsed.failed;
    if (totalTests === 0) {
      findings.push('Zero tests executed — suspicious');
    }

    // Rule: test-count drop versus prior snapshot (Rule 18 territory).
    if (this.priorSnapshots.length > 0) {
      const mostRecent = this.priorSnapshots[this.priorSnapshots.length - 1]!;
      if (parsed.passed + parsed.failed < mostRecent.testCount) {
        findings.push(
          `Test-count drop: ${mostRecent.testCount} → ${parsed.passed + parsed.failed} (prior passed: ${mostRecent.passed}, failed: ${mostRecent.failed})`,
        );
      }
    }

    // Persist snapshot for future comparisons regardless of outcome.
    this.priorSnapshots.push({
      testCount: totalTests,
      passed: parsed.passed,
      failed: parsed.failed,
      capturedAt: new Date().toISOString(),
    });

    const status: 'passed' | 'failed' = findings.length > 0 ? 'failed' : 'passed';
    const summary =
      findings.length > 0
        ? `${framework !== 'unknown' ? `[${framework}] ` : ''}${findings.join('; ')}`
        : `${framework !== 'unknown' ? `[${framework}] ` : ''}${parsed.passed} passed, ${parsed.failed} failed (${totalTests} total)`;

    return {
      name: 'test-verifier',
      status,
      summary,
      evidence: [],
    };
  }

  /**
   * Parse test output stdout into passed/failed counts and a list of suite
   * file paths. Delegates to the framework-specific parser determined by the
   * detected framework from config-file presence.
   *
   * When no framework is detected (unknown), falls back to a best-effort
   * universal parser.
   */
  parseTestOutput(stdout: string): TestOutputResult {
    const framework = this.detectFramework();
    switch (framework) {
      case 'vitest':
        return this.parseVitest(stdout);
      case 'jest':
        return this.parseJest(stdout);
      case 'mocha':
        return this.parseMocha(stdout);
      case 'pytest':
        return this.parsePytest(stdout);
      case 'cargo':
        return this.parseCargo(stdout);
      default:
        return this.parseSummaryLines(stdout);
    }
  }

  /**
   * Return the most recently captured TestCountSnapshot, or null if none exist.
   */
  getLastSnapshot(): TestCountSnapshot | null {
    return this.priorSnapshots.length > 0
      ? this.priorSnapshots[this.priorSnapshots.length - 1]!
      : null;
  }

  /**
   * Clear all stored snapshots (useful for testing or resetting state).
   */
  clearSnapshots(): void {
    this.priorSnapshots.length = 0;
  }

  // ─── framework detection ────────────────────────────────────────────────────

  /**
   * Detect the test framework by scanning for well-known config files in
   * projectRoot. Returns the first match; priority order mirrors common
   * project conventions.
   */
  private detectFramework(): DetectedFramework {
    const checks: [DetectedFramework, string[]][] = [
      [
        'vitest',
        [
          'vitest.config.ts',
          'vitest.config.js',
          'vitest.config.mjs',
          'vite.config.ts',
          'vite.config.js',
          'vite.config.mjs',
        ],
      ],
      [
        'jest',
        [
          'jest.config.ts',
          'jest.config.js',
          'jest.config.mjs',
          'jest.config.cjs',
          'jest.setup.js',
        ],
      ],
      [
        'mocha',
        [
          '.mocharc.js',
          '.mocharc.json',
          '.mocharc.yml',
          '.mocharc.yaml',
          '.mocharc.cjs',
          'mocha.opts',
        ],
      ],
      [
        'pytest',
        ['pytest.ini', 'pyproject.toml', 'setup.cfg'],
      ],
      ['cargo', ['Cargo.toml']],
    ];

    for (const [framework, patterns] of checks) {
      for (const pattern of patterns) {
        if (fs.existsSync(path.join(this.projectRoot, pattern))) {
          return framework;
        }
      }
    }

    // Fallback: check package.json for test command hints.
    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as {
          devDependencies?: Record<string, string>;
          dependencies?: Record<string, string>;
          scripts?: Record<string, string>;
        };
        const deps = { ...(pkg.devDependencies ?? {}), ...(pkg.dependencies ?? {}) };
        if ('jest' in deps) return 'jest';
        if ('vitest' in deps || 'vite' in deps) return 'vitest';
        if ('mocha' in deps) return 'mocha';
        if ('pytest' in deps) return 'pytest';
        if ('cargo' in deps) return 'cargo';
        const testScript = pkg.scripts?.test ?? '';
        if (testScript.includes('jest')) return 'jest';
        if (testScript.includes('vitest')) return 'vitest';
        if (testScript.includes('mocha')) return 'mocha';
        if (testScript.includes('pytest')) return 'pytest';
        if (testScript.includes('cargo test')) return 'cargo';
      } catch {
        // Malformed package.json — ignore
      }
    }

    return 'unknown';
  }

  // ─── output parsers ─────────────────────────────────────────────────────────

  /**
   * Parse vitest text output.
   *
   * Examples:
   *   ✓ tests/foo.test.ts > foo > passes one
   *   ❯ tests/bar.test.ts > bar > fails
   *     × fails
   *   Test Files  2 passed (2)
   *        Tests  3 passed (3)
   */
  private parseVitest(stdout: string): TestOutputResult {
    const lines = stdout.split('\n');
    const passedSet = new Set<string>();
    const failedSet = new Set<string>();
    const suites = new Set<string>();

    for (const line of lines) {
      // Match passing test lines: " ✓ path.ts > desc > test"
      if (/^\s*✓\s/.test(line)) {
        const pathMatch = line.match(/^\s*✓\s+(.+)/);
        if (pathMatch) {
          const suite = pathMatch[1]!.split(' > ')[0] ?? '';
          suites.add(suite.trim());
          passedSet.add(line.trim());
        }
      }
      // Match failing test block header: " ❯ path.ts > desc > test"
      if (/^\s*❯\s/.test(line)) {
        const pathMatch = line.match(/^\s*❯\s+(.+)/);
        if (pathMatch) {
          const suite = pathMatch[1]!.split(' > ')[0] ?? '';
          suites.add(suite.trim());
          failedSet.add(line.trim());
        }
      }
      // Match failing single-line tests: " × test name"
      if (/^\s*×\s/.test(line)) {
        failedSet.add(line.trim());
      }
    }

    // Fall back to summary line counts if individual lines didn't produce results.
    if (passedSet.size === 0 && failedSet.size === 0) {
      return this.parseSummaryLines(stdout);
    }

    return {
      passed: passedSet.size,
      failed: failedSet.size,
      suites: [...suites].sort(),
    };
  }

  /**
   * Parse jest text output.
   *
   * Examples:
   *   PASS  tests/unit/example.test.ts
   *    example
   *      ✓ passes one
   *      ✓ passes two
   *   Test Suites: 1 passed, 1 total
   *   Tests:       2 passed, 2 total
   */
  private parseJest(stdout: string): TestOutputResult {
    const lines = stdout.split('\n');
    const passedSet = new Set<string>();
    const failedSet = new Set<string>();
    const suites = new Set<string>();

    for (const rawLine of lines) {
      const line = rawLine.trim();
      // Detect suite file header: "PASS  path/to/file.test.ts" or "FAIL  ..."
      const passFailMatch = line.match(/^(PASS|FAIL)\s+(.+)/);
      if (passFailMatch) {
        suites.add(passFailMatch[2]!.trim());
        continue;
      }
      // Detect individual test results: "✓ passes one" or "✕ fails"
      if (line.startsWith('✓ ')) {
        passedSet.add(line.slice(2).trim());
      } else if (line.startsWith('✕ ')) {
        failedSet.add(line.slice(2).trim());
      }
    }

    // Fall back to summary line counts.
    if (passedSet.size === 0 && failedSet.size === 0) {
      return this.parseSummaryLines(stdout);
    }

    return {
      passed: passedSet.size,
      failed: failedSet.size,
      suites: [...suites].sort(),
    };
  }

  /**
   * Parse mocha text output.
   *
   * Examples:
   *    example
   *      ✓ passes one
   *      ✓ passes two
   *    2 passing (10ms)
   *
   * Failing:
   *    example
   *      ✓ passes one
   *      1) fails
   *    1 passing (10ms)
   *    1 failing
   */
  private parseMocha(stdout: string): TestOutputResult {
    const lines = stdout.split('\n');
    const passedSet = new Set<string>();
    const failedSet = new Set<string>();
    const suites = new Set<string>();

    let currentSuite = '';
    for (const line of lines) {
      // Suite headers are indented two spaces with no leading bullet.
      const suiteMatch = line.match(/^ {2}(.+)$/);
      if (suiteMatch && !line.startsWith('    ') && !/^\d+\)/.test(line)) {
        currentSuite = suiteMatch[1]!.trim();
        suites.add(currentSuite);
        continue;
      }
      // Passing: "    ✓ test name"
      if (/^\s+✓\s/.test(line)) {
        const name = line.replace(/^\s+✓\s/, '').trim();
        passedSet.add(name);
        continue;
      }
      // Failing: "    1) test name" or "    1) test name\n        error"
      const failMatch = line.match(/^\s+\d+\)\s+(.+)$/);
      if (failMatch) {
        failedSet.add(failMatch[1]!.trim());
        continue;
      }
    }

    // Fall back to summary line counts.
    if (passedSet.size === 0 && failedSet.size === 0) {
      return this.parseSummaryLines(stdout);
    }

    return {
      passed: passedSet.size,
      failed: failedSet.size,
      suites: [...suites].sort(),
    };
  }

  /**
   * Parse pytest text output.
   *
   * Examples:
   * tests/unit/test_example.py::test_passes_one PASSED
   * tests/unit/test_example.py::test_passes_two PASSED
   *
   * ========================= 2 passed in 0.01s ==========================
   *
   * Failing:
   * tests/unit/test_example.py::test_passes_one PASSED
   * tests/unit/test_example.py::test_passes_two FAILED
   *
   * ========================= 1 passed, 1 failed in 0.01s ==========================
   */
  private parsePytest(stdout: string): TestOutputResult {
    const lines = stdout.split('\n');
    const passedSet = new Set<string>();
    const failedSet = new Set<string>();
    const suites = new Set<string>();

    for (const line of lines) {
      // Individual test result lines: "path::test_name PASSED" or "FAILED"
      const testMatch = line.match(/^(.+?)::(\S+)\s+(PASSED|FAILED)$/);
      if (testMatch) {
        const fullPath = testMatch[1]!.trim();
        const testName = testMatch[2]!.trim();
        const status = testMatch[3]!.trim();
        suites.add(fullPath);
        if (status === 'PASSED') {
          passedSet.add(testName);
        } else {
          failedSet.add(testName);
        }
        continue;
      }
      // Skipped tests: "... SKIPPED"
      const skipMatch = line.match(/^(.+?)::(\S+)\s+SKIPPED$/);
      if (skipMatch) {
        suites.add(skipMatch[1]!.trim());
        continue;
      }
    }

    // Fall back to summary line counts.
    if (passedSet.size === 0 && failedSet.size === 0) {
      return this.parseSummaryLines(stdout);
    }

    return {
      passed: passedSet.size,
      failed: failedSet.size,
      suites: [...suites].sort(),
    };
  }

  /**
   * Parse cargo test text output.
   *
   * Examples:
   * running 2 tests
   * test tests::passes_one ... ok
   * test tests::passes_two ... ok
   *
   * test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
   *
   * Failing:
   * test tests::passes_two ... FAILED
   *
   * test result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out
   */
  private parseCargo(stdout: string): TestOutputResult {
    const lines = stdout.split('\n');
    const passedSet = new Set<string>();
    const failedSet = new Set<string>();
    const suites = new Set<string>();

    for (const line of lines) {
      // Test result lines: "test name ... ok" or "test name ... FAILED"
      const resultMatch = line.match(/^test\s+(.+?)\s+\.\.\.\s+(ok|FAILED)$/);
      if (resultMatch) {
        const testName = resultMatch[1]!.trim();
        const status = resultMatch[2]!.trim();
        // Use the module path as suite (everything before the last ::)
        const parts = testName.split('::');
        if (parts.length > 1) {
          suites.add(parts.slice(0, -1).join('::'));
        }
        if (status === 'ok') {
          passedSet.add(testName);
        } else {
          failedSet.add(testName);
        }
        continue;
      }
    }

    // Fall back to summary line counts.
    if (passedSet.size === 0 && failedSet.size === 0) {
      return this.parseSummaryLines(stdout);
    }

    return {
      passed: passedSet.size,
      failed: failedSet.size,
      suites: [...suites].sort(),
    };
  }

  /**
   * Universal fallback parser: scans all known output formats for summary
   * lines like "N passed", "N failed", "Test Files: N passed", etc.
   */
  private parseSummaryLines(stdout: string): TestOutputResult {
    const lines = stdout.split('\n');
    let passed = 0;
    let failed = 0;
    const suites = new Set<string>();

    for (const line of lines) {
      // Vitest-style: "Test Files  2 passed (2)" or "1 failed | 1 passed (2)"
      const vfMatch = line.match(/Test\s+Files\s*[|]?\s*(\d+)\s+failed.*?(\d+)\s+passed/i);
      if (vfMatch) {
        failed = parseInt(vfMatch[1]!, 10);
        passed = parseInt(vfMatch[2]!, 10);
        continue;
      }
      // Vitest-style: "     Tests  3 passed (3)"
      const vtMatch = line.match(/Tests?\s+[|]?\s*(\d+)\s+failed.*?(\d+)\s+passed/i);
      if (vtMatch) {
        failed = parseInt(vtMatch[1]!, 10);
        passed = parseInt(vtMatch[2]!, 10);
        continue;
      }
      // Jest-style: "Test Suites: 1 passed, 1 total"
      const jsMatch = line.match(/Test\s+Suites:\s*(\d+)\s+failed.*?(\d+)\s+passed/i);
      if (jsMatch) {
        failed = parseInt(jsMatch[1]!, 10);
        passed = parseInt(jsMatch[2]!, 10);
        continue;
      }
      // Jest-style: "Tests:       2 passed, 2 total"
      const jtMatch = line.match(/Tests?\s*[::]\s*(\d+)\s+failed.*?(\d+)\s+passed/i);
      if (jtMatch) {
        failed = parseInt(jtMatch[1]!, 10);
        passed = parseInt(jtMatch[2]!, 10);
        continue;
      }
      // Mocha-style: "N passing"
      const mpMatch = line.match(/^(\d+)\s+passing/);
      if (mpMatch) {
        passed = parseInt(mpMatch[1]!, 10);
        continue;
      }
      // Mocha-style: "N failing"
      const mfMatch = line.match(/^(\d+)\s+failing/);
      if (mfMatch) {
        failed = parseInt(mfMatch[1]!, 10);
        continue;
      }
      // Pytest-style: "N passed, M failed in ..."
      const ppMatch = line.match(/(\d+)\s+passed.*?(\d+)\s+failed/);
      if (ppMatch) {
        passed = parseInt(ppMatch[1]!, 10);
        failed = parseInt(ppMatch[2]!, 10);
        continue;
      }
      // Pytest-style (reversed): "N failed, M passed"
      const pfMatch = line.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
      if (pfMatch) {
        failed = parseInt(pfMatch[1]!, 10);
        passed = parseInt(pfMatch[2]!, 10);
        continue;
      }
      // Cargo-style: "N passed; M failed;"
      const cpMatch = line.match(/(\d+)\s+passed.*?(\d+)\s+failed/);
      if (cpMatch) {
        passed = parseInt(cpMatch[1]!, 10);
        failed = parseInt(cpMatch[2]!, 10);
        continue;
      }
      // Cargo-style (reversed): "N failed; M passed;"
      const cfMatch = line.match(/(\d+)\s+failed.*?(\d+)\s+passed/);
      if (cfMatch) {
        failed = parseInt(cfMatch[1]!, 10);
        passed = parseInt(cfMatch[2]!, 10);
        continue;
      }
      // Collect suite/file paths from lines like "✓ tests/foo.test.ts > ..."
      const suiteMatch = line.match(/^(✓|❯|✕)\s+([^\s>]+\.ts)/);
      if (suiteMatch) {
        suites.add(suiteMatch[2]!.trim());
      }
    }

    return {
      passed,
      failed,
      suites: [...suites].sort(),
    };
  }
}
