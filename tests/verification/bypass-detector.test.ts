import { describe, it, expect } from 'vitest';
import { BypassDetector } from '../../src/verification/bypass-detector.js';
import type { TestSnapshot } from '../../src/verification/verification-result.js';

const PROJECT_ROOT = '/fake/project/root';

function makeDetector(): BypassDetector {
  return new BypassDetector(PROJECT_ROOT);
}

/**
 * Build a minimal baseline TestSnapshot.
 */
function baselineSnapshot(overrides?: Partial<TestSnapshot>): TestSnapshot {
  return {
    testFiles: [
      'tests/unit/alpha.test.ts',
      'tests/unit/beta.test.ts',
    ],
    fileHashes: {
      'tests/unit/alpha.test.ts': 'aaa111',
      'tests/unit/beta.test.ts': 'bbb222',
    },
    assertionCount: 10,
    skipCount: 1,
    coveragePct: 80,
    testConfigHash: 'config-hash-abc',
    ...overrides,
  };
}

describe('BypassDetector', () => {
  const detector = makeDetector();

  // ── detectTestDeletion ─────────────────────────────────────────────────────

  describe('detectTestDeletion', () => {
    it('returns null when no files were deleted', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.detectTestDeletion(before, after)).toBeNull();
    });

    it('returns null when extra files are added (no deletion)', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({
        testFiles: [...before.testFiles, 'tests/unit/gamma.test.ts'],
        fileHashes: { ...before.fileHashes, 'tests/unit/gamma.test.ts': 'ccc333' },
      });
      expect(detector.detectTestDeletion(before, after)).toBeNull();
    });

    it('returns a critical finding when a test file is deleted', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({
        testFiles: ['tests/unit/alpha.test.ts'],
        fileHashes: { 'tests/unit/alpha.test.ts': 'aaa111' },
      });
      const finding = detector.detectTestDeletion(before, after);

      expect(finding).not.toBeNull();
      expect(finding!.type).toBe('test-deletion');
      expect(finding!.severity).toBe('critical');
      expect(finding!.description).toContain('beta.test.ts');
      expect(finding!.location).toBe('tests/unit/beta.test.ts');
    });

    it('returns a finding when all test files are deleted', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({ testFiles: [], fileHashes: {} });
      const finding = detector.detectTestDeletion(before, after);

      expect(finding).not.toBeNull();
      expect(finding!.type).toBe('test-deletion');
      expect(finding!.severity).toBe('critical');
    });
  });

  // ── detectTestSkipping ──────────────────────────────────────────────────────

  describe('detectTestSkipping', () => {
    it('returns null when skip count is unchanged', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.detectTestSkipping(before, after)).toBeNull();
    });

    it('returns null when skip count decreases', () => {
      const before = baselineSnapshot({ skipCount: 3 });
      const after = baselineSnapshot({ skipCount: 1 });
      expect(detector.detectTestSkipping(before, after)).toBeNull();
    });

    it('returns a high-severity finding when skip count increases', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({ skipCount: 5 });
      const finding = detector.detectTestSkipping(before, after);

      expect(finding).not.toBeNull();
      expect(finding!.type).toBe('test-skipping');
      expect(finding!.severity).toBe('high');
      expect(finding!.description).toContain('1 to 5');
      expect(finding!.location).toBe('test-suite');
    });
  });

  // ── detectAssertionWeakening ────────────────────────────────────────────────

  describe('detectAssertionWeakening', () => {
    it('returns null when assertion count is unchanged', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.detectAssertionWeakening(before, after)).toBeNull();
    });

    it('returns null when assertion count increases', () => {
      const before = baselineSnapshot({ assertionCount: 5 });
      const after = baselineSnapshot({ assertionCount: 10 });
      expect(detector.detectAssertionWeakening(before, after)).toBeNull();
    });

    it('returns a high-severity finding when assertion count drops', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({ assertionCount: 3 });
      const finding = detector.detectAssertionWeakening(before, after);

      expect(finding).not.toBeNull();
      expect(finding!.type).toBe('assertion-weakening');
      expect(finding!.severity).toBe('high');
      expect(finding!.description).toContain('10 to 3');
      expect(finding!.location).toBe('test-suite');
    });
  });

  // ── detectMockManipulation ──────────────────────────────────────────────────

  describe('detectMockManipulation', () => {
    it('returns null when no file hashes changed', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.detectMockManipulation(before, after)).toBeNull();
    });

    it('returns null when hashes changed but assertions also increased', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({
        assertionCount: 15,
        fileHashes: {
          'tests/unit/alpha.test.ts': 'changed-hash-aaa',
          'tests/unit/beta.test.ts': 'bbb222',
        },
      });
      expect(detector.detectMockManipulation(before, after)).toBeNull();
    });

    it('returns a medium-severity finding when hashes change without assertion increase',
      () => {
        const before = baselineSnapshot();
        const after = baselineSnapshot({
          assertionCount: 8,
          fileHashes: {
            'tests/unit/alpha.test.ts': 'changed-hash-aaa',
            'tests/unit/beta.test.ts': 'bbb222',
          },
        });
        const finding = detector.detectMockManipulation(before, after);

        expect(finding).not.toBeNull();
        expect(finding!.type).toBe('mock-manipulation');
        expect(finding!.severity).toBe('medium');
        expect(finding!.description).toContain('changed');
        expect(finding!.description).toContain('8');
        expect(finding!.location).toBe('tests/unit/alpha.test.ts');
      });

    it('returns a finding when a file hash changes and assertions stay flat',
      () => {
        const before = baselineSnapshot();
        const after = baselineSnapshot({
          assertionCount: 10,
          fileHashes: {
            'tests/unit/alpha.test.ts': 'changed-hash-aaa',
            'tests/unit/beta.test.ts': 'bbb222',
          },
        });
        const finding = detector.detectMockManipulation(before, after);

        expect(finding).not.toBeNull();
        expect(finding!.type).toBe('mock-manipulation');
      });

    it('returns a finding when a file disappears (hash effectively changed to undefined)',
      () => {
        const before = baselineSnapshot();
        const after = baselineSnapshot({
          assertionCount: 10,
          testFiles: ['tests/unit/alpha.test.ts'],
          fileHashes: { 'tests/unit/alpha.test.ts': 'aaa111' },
        });
        const finding = detector.detectMockManipulation(before, after);

        expect(finding).not.toBeNull();
        expect(finding!.type).toBe('mock-manipulation');
      });
  });

  // ── detectConfigChange ──────────────────────────────────────────────────────

  describe('detectConfigChange', () => {
    it('returns null when config hash is unchanged', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.detectConfigChange(before, after)).toBeNull();
    });

    it('returns a medium-severity finding when config hash differs', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({ testConfigHash: 'different-config-hash' });
      const finding = detector.detectConfigChange(before, after);

      expect(finding).not.toBeNull();
      expect(finding!.type).toBe('config-change');
      expect(finding!.severity).toBe('medium');
      expect(finding!.description).toContain('changed');
      expect(finding!.location).toBe('test-config');
    });
  });

  // ── detectCoverageGaming ────────────────────────────────────────────────────

  describe('detectCoverageGaming', () => {
    it('returns null when coverage is unchanged', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.detectCoverageGaming(before, after)).toBeNull();
    });

    it('returns null when coverage drops', () => {
      const before = baselineSnapshot({ coveragePct: 90 });
      const after = baselineSnapshot({ coveragePct: 80 });
      expect(detector.detectCoverageGaming(before, after)).toBeNull();
    });

    it('returns null when coverage rises AND assertions also rise', () => {
      const before = baselineSnapshot({ coveragePct: 70, assertionCount: 5 });
      const after = baselineSnapshot({ coveragePct: 85, assertionCount: 12 });
      expect(detector.detectCoverageGaming(before, after)).toBeNull();
    });

    it('returns a high-severity finding when coverage rises but assertions drop',
      () => {
        const before = baselineSnapshot({ coveragePct: 75, assertionCount: 10 });
        const after = baselineSnapshot({ coveragePct: 90, assertionCount: 5 });
        const finding = detector.detectCoverageGaming(before, after);

        expect(finding).not.toBeNull();
        expect(finding!.type).toBe('coverage-gaming');
        expect(finding!.severity).toBe('high');
        expect(finding!.description).toContain('75% to 90%');
        expect(finding!.description).toContain('10 to 5');
        expect(finding!.location).toBe('test-suite');
      });

    it('returns a finding when coverage rises and assertions stay flat',
      () => {
        const before = baselineSnapshot({ coveragePct: 75 });
        const after = baselineSnapshot({ coveragePct: 85, assertionCount: 10 });
        const finding = detector.detectCoverageGaming(before, after);

        expect(finding).not.toBeNull();
        expect(finding!.type).toBe('coverage-gaming');
        expect(finding!.severity).toBe('high');
      });
  });

  // ── scan (aggregation) ──────────────────────────────────────────────────────

  describe('scan', () => {
    it('returns an empty array when snapshots are identical', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot();
      expect(detector.scan(before, after)).toEqual([]);
    });

    it('aggregates multiple bypass types into one findings array', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({
        testFiles: ['tests/unit/alpha.test.ts'],
        fileHashes: { 'tests/unit/alpha.test.ts': 'changed-aaa' },
        assertionCount: 5,
        skipCount: 4,
        coveragePct: 95,
        testConfigHash: 'new-config-hash',
      });
      const findings = detector.scan(before, after);

      const types = findings.map((f) => f.type);
      expect(types).toContain('test-deletion');
      expect(types).toContain('assertion-weakening');
      expect(types).toContain('test-skipping');
      expect(types).toContain('mock-manipulation');
      expect(types).toContain('config-change');
      expect(types).toContain('coverage-gaming');
      expect(findings).toHaveLength(6);
    });

    it('returns findings in deterministic detector order', () => {
      const before = baselineSnapshot();
      const after = baselineSnapshot({
        testFiles: [],
        fileHashes: {},
        assertionCount: 0,
        skipCount: 99,
        coveragePct: 100,
        testConfigHash: 'x',
      });
      const findings = detector.scan(before, after);
      expect(findings.map((f) => f.type)).toEqual([
        'test-deletion',
        'test-skipping',
        'assertion-weakening',
        'mock-manipulation',
        'config-change',
        'coverage-gaming',
      ]);
    });

    it('returns only the triggered findings when some detectors pass', () => {
      const before = baselineSnapshot();
      // Only change config hash — all other detectors should pass.
      const after = baselineSnapshot({ testConfigHash: 'different' });
      const findings = detector.scan(before, after);

      expect(findings).toHaveLength(1);
      expect(findings[0].type).toBe('config-change');
    });
  });
});
