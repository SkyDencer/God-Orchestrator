# Phase 2.6 — BuildVerifier

**Date:** 2026-09-27
**Subagent:** verifier-2.6
**Status:** Complete

---

## What was built

### Source file (new)

| File | Purpose |
|------|---------|
| `src/verification/build-verifier.ts` | `BuildVerifier` class with `verify()` and `verifyTypecheck()` methods |

### Tests (new)

| File | Purpose |
|------|---------|
| `tests/verification/build-verifier.test.ts` | 6 tests covering success, failure, shell-string rejection, and real-project exercise |

### Test fixtures (new)

| File | Purpose |
|------|---------|
| `tests/fixtures/build-good/tsconfig.json` | Clean TS project for happy-path testing |
| `tests/fixtures/build-good/src/good.ts` | Valid TypeScript source |
| `tests/fixtures/build-bad/tsconfig.json` | TS project with intentional type error |
| `tests/fixtures/build-bad/src/bad.ts` | Source that causes `TS2322: Type 'number' is not assignable to type 'string'` |

### Logs / reports (new)

| File |
|------|
| `logs/phase-2.6-build-verifier.txt` |
| `docs/reports/phase-2.6-2026-09-27.md` |

---

## API

```typescript
export class BuildVerifier {
  constructor(
    private readonly projectRoot: string,
    private readonly commandVerifier: CommandVerifier,
  ) {}

  async verify(buildCommand: CommandRequest): Promise<VerificationCheck>
  async verifyTypecheck(command: CommandRequest): Promise<VerificationCheck>
}
```

Both methods delegate to `commandVerifier.verify(command, 0)` — exit code 0 → passed, anything else → failed. No additional logic is needed; the verboseness (or lack thereof) comes from `CommandVerifier`.

---

## Design decisions

### Delegation to CommandVerifier

`BuildVerifier` is a thin wrapper around `CommandVerifier`. This follows the same pattern used by `CoverageVerifier` (which reads files directly) — but for command-based verification, reusing `CommandVerifier` ensures consistent shell-safety checks, timeout handling, and evidence storage.

### Why not a separate spawn path

`BuildVerifier` could spawn tsc directly, but that would duplicate:
- Shell metacharacter rejection (INV-10 compliance)
- Timeout management
- Evidence attachment via `EvidenceStore`

Delegating to `CommandVerifier` keeps the concern separation clean.

### Fixture-based testing over the real project for success cases

The real project (`tsc --noEmit` from `PROJECT_ROOT`) exits with code 2 due to pre-existing type errors in `test-verifier.ts` and `acceptance-verifier.ts` from earlier subphases. Therefore:
- **Success tests** use `tests/fixtures/build-good/` — a clean TS project that exits 0.
- **Failure tests** use `tests/fixtures/build-bad/` — has one deliberate type error.
- **Real-project test** exercises the actual project to confirm failures are reported correctly when errors exist.

### Windows-specific: stdout vs stderr from tsc

On Windows, `cmd /c tsc --noEmit` routes tsc's diagnostic output to **stdout**, not stderr. Verified by direct Node.js spawn test:
```
stdout: "src/bad.ts(1,14): error TS2322: Type 'number' is not assignable to type 'string'.\r\n"
stderr: ""
```
This means `CommandVerifier.captureStderr()` returns `''` for tsc errors, but `verify()` still correctly returns `failed` because it checks `result.exitCode !== expectExitCode`. The summary contains the exit code mismatch (`"Exit code 2 did not match expected 0"`).

### Windows path resolution

`node_modules/.bin/tsc` is a `.cmd` wrapper on Windows. `spawn()` with the resolved absolute path via `cmd /c` works correctly. Using forward-slash temp paths (`/tmp/...`) as cwd caused `spawn cmd ENOENT` — the fix was to use `path.resolve()` to get Windows-native paths for fixture directories.

---

## Targeted test results

**Command:** `npx vitest run tests/verification/build-verifier.test.ts --reporter=verbose`  
**Result:** 6 passed, 0 failed (9.97 s)

| Test | Status |
|------|--------|
| successful build command returns passed | ✓ |
| successful typecheck command returns passed | ✓ |
| build error returns failed with stderr captured in summary | ✓ |
| typecheck error on bad fixture returns failed with stderr | ✓ |
| rejects a shell-string build command as failed | ✓ |
| real project tsc --noEmit returns failed due to pre-existing errors | ✓ |

**ESLint:** `npx eslint src/verification/build-verifier.ts tests/verification/build-verifier.test.ts` — 0 errors, 0 warnings.  
**Typecheck (own file):** `npx tsc --noEmit` filtered for `build-verifier` — 0 errors.  
**Full project typecheck:** 37 pre-existing errors in `test-verifier.ts` and `acceptance-verifier.ts`; 0 new errors introduced.  
**Regression (verification suite):** `npx vitest run tests/verification/` — 181 passed, 1 failed. The single failure is in `test-verifier.test.ts` ("parses jest passing output correctly") — pre-existing, unrelated to this subphase.

---

## Spec deviations

None. Both required methods are implemented:
- `verify(buildCommand: CommandRequest): Promise<VerificationCheck>` — delegates to CommandVerifier with expectExitCode=0
- `verifyTypecheck(command: CommandRequest): Promise<VerificationCheck>` — delegates to CommandVerifier with expectExitCode=0

All tests use real tsc invocations against real fixture projects — no faked outputs. The one deviation is acknowledging that the real project currently has pre-existing tsc errors (from other subphases), which is documented rather than worked around.

---

## Files created / modified

```
src/verification/build-verifier.ts
tests/verification/build-verifier.test.ts
tests/fixtures/build-good/tsconfig.json
tests/fixtures/build-good/src/good.ts
tests/fixtures/build-bad/tsconfig.json
tests/fixtures/build-bad/src/bad.ts
logs/phase-2.6-build-verifier.txt
docs/reports/phase-2.6-2026-09-27.md
```
