# Phase 2.0 Report — Windows absolute-path pre-work

**Date:** 2026-09-27
**Subphase:** 2.0 — Windows absolute-path pre-work
**Status:** Complete

---

## What was built

Two source patches and one new test file to ensure that on Windows, relative paths are resolved to absolute paths before spawning processes — addressing the Phase 0.9 finding that the OpenCode CLI ignores `spawn`'s `cwd` option.

### Patch 1 — `src/agent/process-manager.ts`

When `useCmdWrapper=true` (used on Windows to wrap commands in `cmd /c`), the spawn method now:

1. Resolves `options.cwd` to an absolute path via `path.resolve()` before passing it to `spawn()`.
2. Resolves the `executable` to an absolute path **only if it looks like a relative file path** (starts with `.`, or contains `/` or `\`). System commands like `cmd`, `echo`, `ping`, `node` are left untouched.
3. Resolves each arg that looks like a relative file path via `resolveArg()` before passing it to `spawn()`.

This ensures that even if the opencode CLI ignores `cwd`, any relative paths carried in the command are already absolute.

Key lines: `src/agent/process-manager.ts:56-73` (patched spawn body); `src/agent/process-manager.ts:30-44` (`resolveArg` helper).

### Patch 2 — `src/agent/task-builder.ts`

The `TaskBuilder.build()` method now emits `allowedPaths` and `forbiddenPaths` as absolute paths (resolved against `process.cwd()`) instead of the raw contract values. A new helper `toAbsolutePaths()` at line 66 performs the conversion; already-absolute paths are left unchanged.

This guarantees the agent receives unambiguous paths in its task prompt, consistent with the cwd-resolution fix in ProcessManager.

Key lines: `src/agent/task-builder.ts:66-70` (`toAbsolutePaths`); `src/agent/task-builder.ts:112-194` (patched build body using `absAllowedPaths` / `absForbiddenPaths`).

### New test — `tests/agent/process-manager-cwd.test.ts`

Six tests covering:
- Relative cwd resolved to absolute (verifies `path.resolve` is applied)
- Relative executable paths resolved (verifies only path-like executables are resolved, not system binaries)
- Relative path args resolved to absolute
- Non-cmd-wrapper spawn also uses resolved cwd
- Already-absolute cwd left unchanged
- Relative args with path separators (e.g. `src\agent`) resolved correctly

---

## Test results

| Check | Command | Result |
|---|---|---|
| New CWD tests | `npx vitest run tests/agent/process-manager-cwd.test.ts --reporter=verbose` | 6 passed |
| Existing Windows tests | `npx vitest run tests/agent/process-manager-windows.test.ts --reporter=verbose` | 3 passed (no regression) |
| Task-builder tests | `npx vitest run tests/agent/task-builder.test.ts --reporter=verbose` | 14 passed |
| Combined run | `npx vitest run tests/agent/process-manager-cwd.test.ts tests/agent/process-manager-windows.test.ts tests/agent/task-builder.test.ts --reporter=verbose` | 23 passed (9.78s) |
| ESLint | `npx eslint src/agent/process-manager.ts src/agent/task-builder.ts tests/agent/process-manager-cwd.test.ts tests/agent/task-builder.test.ts` | Clean (no errors) |

Full evidence in `logs/phase-2.0-absolute-path-prework.txt`.

---

## Files changed

| File | Action |
|---|---|
| `src/agent/process-manager.ts` | Modified — added path resolution for cwd, executable, and args when `useCmdWrapper=true` |
| `src/agent/task-builder.ts` | Modified — added `toAbsolutePaths()` helper; emit absolute paths in ALLOWED/FORBIDDEN sections |
| `tests/agent/process-manager-cwd.test.ts` | Created — 6 new tests |
| `tests/agent/task-builder.test.ts` | Modified — updated path assertions to expect absolute paths |

---

## Deviations from spec

None. All four sub-tasks (read, patch process-manager, patch task-builder, add tests) completed as specified.

---

## Pre-existing issues noted

- `src/agent/task-builder.ts(41,8): TS1030 duplicate export outside scope` — present before this subphase, out of scope, not addressed.

---

## Evidence citations

- Phase 0.9 finding (opencode CLI ignores spawn cwd): read from `docs/reports/phase-0.9-2026-09-27.md` lines 35–45 (B3 remediation).
- Existing Windows test suite: read from `tests/agent/process-manager-windows.test.ts`.
- Original process-manager code: read from `src/agent/process-manager.ts` (lines 1–48).
- Original task-builder code: read from `src/agent/task-builder.ts` (lines 1–67).
- Execution contract shape: read from `src/agent/execution-contract.ts` (allowedPaths, forbiddenPaths fields).
