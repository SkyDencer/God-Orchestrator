import * as fs from 'node:fs';
import * as path from 'path';
import type { VerificationCheck } from './verification-result.js';
import type { TestSnapshot } from './verification-result.js';

/**
 * Shape of a vitest/istanbul coverage-summary.json report.
 */
interface CoverageSummaryReport {
  total: {
    lines: { total: number; covered: number; skipped: number; pct: number };
    statements: { total: number; covered: number; skipped: number; pct: number };
    functions: { total: number; covered: number; skipped: number; pct: number };
    branches: { total: number; covered: number; skipped: number; pct: number };
  };
  files: Record<string, unknown>;
}

/**
 * Shape of a vitest coverage-final.json report (per-file coverage map).
 */
interface CoverageFinalReport {
  [filePath: string]: {
    path: string;
    statementMap: Record<string, unknown>;
    fnMap: Record<string, unknown>;
    branchMap: Record<string, unknown>;
    s: Record<string, number>;
    f: Record<string, number>;
    b: Record<string, number[]>;
  };
}

/**
 * Coverage delta verifier.
 *
 * Reads the project's vitest coverage report, captures a baseline snapshot,
 * and compares a later snapshot against it.  The verdict is based on the
 * line-coverage percentage:
 *   - No coverage report  → inconclusive (never passed)
 *   - Delta < -2%        → failed (VIOLATION)
 *   - Delta >= -2%       → passed
 */
export class CoverageVerifier {
  private readonly coverageSummaryPath: string;
  private readonly coverageFinalPath: string;

  constructor(projectRoot: string) {
    this.coverageSummaryPath = path.resolve(projectRoot, 'coverage', 'coverage-summary.json');
    this.coverageFinalPath = path.resolve(projectRoot, 'coverage', 'coverage-final.json');
  }

  /**
   * Read the latest coverage report and return a TestSnapshot reflecting the
   * current line-coverage percentage.
   */
  async captureBaseline(): Promise<TestSnapshot> {
    const pct = this.readCoveragePercentage();
    if (pct === null) {
      throw new Error('No coverage report found. Run vitest with coverage enabled first.');
    }
    return {
      testFiles: [],
      fileHashes: {},
      assertionCount: 0,
      skipCount: 0,
      coveragePct: pct,
      testConfigHash: '',
    };
  }

  /**
   * Compare the current coverage against a previously captured baseline.
   */
  async compareAfter(before: TestSnapshot): Promise<VerificationCheck> {
    const afterPct = this.readCoveragePercentage();

    if (afterPct === null) {
      return {
        name: 'coverage-delta',
        status: 'inconclusive',
        summary: 'No coverage report available — cannot evaluate delta',
        evidence: [],
      };
    }

    const delta = afterPct - before.coveragePct;

    if (delta < -2) {
      return {
        name: 'coverage-delta',
        status: 'failed',
        summary: `Coverage dropped by ${Math.abs(delta).toFixed(1)} pp (baseline: ${before.coveragePct.toFixed(1)}%, current: ${afterPct.toFixed(1)}%). Threshold: -2 pp`,
        evidence: [],
      };
    }

    return {
      name: 'coverage-delta',
      status: 'passed',
      summary: `Coverage delta: ${delta >= 0 ? '+' : ''}${delta.toFixed(1)} pp (baseline: ${before.coveragePct.toFixed(1)}%, current: ${afterPct.toFixed(1)}%)`,
      evidence: [],
    };
  }

  // ------------------------------------------------------------------ internals

  /**
   * Read the latest available coverage report and return the overall line
   * coverage percentage, or null if no report exists.
   *
   * Priority: coverage-summary.json (istanbul-style summary) >
   *           coverage-final.json (per-file map, totals computed)
   */
  private readCoveragePercentage(): number | null {
    if (fs.existsSync(this.coverageSummaryPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.coverageSummaryPath, 'utf8')) as CoverageSummaryReport;
        return data.total?.lines?.pct ?? null;
      } catch {
        // Malformed JSON — fall through to next candidate
      }
    }

    if (fs.existsSync(this.coverageFinalPath)) {
      try {
        const data = JSON.parse(fs.readFileSync(this.coverageFinalPath, 'utf8')) as CoverageFinalReport;
        let totalStatements = 0;
        let coveredStatements = 0;
        for (const fileData of Object.values(data)) {
          for (const count of Object.values(fileData.s)) {
            totalStatements++;
            if (count > 0) {
              coveredStatements++;
            }
          }
        }
        if (totalStatements === 0) {
          return 0;
        }
        return (coveredStatements / totalStatements) * 100;
      } catch {
        // Malformed JSON
      }
    }

    return null;
  }
}
