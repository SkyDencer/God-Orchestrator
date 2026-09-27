# Phase 2.10 — Test Integrity Verifier

**Date:** 2026-09-27  
**Subphase:** 2.10  
**Rules addressed:** Rule 18, INV-13

## What was built

`src/verification/test-integrity-verifier.ts` — a new `TestIntegrityVerifier` class that:

1. **`captureSnapshot()`** inspects the test suite under a project root and produces a `TestSnapshot`:
   - **`testFiles`** — lexicographically sorted list of all `.test.ts` / `.spec.ts` files under `tests/`.
   - **`fileHashes`** — SHA-256 hex digest of each test file's UTF-8 contents.
   - **`assertionCount`** — sum of `expect(`, `it(`, `fit(`, and `assert(` call occurrences across all test files.
   - **`skipCount`** — sum of `it.skip(`, `fit.skip(`, `describe.skip(`, and `pytest.mark.skip` occurrences.
   - **`coveragePct`** — coverage percentage from `npx vitest run --coverage.enabled=true --coverage.reporter=json-json`; falls back to `0` when coverage tooling (`@vitest/coverage-v8`) is unavailable.
   - **`testConfigHash`** — SHA-256 of `vitest.config.*` (or `vite.config.*`) concatenated with the `scripts`, `devDependencies`, and `dependencies` sections of `package.json`.

2. **`compareAfter(before)`** re-captures a fresh snapshot and compares it field-by-field against the supplied `before` snapshot, producing a `VerificationCheck`:
   - **Deleted test file** → `failed` with finding `Test file deleted: …`
   - **Assertion count decreased** → `failed` with finding `Assertion count decreased: N → M`
   - **Skip count increased** → `failed` with finding `Skip count increased: N → M`
   - **Coverage dropped > 2 pp** → `failed` with finding `Coverage decreased > 2%: …`
   - **Test config changed** → `failed` with finding `Test config changed`
   - No findings → `passed`

`src/verification/index.ts` was updated to re-export `TestIntegrityVerifier`.

## Tests

`tests/verification/test-integrity-verifier.test.ts` — 7 tests:

| # | Test | Pass? |
|---|------|-------|
| 1 | Snapshot captures correct file list, hashes, assertion counts, skip counts, coverage (0), and config hash | ✅ |
| 2 | `compareAfter` with no changes returns `passed` | ✅ |
| 3 | Deleting one test file produces `failed` with "Test file deleted" | ✅ |
| 4 | **Adversarial** — delete `beta.test.ts` in a temp fixture, confirm `failed`; restore file, confirm `passed` | ✅ |
| 5 | Removing an `expect(` call produces `failed` with "Assertion count decreased" | ✅ |
| 6 | Adding an `it.skip(` produces `failed` with "Skip count increased" | ✅ |
| 7 | Modifying `vitest.config.ts` produces `failed` with "Test config changed" | ✅ |

### Adversarial test detail

The adversarial test (test #4) builds a self-contained fixture project at a `mkdtemp` path with two real test files (`alpha.test.ts`, `beta.test.ts`), calls `captureSnapshot()` to record the baseline, **physically deletes** `beta.test.ts` from disk, runs `compareAfter(before)` and asserts `status === 'failed'` with the expected findings ("Test file deleted" and "Assertion count decreased"). It then **restores** the original file content and asserts `compareAfter(before)` returns `passed`. No real secrets are used; synthetic fixture paths only.

## Targeted checks executed

| Check | Command | Result |
|-------|---------|--------|
| Vitest run | `npx vitest run tests/verification/test-integrity-verifier.test.ts` | 7/7 passed (47.76 s) |
| ESLint | `npx eslint src/verification/test-integrity-verifier.ts tests/verification/test-integrity-verifier.test.ts` | Clean |
| TypeScript | `npx tsc --noEmit` | Clean |

## Spec deviations

**None.** The implementation satisfies every requirement in the subphase spec:

- `constructor(projectRoot)` — ✓
- `captureSnapshot(): Promise<TestSnapshot>` — ✓
- `compareAfter(before): Promise<VerificationCheck>` — ✓
- Snapshot fields: test-file list + sha256, assertion counts, skip counts, coverage pct, test-config hash — ✓
- Detection rules: deleted file, assertion drop, skip increase, coverage drop > 2 %, config change — ✓
- Adversarial test in temp fixture project — ✓
- No commits in the project repo — ✓
- No real secrets in code, tests, logs, or reports — ✓

## Files produced

```
src/verification/test-integrity-verifier.ts
src/verification/index.ts              (additive export only)
tests/verification/test-integrity-verifier.test.ts
logs/phase-2.10-test-integrity-verifier.txt
docs/reports/phase-2.10-2026-09-27.md
```
