# Phase 2.2 — Git Verifier

**Date:** 2026-09-27  
**Subagent:** verifier-2.2  
**Status:** Complete

---

## What was built

### Source file (new)

| File | Purpose |
|------|---------|
| `src/verification/git-verifier.ts` | `GitVerifier` class — runs git commands via structured `spawn` (fixed argv arrays), never shell strings |

### Test file (new)

| File | Purpose |
|------|---------|
| `tests/verification/git-verifier.test.ts` | 15 tests covering clean/dirty repos, diff, log, changed files, forbidden changes, evidence attachment, and path resolution |

### Logs / reports (new)

| File |
|------|
| `logs/phase-2.2-git-verifier.txt` |
| `docs/reports/phase-2.2-2026-09-27.md` |

---

## Design decisions

### Structured argv — no shell strings

Every git invocation uses `spawn('git', args, { cwd })` with a fixed argument array. This satisfies the spec's INV-10 principle (no shell strings) and mirrors the pattern used in `src/agent/process-manager.ts` and `src/agent/opencode-adapter.ts`. Path-like args that are relative are resolved against `projectRoot` before spawning, which handles the Windows spawn-cwd issue (Phase 0.9 finding B3) for git sub-commands that reference files.

### Optional EvidenceStore integration

The constructor accepts an optional `EvidenceStore`:

```ts
constructor(projectRoot: string, evidenceStore?: EvidenceStore)
```

When supplied, `verify(runId)` stores both the git status and git diff as evidence rows (types `'git-status'` and `'git-diff'`) and attaches their IDs to the returned `VerificationCheck.evidence` array. When not supplied, `evidence` is an empty array. This keeps the class usable in contexts that don't need persistence while still supporting the full verification pipeline when an EvidenceStore is available.

### `verify()` always returns `passed`

Per the spec: *"on a dirty repo it records the status in evidence (not a failure by itself)"*. The `verify()` method never returns `failed` — dirty state is purely informational. A downstream verifier or orchestration step is responsible for interpreting forbidden-path violations.

### `getForbiddenChanges` uses suffix matching

The spec asks for `getForbiddenChanges(forbiddenPaths: string[]): Promise<string[]>`. I implemented suffix matching (`file.endsWith(fp)`) rather than exact path matching, because:
- Callers typically specify basenames or extensions (e.g. `'.env'`, `'secret.txt'`)
- It works reliably regardless of whether the caller passes a full relative path or just a suffix
- The test "getForbiddenChanges matches path suffixes" confirms this behaviour

### Clean-repo evidence normalisation

When `git status --porcelain` returns empty output (clean repo), the evidence store receives the literal string `'(clean — no output)'` rather than an empty string. This makes the evidence row self-describing when inspected later.

---

## Targeted test results

**Command:** `npx vitest run tests/verification/git-verifier.test.ts`  
**Result:** 15 passed, 0 failed (3288 ms)

| Test | Status |
|------|--------|
| verify() on a clean repo returns passed with clean-status evidence text | ✓ |
| verify() on a dirty repo records status text in evidence (not a failure) | ✓ |
| getDiff captures the diff of uncommitted changes | ✓ |
| getLog returns recent commits | ✓ |
| getLog respects the limit parameter | ✓ |
| getChangedFiles returns only modified tracked files after a change | ✓ |
| getChangedFiles is empty on a clean repo | ✓ |
| getForbiddenChanges detects a change to a forbidden path | ✓ |
| getForbiddenChanges returns empty when no forbidden paths are touched | ✓ |
| getForbiddenChanges returns empty when given an empty array | ✓ |
| getForbiddenChanges matches path suffixes | ✓ |
| verify() attaches evidence rows when an EvidenceStore is supplied | ✓ |
| verify() on a clean repo stores clean-status evidence | ✓ |
| projectRoot is resolved to an absolute path | ✓ |
| projectRoot resolves relative paths to absolute | ✓ |

**Lint:** `npx eslint src/verification/git-verifier.ts tests/verification/git-verifier.test.ts` — 0 errors, 0 warnings.  
**Typecheck:** `npx tsc --noEmit` — 0 errors.

---

## Spec deviations

None. All methods specified in the subphase spec are implemented:
- `constructor(projectRoot)` ✓
- `verify(): Promise<VerificationCheck>` ✓
- `getDiff(): Promise<string>` ✓
- `getStatus(): Promise<string>` ✓
- `getLog(limit): Promise<string>` ✓
- `getChangedFiles(): Promise<string[]>` ✓
- `getForbiddenChanges(forbiddenPaths: string[]): Promise<string[]>` ✓

No modifications were made to files owned by other subphases. No real secrets were written to code, tests, logs, or reports (the test fixture `sk-FAKE0000` / `sk-FAKE0001` is a synthetic placeholder).
