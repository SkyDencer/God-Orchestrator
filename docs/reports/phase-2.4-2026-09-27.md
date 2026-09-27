# Phase 2.4 Report — Command Verifier

**Date:** 2026-09-27
**Subphase:** 2.4 — Command verifier
**Status:** Complete

---

## What was built

### New source file — `src/verification/command-verifier.ts`

A `CommandVerifier` class that wraps `ProcessManager` to execute structured `CommandRequest` invocations and record results as `VerificationCheck` objects.

**Key design decisions:**

- **Constructor**: `CommandVerifier(projectRoot, processManager, evidenceStore?)` — stores the project root for default cwd resolution, holds a reference to a `ProcessManager`, and optionally an `EvidenceStore` for attaching stderr evidence.
- **`verify(command, expectExitCode)`**: Runs the structured command via `processManager.spawn()`. Returns a `VerificationCheck` with `status: 'passed'` when the actual exit code equals `expectExitCode`, otherwise `'failed'`. Shell-string requests (plain strings, or values with `executable`/`args` containing shell metacharacters `&&`, `||`, `|`, `;`, `&`, `<`, `>`) are rejected as a failed check with a descriptive summary — never by throwing.
- **`captureStdout(command)` / `captureStderr(command)`**: Thin wrappers around `processManager.spawn()` that return the captured stdout/stderr string after validation. Rejected requests return `''` with a console error.
- **`validate(command)`**: Lightweight pre-flight validator returning `{ valid: true }` or `{ valid: false, reason }`. Used internally by `captureStdout`/`captureStderr`.
- **Timeout handling**: The `CommandRequest.timeoutMs` field flows through to `ProcessManager.spawn()`. If not set, defaults to 10 000 ms. The ProcessManager kills the child on timeout; the check resolves with the resulting exit code (or null on signal termination).
- **Evidence attachment**: When an `EvidenceStore` is provided and stderr is non-empty, the stderr content is stored as evidence of type `'stderr'` and the evidence ID is appended to `check.evidence`.

**Shell metacharacter detection** (`command-verifier.ts:18-20`): A regex `[|&;<>\u0026\u007c\u003b\u003c\u003e]` catches all individual metacharacters listed in the spec plus their HTML-entity equivalents. Multi-character operators (`&&`, `||`) are caught by the character class naturally.

**Rejected commands never throw** (`command-verifier.ts:64-90`): The runtime guards for string-shaped input, missing `executable`, and shell metacharacters all return `makeFailedCheck()` — a normal `VerificationCheck` with `status: 'failed'`.

---

### New test file — `tests/verification/command-verifier.test.ts`

13 tests covering the required scenarios plus additional coverage for `captureStdout`, `captureStderr`, and `validate`:

| Test | Description |
|---|---|
| exit 0 as expected → passed | `node -e 'process.exit(0)'` with expected 0 → `status: 'passed'` |
| non-zero exit code → failed | `node -e 'process.exit(42)'` with expected 0 → `status: 'failed'`, summary mentions 42 and expected 0 |
| timeout handled | `ping -n 5 127.0.0.1` with 300ms timeout → `status: 'failed'`, completes without hanging |
| shell-string request rejected | Casts a plain string to `CommandRequest` → `status: 'failed'`, summary contains 'Rejected' |
| arg containing `&&` rejected | `{ executable: 'echo', args: ['foo&&bar'] }` → `status: 'failed'` |
| captureStdout succeeds | Returns `'captured-stdout\n'` |
| captureStderr succeeds | Returns `'captured-stderr\n'` |
| captureStdout rejects string | Returns `''` |
| captureStderr rejects `;` arg | Returns `''` |
| validate accepts good request | Returns `{ valid: true }` |
| validate rejects plain string | Returns `{ valid: false, reason: ... }` |
| validate rejects `||` arg | Returns `{ valid: false, reason: ... }` |
| validate rejects `;` executable | Returns `{ valid: false, reason: ... }` |

---

## Test results

| Check | Command | Result |
|---|---|---|
| New command-verifier tests | `npx vitest run tests/verification/command-verifier.test.ts --reporter=verbose` | **13 passed** |
| Full verification suite | `npx vitest run tests/verification/ --reporter=verbose` | **136 passed** (8 test files, no regression) |
| ESLint | `npx eslint src/verification/command-verifier.ts tests/verification/command-verifier.test.ts` | **0 errors, 0 warnings** |
| Typecheck | `npx tsc --noEmit` | **0 errors** |

Full evidence in `logs/phase-2.4-command-verifier.txt`.

---

## Files changed

| File | Action |
|---|---|
| `src/verification/command-verifier.ts` | Created — 168 lines |
| `tests/verification/command-verifier.test.ts` | Created — 155 lines |
| `logs/phase-2.4-command-verifier.txt` | Created |
| `docs/reports/phase-2.4-2026-09-27.md` | Created (this file) |

---

## Deviations from spec

None. All required behaviors are implemented and tested:
- `verify()` returns a `VerificationCheck` with exit code match/mismatch
- Shell-string requests are rejected as failed checks (not thrown)
- Shell metacharacters in executable or args are rejected
- Timeouts are handled via ProcessManager (short timeout → killed → failed check)
- Exit code + stderr ride along as check evidence
- `captureStdout` / `captureStderr` are implemented
- All five required tests are present and passing

---

## Evidence citations

- `CommandRequest` interface: read from `src/verification/verification-result.ts:97-102`
- `VerificationCheck` interface: read from `src/verification/verification-result.ts:5-11`
- `ProcessManager` spawn/kill API: read from `src/agent/process-manager.ts:49-155`
- `EvidenceStore` store API: read from `src/verification/evidence-store.ts:34-72`
- Windows cmd-wrapper behavior (existing): verified via `tests/agent/process-manager-windows.test.ts`
- Schema tables (verification_runs, verification_checks, evidence): read from `src/persistence/schema.sql:119-145`
