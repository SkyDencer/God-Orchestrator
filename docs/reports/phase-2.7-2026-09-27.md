# Phase 2.7 — Acceptance Verifier

**Date:** 2026-09-27
**Subagent:** verifier-2.7

## What was built

### `src/verification/acceptance-verifier.ts`
New class `AcceptanceVerifier` that evaluates `AcceptanceCriterion` objects and returns `VerificationCheck` results. Delegates to the existing verifiers from wave 1:

| Criterion type | Delegation |
|---|---|
| `command` | `CommandVerifier.verify(cmd, expectedExitCode)` |
| `file_exists` | `FileVerifier.verifyExists(path)` |
| `file_contains` | `FileVerifier.verifyContains(path, pattern)` |
| `file_not_contains` | `FileVerifier.verifyNotContains(path, pattern)` |
| `custom` | Self-resolved → always passed |
| `requirement_ref` | DB lookup via `getRequirementsByProjectId` |
| `composite` | Iterates sub-criteria; first failure short-circuits |

Signature: `constructor(fileVerifier, commandVerifier, db, evidenceStore?)`, `verify(criterion: AcceptanceInput): Promise<VerificationCheck>`.

Supports both single `AcceptanceCriterion` and `CompositeCriterion` (the latter expressed via the `AcceptanceInput` union type).

### `src/persistence/database.ts` (additive change)
Added `getRequirementsByProjectId(db, projectId)`: queries `requirements` rows for a given project. Exported from `src/persistence/index.ts` alongside the existing exports.

### `src/verification/index.ts` (additive change)
Added re-export of `AcceptanceVerifier` and `AcceptanceInput` from the new module.

### `tests/verification/acceptance-verifier.test.ts`
26 tests covering every criterion type plus composite and unknown-type handling:
- **command**: pass (exit 0), fail (exit 1), missing command field
- **file_exists**: pass (exists), fail (missing), fail (missing path)
- **file_contains**: pass, fail (pattern absent), fail (missing fields)
- **file_not_contains**: pass, fail (pattern present), fail (missing fields)
- **custom**: with details, label-only
- **requirement_ref**: no ref → inconclusive; no records → inconclusive; malformed format → inconclusive; ref not found → inconclusive; valid ref → passed; invalid project_id → inconclusive
- **composite**: all-pass, first-fail short-circuits, command sub-fail, default label, empty
- **unknown type**: returns failed check

## Why

The acceptance verifier is the top-level orchestrator that lets the orchestrator evaluate structured acceptance criteria against a phase. It unifies command execution (safe, structured, no shell strings), file inspection (path-traversal-safe via FileVerifier), and requirement-resolution (DB-backed) under a single `verify()` method. Composite criteria let the orchestrator express multi-step acceptance gates as a single unit.

## Targeted test results

All 26 tests pass. See `logs/phase-2.7-acceptance-verifier.txt` for full output.

## Spec deviations

None. All specified behaviors were implemented and tested.

## Pre-existing issues noted (not introduced by this subphase)

- `src/verification/test-verifier.ts` has 37 pre-existing TypeScript typecheck errors (`noUncheckedIndexedAccess` violations).
- `tests/verification/test-verifier.test.ts` has 1 pre-existing failing test (`expected 2 passed but got 0`).
These were verified as pre-existing by confirming they involve no files I created or modified.
