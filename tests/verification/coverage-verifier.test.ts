import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CoverageVerifier } from '../../src/verification/coverage-verifier.js';
import type { TestSnapshot } from '../../src/verification/verification-result.js';

// ─── helpers ──────────────────────────────────────────────────────────────────

/**
 * Create a temporary directory with a vitest-style coverage-summary.json.
 */
function writeCoverageSummary(tmpDir: string, pct: number): void {
  const coverageDir = path.join(tmpDir, 'coverage');
  fs.mkdirSync(coverageDir, { recursive: true });
  const summary: unknown = {
    total: {
      lines: { total: 100, covered: Math.round(pct), skipped: 0, pct },
      statements: { total: 100, covered: Math.round(pct), skipped: 0, pct },
      functions: { total: 10, covered: Math.round(pct * 0.1), skipped: 0, pct },
      branches: { total: 20, covered: Math.round(pct * 0.2), skipped: 0, pct },
    },
    files: {
      'src/foo.ts': {
        path: 'src/foo.ts',
        statementMap: {},
        fnMap: {},
        branchMap: {},
        s: {},
        f: {},
        b: {},
      },
    },
  };
  fs.writeFileSync(
    path.join(coverageDir, 'coverage-summary.json'),
    JSON.stringify(summary, null, 2),
    'utf8',
  );
}

/**
 * Create a temporary directory with a coverage-final.json (per-file map).
 */
function writeCoverageFinal(tmpDir: string, pct: number): void {
  const coverageDir = path.join(tmpDir, 'coverage');
  fs.mkdirSync(coverageDir, { recursive: true });
  const totalStmts = 100;
  const coveredStmts = Math.round(pct);
  const statements: Record<string, number> = {};
  for (let i = 0; i < totalStmts; i++) {
    statements[`s${i}`] = i < coveredStmts ? 1 : 0;
  }
  const finalReport: Record<string, unknown> = {
    'src/foo.ts': {
      path: 'src/foo.ts',
      statementMap: {},
      fnMap: {},
      branchMap: {},
      s: statements,
      f: {},
      b: {},
    },
  };
  fs.writeFileSync(
    path.join(coverageDir, 'coverage-final.json'),
    JSON.stringify(finalReport, null, 2),
    'utf8',
  );
}

// ─── tests ─────────────────────────────────────────────────────────────────────

describe('CoverageVerifier', () => {
  it('captures baseline from coverage-summary.json', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageSummary(tmpDir, 85);
      const verifier = new CoverageVerifier(tmpDir);
      const snapshot = await verifier.captureBaseline();

      expect(snapshot.coveragePct).toBe(85);
      expect(snapshot.testFiles).toEqual([]);
      expect(snapshot.fileHashes).toEqual({});
      expect(snapshot.assertionCount).toBe(0);
      expect(snapshot.skipCount).toBe(0);
      expect(snapshot.testConfigHash).toBe('');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('captures baseline from coverage-final.json when summary is absent', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageFinal(tmpDir, 72);
      const verifier = new CoverageVerifier(tmpDir);
      const snapshot = await verifier.captureBaseline();

      expect(snapshot.coveragePct).toBe(72);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('throws on captureBaseline when no coverage report exists', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      const verifier = new CoverageVerifier(tmpDir);
      await expect(verifier.captureBaseline()).rejects.toThrow('No coverage report found');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns passed for stable coverage (delta == 0)', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageSummary(tmpDir, 80);
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };
      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('passed');
      expect(result.name).toBe('coverage-delta');
      expect(result.summary).toContain('0.0 pp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns passed when coverage increases', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageSummary(tmpDir, 85);
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };
      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('passed');
      expect(result.summary).toContain('+5.0 pp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns passed for a small drop within the 2 pp tolerance', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageSummary(tmpDir, 79);
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };
      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('passed');
      expect(result.summary).toContain('-1.0 pp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns failed when coverage drops more than 2 pp', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageSummary(tmpDir, 77);
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };
      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('failed');
      expect(result.name).toBe('coverage-delta');
      expect(result.summary).toContain('3.0 pp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns failed for a large drop of 10 pp', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      writeCoverageSummary(tmpDir, 50);
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };
      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('30.0 pp');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns inconclusive when no coverage report exists after baseline', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      // Write a baseline report first
      writeCoverageSummary(tmpDir, 80);
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };

      // Remove the coverage report to simulate it disappearing
      fs.rmSync(path.join(tmpDir, 'coverage'), { recursive: true, force: true });

      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('inconclusive');
      expect(result.summary).toContain('No coverage report available');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('returns inconclusive when baseline was captured without a report but compareAfter also has none', async () => {
    // This tests the case where even the baseline capture would fail,
    // but compareAfter is called directly with a manually-created snapshot
    // and there's still no report.
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      const verifier = new CoverageVerifier(tmpDir);
      const before: TestSnapshot = {
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 0,
        coveragePct: 80,
        testConfigHash: '',
      };

      const result = await verifier.compareAfter(before);

      expect(result.status).toBe('inconclusive');
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('prefers coverage-summary.json over coverage-final.json when both exist', async () => {
    const tmpDir = fs.mkdtempSync(path.join(fs.realpathSync(process.env.TEMP ?? '/tmp'), 'god-cov-'));
    try {
      // Write summary with 85%
      writeCoverageSummary(tmpDir, 85);
      // Write final with a different percentage (would give 70% if used)
      writeCoverageFinal(tmpDir, 70);

      const verifier = new CoverageVerifier(tmpDir);
      const snapshot = await verifier.captureBaseline();

      // Should use summary (85%), not final (70%)
      expect(snapshot.coveragePct).toBe(85);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
