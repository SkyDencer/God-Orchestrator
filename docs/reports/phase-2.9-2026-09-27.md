# Phase 2.9 — Coverage Delta Verifier

**Date:** 2026-09-27  
**Subphase:** 2.9  
**Status:** Complete

---

## What was built

### `src/verification/coverage-verifier.ts`

A new `CoverageVerifier` class that reads a project's vitest coverage report and evaluates whether line coverage has degraded beyond an acceptable delta.

**Public API:**

```typescript
class CoverageVerifier {
  constructor(projectRoot: string);
  captureBaseline(): Promise<TestSnapshot>;
  compareAfter(before: TestSnapshot): Promise<VerificationCheck>;
}
```

**How it works:**

1. `captureBaseline()` reads the latest coverage report from `<projectRoot>/coverage/` and returns a `TestSnapshot` with `coveragePct` populated.
2. `compareAfter(before)` re-reads the current report, computes the line-coverage delta, and returns a `VerificationCheck`:
   - **No report found** → `status: 'inconclusive'` (never passed)
   - **Delta < -2 pp** → `status: 'failed'` (VIOLATION)
   - **Delta >= -2 pp** → `status: 'passed'`

**Report format handling:**

- Priority 1: `coverage/coverage-summary.json` — standard istanbul summary shape; reads `total.lines.pct`.
- Priority 2: `coverage/coverage-final.json` — per-file coverage map; totals are computed by counting statement hits across all files.

Both formats are standard outputs of vitest's coverage reporters (`@vitest/coverage-istanbul` / `@vitest/coverage-v8`).

### `src/verification/index.ts`

Updated to re-export `CoverageVerifier` alongside existing exports.

### `tests/verification/coverage-verifier.test.ts`

11 unit tests covering all required behaviours:

| # | Test | Expected | Result |
|---|------|----------|--------|
| 1 | baseline from `coverage-summary.json` | `coveragePct === 85` | ✅ passed |
| 2 | baseline from `coverage-final.json` fallback | `coveragePct === 72` | ✅ passed |
| 3 | `captureBaseline()` throws when no report exists | throws `"No coverage report found"` | ✅ passed |
| 4 | stable coverage (delta == 0) | `status === 'passed'` | ✅ passed |
| 5 | coverage increases | `status === 'passed'`, summary shows `+5.0 pp` | ✅ passed |
| 6 | small drop within tolerance (-1 pp) | `status === 'passed'` | ✅ passed |
| 7 | drop > 2 pp (-3 pp) | `status === 'failed'` | ✅ passed |
| 8 | large drop (-30 pp) | `status === 'failed'` | ✅ passed |
| 9 | report disappears between baseline and compare | `status === 'inconclusive'` | ✅ passed |
| 10 | no report at all during compare | `status === 'inconclusive'` | ✅ passed |
| 11 | `coverage-summary.json` preferred over `coverage-final.json` | `coveragePct === 85` | ✅ passed |

---

## Spec deviations

None. All required behaviours are implemented and tested.

---

## Files created / modified

| File | Action |
|------|--------|
| `src/verification/coverage-verifier.ts` | Created |
| `src/verification/index.ts` | Modified (added `CoverageVerifier` export) |
| `tests/verification/coverage-verifier.test.ts` | Created |
| `logs/phase-2.9-coverage-verifier.txt` | Created |
| `docs/reports/phase-2.9-2026-09-27.md` | Created |

---

## Checks run

| Check | Command | Result |
|-------|---------|--------|
| Targeted tests | `npx vitest run tests/verification/coverage-verifier.test.ts` | 11/11 passed |
| Lint | `npx eslint src/verification/coverage-verifier.ts tests/verification/coverage-verifier.test.ts` | 0 errors |
| Type check | `npx tsc --noEmit` | No new errors (pre-existing error in `bypass-detector.ts` unchanged) |

---

## Notes

- The project does not currently have a coverage provider (`@vitest/coverage-istanbul` or `@vitest/coverage-v8`) installed, so no real coverage report exists on disk. The verifier correctly returns `inconclusive` in that scenario, which is the expected behaviour per spec.
- The `-2 pp` threshold matches the existing `TestIntegrityVerifier` threshold (`before.coveragePct - after.coveragePct > 2`) for consistency across the verification engine.
