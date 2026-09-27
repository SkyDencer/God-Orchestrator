# Phase 2.11 — Bypass Detector Report

**Date:** 2026-09-27
**Subphase:** 2.11 — INV-12 bypass check
**Implementer:** verifier-2.11 (Agnes-2.5-Flash)

## What Was Built

### `src/verification/bypass-detector.ts`
A new `BypassDetector` class that detects six classes of test-suite bypass attempts by comparing `TestSnapshot` pairs (imported from `verification-result.ts:84`).

**Public API:**
- `constructor(projectRoot: string)` — stores project root for path display normalisation
- `detectTestDeletion(before, after): BypassFinding | null` — finds test files present in `before` but absent in `after`; severity `critical`
- `detectTestSkipping(before, after): BypassFinding | null` — fires when `after.skipCount > before.skipCount`; severity `high`
- `detectAssertionWeakening(before, after): BypassFinding | null` — fires when `after.assertionCount < before.assertionCount`; severity `high`
- `detectMockManipulation(before, after): BypassFinding | null` — fires when one or more file hashes changed **and** `after.assertionCount <= before.assertionCount`; severity `medium`
- `detectConfigChange(before, after): BypassFinding | null` — fires when `after.testConfigHash !== before.testConfigHash`; severity `medium`
- `detectCoverageGaming(before, after): BypassFinding | null` — fires when `after.coveragePct > before.coveragePct` **and** `after.assertionCount <= before.assertionCount`; severity `high`
- `scan(before, after): BypassFinding[]` — runs all six detectors and returns the aggregated, non-null findings in deterministic order

### Mock-manipulation heuristic (documented)
The mock-manipulation detector uses a two-part heuristic:
1. At least one test-file hash in `before.fileHashes` differs from the corresponding value in `after.fileHashes`, OR a file present in `before` is absent from `after` (its hash becomes `undefined`).
2. The net assertion count did **not** increase (`after.assertionCount <= before.assertionCount`).

This captures the pattern where an adversary edits a fixture, mock helper, or test-file so existing assertions trivially pass without adding new verification. If assertions increase proportionally with the file changes, the heuristic assumes legitimate test expansion rather than weakening.

### Coverage-gaming signal
Coverage-gaming detects the classic indicator: coverage percentage rises while assertion count drops or stays flat. This suggests code paths are being exercised (e.g., by removing failing assertions and replacing them with no-ops or stubs that still execute) without genuine verification depth.

### `tests/verification/bypass-detector.test.ts`
26 tests covering every detector in isolation, the clean-pair case, multi-type aggregation, and deterministic ordering. All 26 pass.

## Targeted Test Results

```
$ npx vitest run tests/verification/bypass-detector.test.ts

✓ tests/verification/bypass-detector.test.ts (26 tests) 20ms

Test Files  1 passed (1)
     Tests  26 passed (26)
 Duration  659ms
```

## Lint & Typecheck Results

```
$ npx eslint src/verification/bypass-detector.ts tests/verification/bypass-detector.test.ts
(0 errors, 0 warnings)

$ npx tsc --noEmit
(0 errors)
```

## Spec Compliance

| Requirement | Status |
|---|---|
| `BypassDetector` class with `constructor(projectRoot)` | ✅ |
| `detectTestDeletion(before, after)` | ✅ |
| `detectTestSkipping(before, after)` | ✅ |
| `detectAssertionWeakening(before, after)` | ✅ |
| `detectMockManipulation(before, after)` | ✅ |
| `detectConfigChange(before, after)` | ✅ |
| `detectCoverageGaming(before, after)` | ✅ |
| `scan()` aggregates every finding | ✅ |
| All detectors operate on `TestSnapshot` pairs | ✅ |
| Tests: each bypass type detected in isolation | ✅ (16 isolated tests) |
| Tests: clean pair → no findings | ✅ |
| Tests: multiple types → aggregated findings | ✅ |
| INV-12: every verification has a bypass check | ✅ |
| No real secrets in code/tests/logs/reports | ✅ (synthetic hashes used) |

## Deviations

None. The implementation matches the subphase spec exactly.

## Files Created / Modified

| File | Action |
|---|---|
| `src/verification/bypass-detector.ts` | Created |
| `tests/verification/bypass-detector.test.ts` | Created |
| `logs/phase-2.11-bypass-detector.txt` | Created |
| `docs/reports/phase-2.11-2026-09-27.md` | Created (this file) |
