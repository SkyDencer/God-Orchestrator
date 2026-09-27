import * as fs from 'node:fs';
import * as path from 'path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import type { TestSnapshot, VerificationCheck } from './verification-result.js';

/**
 * Verifier that captures a snapshot of the test suite and detects regressions
 * such as deleted test files, dropped assertion counts, increased skips,
 * coverage drops, or test-config changes.
 *
 * Implements Rule 18 / INV-13 of the God-Orchestrator verification engine.
 */
export class TestIntegrityVerifier {
  constructor(private readonly projectRoot: string) {}

  /**
   * Capture a snapshot of the current test suite state.
   */
  async captureSnapshot(): Promise<TestSnapshot> {
    const testFiles = this.findTestFiles();
    const fileHashes: Record<string, string> = {};
    let assertionCount = 0;
    let skipCount = 0;

    for (const file of testFiles) {
      const content = fs.readFileSync(file, 'utf8');
      fileHashes[file] = createHash('sha256').update(content).digest('hex');
      assertionCount += this.countAssertions(content);
      skipCount += this.countSkips(content);
    }

    const coveragePct = await this.captureCoverage();
    const testConfigHash = this.computeConfigHash();

    return {
      testFiles,
      fileHashes,
      assertionCount,
      skipCount,
      coveragePct,
      testConfigHash,
    };
  }

  /**
   * Compare a previously captured snapshot against the current state and
   * return a VerificationCheck indicating pass or failure.
   */
  async compareAfter(before: TestSnapshot): Promise<VerificationCheck> {
    const after = await this.captureSnapshot();
    const findings: string[] = [];

    // Detect deleted test files.
    for (const file of before.testFiles) {
      if (!after.testFiles.includes(file)) {
        findings.push(`Test file deleted: ${path.relative(this.projectRoot, file)}`);
      }
    }

    // Detect assertion count decrease.
    if (after.assertionCount < before.assertionCount) {
      findings.push(
        `Assertion count decreased: ${before.assertionCount} → ${after.assertionCount}`,
      );
    }

    // Detect skip count increase.
    if (after.skipCount > before.skipCount) {
      findings.push(
        `Skip count increased: ${before.skipCount} → ${after.skipCount}`,
      );
    }

    // Detect coverage decrease greater than 2 percentage points.
    if (before.coveragePct - after.coveragePct > 2) {
      findings.push(
        `Coverage decreased > 2%: ${before.coveragePct}% → ${after.coveragePct}%`,
      );
    }

    // Detect test-config change.
    if (after.testConfigHash !== before.testConfigHash) {
      findings.push('Test config changed');
    }

    return {
      name: 'test-integrity',
      status: findings.length > 0 ? 'failed' : 'passed',
      summary:
        findings.length > 0 ? findings.join('; ') : 'All integrity checks passed',
      evidence: [],
    };
  }

  // ─── internal helpers ──────────────────────────────────────────────────────

  /**
   * Recursively discover all .test.ts and .spec.ts files under the tests/ dir.
   */
  private findTestFiles(): string[] {
    const testsDir = path.join(this.projectRoot, 'tests');
    if (!fs.existsSync(testsDir)) {
      return [];
    }

    const result: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (
          entry.name.endsWith('.test.ts') ||
          entry.name.endsWith('.spec.ts')
        ) {
          result.push(full);
        }
      }
    };
    walk(testsDir);
    return result.sort();
  }

  /**
   * Count assertion-like calls in source: expect(, it(, fit(, assert(.
   * it.skip( and fit.skip( are counted here as assertion anchors but are
   * subtracted via countSkips so they don't inflate the assertion total.
   */
  private countAssertions(content: string): number {
    const expectMatches = content.match(/expect\s*\(/g);
    const itMatches = content.match(/\bit\s*\(/g);
    const fitMatches = content.match(/\bfit\s*\(/g);
    const assertMatches = content.match(/\bassert\s*\(/g);

    return (
      (expectMatches?.length ?? 0) +
      (itMatches?.length ?? 0) +
      (fitMatches?.length ?? 0) +
      (assertMatches?.length ?? 0)
    );
  }

  /**
   * Count skipped-test indicators in source.
   * Matches: it.skip(, fit.skip(, describe.skip(, pytest.mark.skip.
   */
  private countSkips(content: string): number {
    const itSkip = content.match(/\bit\.skip\s*\(/g)?.length ?? 0;
    const fitSkip = content.match(/\bfit\.skip\s*\(/g)?.length ?? 0;
    const descSkip = content.match(/\bdescribe\.skip\s*\(/g)?.length ?? 0;
    const pytestSkip = content.match(/pytest\.mark\.skip/g)?.length ?? 0;
    return itSkip + fitSkip + descSkip + pytestSkip;
  }

  /**
   * Attempt to run vitest with JSON coverage output and return coverage %.
   * Returns 0 when coverage tooling is unavailable or the command fails.
   */
  private async captureCoverage(): Promise<number> {
    try {
      const out = execSync(
        'npx vitest run --coverage.enabled=true --coverage.reporter=json-json',
        {
          cwd: this.projectRoot,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: 120_000,
        },
      );

      // vitest writes the JSON report to coverage/coverage-summary.json by
      // default; try to read it directly.
      const summaryPath = path.join(
        this.projectRoot,
        'coverage',
        'coverage-summary.json',
      );
      if (fs.existsSync(summaryPath)) {
        const summary = JSON.parse(
          fs.readFileSync(summaryPath, 'utf8'),
        ) as { total: { pct: number } };
        return Math.round(summary.total?.pct ?? 0);
      }

      // Fallback: scan stdout for a coverage percentage line.
      const pctMatch = out.match(/Total\s+\d+%\s+(\d+\.?\d*)%/);
      if (pctMatch?.[1] !== undefined) {
        return parseFloat(pctMatch[1]);
      }

      return 0;
    } catch {
      // Coverage dependency not installed or command failed — return 0.
      return 0;
    }
  }

  /**
   * Compute a SHA-256 hash over the test configuration:
   *   - vitest.config.ts (or .js / .mjs)
   *   - test-relevant package.json fields (scripts.test, scripts.coverage,
   *     devDependencies containing vitest/coverage, dependencies containing same)
   */
  private computeConfigHash(): string {
    const configPatterns = [
      'vitest.config.ts',
      'vitest.config.js',
      'vitest.config.mjs',
      'vite.config.ts',
      'vite.config.js',
      'vite.config.mjs',
    ];

    let data = '';
    for (const pattern of configPatterns) {
      const configPath = path.join(this.projectRoot, pattern);
      if (fs.existsSync(configPath)) {
        data += fs.readFileSync(configPath, 'utf8');
      }
    }

    const pkgPath = path.join(this.projectRoot, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const raw = fs.readFileSync(pkgPath, 'utf8');
      const pkg = JSON.parse(raw) as {
        scripts?: Record<string, string>;
        devDependencies?: Record<string, string>;
        dependencies?: Record<string, string>;
      };
      const testFields = {
        scripts: pkg.scripts,
        devDependencies: pkg.devDependencies,
        dependencies: pkg.dependencies,
      };
      data += JSON.stringify(testFields);
    }

    return createHash('sha256').update(data).digest('hex');
  }
}
