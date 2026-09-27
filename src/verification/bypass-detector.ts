import type { BypassFinding, TestSnapshot } from './verification-result.js';

/**
 * Detects test-suite bypass attempts by comparing before/after TestSnapshot pairs.
 *
 * Implements INV-12: every verification has a bypass check.
 */
export class BypassDetector {
  constructor(private readonly projectRoot: string) {}

  /**
   * Detect test-file deletion between two snapshots.
   * Returns a finding when any file present in `before` is absent from `after`.
   */
  detectTestDeletion(before: TestSnapshot, after: TestSnapshot): BypassFinding | null {
    const deleted = before.testFiles.filter((file) => !after.testFiles.includes(file));
    if (deleted.length === 0) return null;

    const displayPaths = deleted.map((f) => f.replace(this.projectRoot + '\\', '').replace(this.projectRoot + '/', ''));

    return {
      type: 'test-deletion',
      severity: 'critical',
      description: `Test file(s) deleted: ${displayPaths.join(', ')}`,
      location: deleted[0]!,
    };
  }

  /**
   * Detect increased test skipping between two snapshots.
   * Returns a finding when `after.skipCount` exceeds `before.skipCount`.
   */
  detectTestSkipping(before: TestSnapshot, after: TestSnapshot): BypassFinding | null {
    if (after.skipCount <= before.skipCount) return null;

    return {
      type: 'test-skipping',
      severity: 'high',
      description: `Skip count increased from ${before.skipCount} to ${after.skipCount} (+${after.skipCount - before.skipCount})`,
      location: 'test-suite',
    };
  }

  /**
   * Detect assertion weakening between two snapshots.
   * Returns a finding when `after.assertionCount` is strictly less than `before.assertionCount`.
   */
  detectAssertionWeakening(before: TestSnapshot, after: TestSnapshot): BypassFinding | null {
    if (after.assertionCount >= before.assertionCount) return null;

    return {
      type: 'assertion-weakening',
      severity: 'high',
      description: `Assertion count decreased from ${before.assertionCount} to ${after.assertionCount} (-${before.assertionCount - after.assertionCount})`,
      location: 'test-suite',
    };
  }

  /**
   * Detect mock / fixture manipulation between two snapshots.
   *
   * Heuristic: a bypass signal fires when one or more test-fixture/test-file
   * hashes change between snapshots, AND the net assertion count does not
   * increase to compensate.  Specifically:
   *   - At least one hash in `before.fileHashes` differs in `after.fileHashes`
     (or a file disappeared entirely), AND
   *   - `after.assertionCount <= before.assertionCount`.
   *
   * This captures the pattern where an adversary edits a fixture or helper so
   * existing assertions trivially pass without adding new verification.
   */
  detectMockManipulation(before: TestSnapshot, after: TestSnapshot): BypassFinding | null {
    const changedFiles = this.findChangedFiles(before, after);
    if (changedFiles.length === 0) return null;
    if (after.assertionCount > before.assertionCount) return null;

    return {
      type: 'mock-manipulation',
      severity: 'medium',
      description: `File(s) modified without assertion increase (${changedFiles.length} changed, assertions ${before.assertionCount}→${after.assertionCount}): ${changedFiles.join(', ')}`,
      location: changedFiles[0]!,
    };
  }

  /**
   * Detect test-config change between two snapshots.
   * Returns a finding when `after.testConfigHash` differs from `before.testConfigHash`.
   */
  detectConfigChange(before: TestSnapshot, after: TestSnapshot): BypassFinding | null {
    if (after.testConfigHash === before.testConfigHash) return null;

    return {
      type: 'config-change',
      severity: 'medium',
      description: 'Test configuration hash changed between snapshots',
      location: 'test-config',
    };
  }

  /**
   * Detect coverage gaming between two snapshots.
   *
   * The classic gaming signal: coverage percentage rises while assertion count
   * drops or stays flat — suggesting code paths are being exercised without
   * genuine verification (e.g. by removing assertions but leaving stubs that
   * still execute).
   *
   * Returns a finding when `after.coveragePct > before.coveragePct` AND
   * `after.assertionCount <= before.assertionCount`.
   */
  detectCoverageGaming(before: TestSnapshot, after: TestSnapshot): BypassFinding | null {
    if (after.coveragePct <= before.coveragePct) return null;
    if (after.assertionCount > before.assertionCount) return null;

    return {
      type: 'coverage-gaming',
      severity: 'high',
      description: `Coverage increased from ${before.coveragePct}% to ${after.coveragePct}% while assertions dropped from ${before.assertionCount} to ${after.assertionCount}`,
      location: 'test-suite',
    };
  }

  /**
   * Run every detector and return the aggregated list of findings.
   * Empty when no bypass signals are present.
   */
  scan(before: TestSnapshot, after: TestSnapshot): BypassFinding[] {
    return [
      this.detectTestDeletion(before, after),
      this.detectTestSkipping(before, after),
      this.detectAssertionWeakening(before, after),
      this.detectMockManipulation(before, after),
      this.detectConfigChange(before, after),
      this.detectCoverageGaming(before, after),
    ].filter((f): f is BypassFinding => f !== null);
  }

  // ------------------------------------------------------------------ internals

  /**
   * Return a list of file paths whose hash changed between the two snapshots,
   * including files that existed in `before` but disappeared in `after`.
   */
  private findChangedFiles(before: TestSnapshot, after: TestSnapshot): string[] {
    const changed: string[] = [];

    for (const file of before.testFiles) {
      const beforeHash = before.fileHashes[file];
      const afterHash = after.fileHashes[file];
      if (beforeHash !== afterHash) {
        changed.push(file);
      }
    }

    return changed;
  }
}
