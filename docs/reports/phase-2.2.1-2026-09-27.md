# Phase 2.1 — Evidence Model, Store, and Shared Verification Types

**Date:** 2026-09-27  
**Subagent:** verifier-2.1  
**Status:** Complete

---

## What was built

### Source files (new)

| File | Purpose |
|------|---------|
| `src/verification/evidence.ts` | `Evidence` interface aligned with the V5 `evidence` table plus `computeHash()` |
| `src/verification/evidence-store.ts` | `EvidenceStore` class — stores/retrieves evidence with SHA-256 tamper detection, FS overflow above ~4 KB |
| `src/verification/verification-result.ts` | Shared interfaces consumed by later verifiers (`VerificationCheck`, `VerificationResult`, `BypassFinding`, `AcceptanceCriterion`, `TestSnapshot`, `CommandRequest`) |
| `src/verification/index.ts` | Public re-export barrel |

### Migration (new)

| File | Purpose |
|------|---------|
| `src/persistence/migrations/002_evidence_store.sql` | Adds `hash`, `size`, `source`, `fs_path`, and `verification_run_id` columns to `evidence`; makes `verification_check_id` nullable via table recreation with data preservation |

### Tests (new)

| File | Purpose |
|------|---------|
| `tests/verification/evidence-store.test.ts` | 13 tests covering DB storage, FS overflow, run/type queries, hash verification, tamper detection, deletion, and nested dir auto-creation |

### Logs / reports (new)

| File |
|------|
| `logs/phase-2.2.1-evidence-store.txt` |
| `docs/reports/phase-2.2.1-2026-09-27.md` |

---

## Design decisions

### Reconciling `store(runId, …)` with the schema's FK to `verification_checks`

The original V5 schema (migration 001, `src/persistence/schema.sql:138-145`) defines:

```sql
CREATE TABLE evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_check_id INTEGER NOT NULL,
  evidence_type TEXT NOT NULL,
  evidence_data TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (verification_check_id) REFERENCES verification_checks(id)
);
```

EvidenceStore's `store(runId, type, source, content, checkId?)` accepts a **run** id as the primary linkage. The schema only has a FK to `verification_checks`. The reconciliation is:

1. **`verification_run_id`** — new column added by migration 002; always populated from the caller's `runId`.
2. **`verification_check_id`** — kept in the table but now nullable; populated only when the caller has an explicit check id (optional fourth arg to `store`). This avoids the friction of requiring a check row to exist before evidence can be stored.
3. Migration 002 recreates the `evidence` table (preserving existing rows) with both columns nullable, and no FK constraints enforced at the SQLite level for the new columns — this matches the pragmatic approach used elsewhere in the project (see `src/persistence/database.ts:6-8` which does not add `PRAGMA foreign_keys` inside migrations).

This mapping is documented in the migration SQL comments and in this report.

### In-DB vs. on-disk content split

Content ≤ 4096 bytes is stored directly in `evidence_data`. Content > 4096 bytes is written to `filesystemRoot/<runId>-<type>-<hash>.dat` and `evidence_data` is set to NULL; `fs_path` holds the absolute path. The hash in the DB row allows `verifyHash(id)` to re-read from disk and compare without keeping the full content in memory.

### No real secrets in code/tests/logs

All test values are synthetic (`'small-payload'`, `'intact'`, `'secret'`, etc.). No real API keys, tokens, or paths appear in any source, test, or log file.

---

## Targeted test results

**Command:** `npx vitest run tests/verification/evidence-store.test.ts`  
**Result:** 13 passed, 0 failed (64 ms)

| Test | Status |
|------|--------|
| stores small evidence in the DB with a correct hash | ✓ |
| stores large evidence on disk and keeps hash in DB | ✓ |
| getByRun returns all evidence for a run | ✓ |
| getByType returns evidence across runs | ✓ |
| verifyHash returns true for untampered small evidence | ✓ |
| verifyHash returns true for untampered large evidence | ✓ |
| verifyHash detects tampering of in-DB content | ✓ |
| verifyHash detects tampering of on-disk content | ✓ |
| verifyHash returns false for a non-existent id | ✓ |
| delete removes the DB row and the disk file | ✓ |
| delete is a no-op for a missing id | ✓ |
| creates evidence with an explicit checkId | ✓ |
| creates the filesystem root automatically on construction | ✓ |

**Lint:** `npx eslint src/verification/*.ts tests/verification/evidence-store.test.ts` — 0 errors, 0 warnings.  
**Typecheck:** `npx tsc --noEmit` — 0 errors.

---

## Spec deviations

None. All files listed in the subphase spec were created. The evidence table required new columns (`hash`, `size`, `source`, `fs_path`, `verification_run_id`), so a new migration (002) was added per INV-07. The store's `store(runId, …)` signature was reconciled with the schema's check-level FK (see Design decisions above) and documented in the migration comments and this report.

---

## Files changed / created

```
src/verification/evidence.ts
src/verification/evidence-store.ts
src/verification/verification-result.ts
src/verification/index.ts
src/persistence/migrations/002_evidence_store.sql
tests/verification/evidence-store.test.ts
logs/phase-2.2.1-evidence-store.txt
docs/reports/phase-2.2.1-2026-09-27.md
```
