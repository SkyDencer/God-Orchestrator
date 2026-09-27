# Phase 2.8 — Security Verifier

**Date:** 2026-09-27  
**Subagent:** verifier-2.8  
**Status:** Complete

---

## What was built

### Source file (new)

| File | Purpose |
|------|---------|
| `src/verification/security-verifier.ts` | `SecurityVerifier` class with three verification methods |

### Tests (new)

| File | Purpose |
|------|---------|
| `tests/verification/security-verifier.test.ts` | 27 tests covering all three methods, secret patterns, forbidden paths, and placeholder handling |

### Logs / reports (new)

| File |
|------|
| `logs/phase-2.8-security-verifier.txt` |
| `docs/reports/phase-2.8-2026-09-27.md` |

---

## API

```typescript
export class SecurityVerifier {
  constructor(projectRoot: string) {}

  async verifyNoSecretsInChanges(gitDiff: string): Promise<VerificationCheck>
  async verifyNoForbiddenPaths(changedFiles: string[], forbidden: string[]): Promise<VerificationCheck>
  async verifyNoSecretAccess(logs: string): Promise<VerificationCheck>
}
```

All three methods return a `VerificationCheck` (from `src/verification/verification-result.ts`),
which has `name`, `status` (`'passed' | 'failed' | 'inconclusive'`), `summary`, and `evidence`.

---

## Design decisions

### Secret detection regexes

Each secret pattern is a global (`/g`) regex with word-boundary anchors (`\b`) to avoid
false positives on ordinary words (e.g. "disk", "backpack"):

| Pattern | Regex | Minimum length after prefix |
|---------|-------|---------------------------|
| `sk-*` | `/\bsk-[0-9A-Za-z_-]{20,}\b/gi` | 20 |
| `sk-ant-*` | `/\bsk-ant-[0-9A-Za-z_-]{20,}\b/gi` | 20 |
| `ghp_*` | `/\bghp_[0-9A-Za-z_-]{30,}\b/gi` | 30 |
| `gho_*` | `/\bgho_[0-9A-Za-z_-]{30,}\b/gi` | 30 |
| `xoxb-*` | `/\bxoxb-[0-9A-Za-z_-]{10,}\b/gi` | 10 |
| `xoxp-*` | `/\bxoxp-[0-9A-Za-z_-]{10,}\b/gi` | 10 |
| `AKIA*` | `/\bAKIA[0-9A-Z]{16}\b/gi` | exactly 16 |
| `AIza*` | `/\bAIza[0-9A-Za-z_-]{20,}\b/gi` | 20 |

Length requirements were chosen to match known real token formats while avoiding
short coincidental matches (e.g. `sk-abc` in a comment passes).

### Placeholder handling

Obvious placeholders are matched against a second list of patterns and recorded as
notes rather than failures. The check still passes:

```
sk-FAKE*, sk-test*, ghp_FAKE*, gho_FAKE*, xoxb-TEST*, xoxp-TEST*,
AKIAIOSFODNN7EXAMPLE, AIza…FAKE/EXAMPLE/TEST, REDACTED, your-api-key,
YOUR_KEY_HERE, TODO-KEY, xxx+, placeholder
```

This prevents CI noise on documentation examples while still flagging real tokens.

### Forbidden path matching

The `verifyNoForbiddenPaths` method accepts a caller-supplied `forbidden` string array
and a `changedFiles` string array. Matching supports:

- **Exact match**: `.env` matches `.env`
- **Slash-free basename match**: `id_rsa` matches `.ssh/id_rsa`; `.env` matches `C:\Users\fake\.env`
- **Trailing slash (directory prefix)**: `secrets/` matches `secrets/api-key.txt`
- **`*pattern*` (double wildcard)**: `*key*` matches `app-key.json` (substring anywhere)
- **`*pattern` (leading wildcard)**: Not used in current spec but supported
- **`pattern*` (trailing wildcard)**: `.env*` matches `.env.production`

Glob-like wildcards in the `forbidden` array are resolved by `patternMatchesPath()`
before reaching the verifier. The spec's list `.env, .env.*, secrets/, credentials/, *key*, id_rsa`
maps directly.

### Regex reuse safety

All `SECRET_PATTERNS` have the global (`/g`) flag. Since `RegExp.prototype.matchAll`
resets `lastIndex` automatically per call in modern engines, but to be safe across
Node versions, each pattern's `lastIndex` is explicitly reset to `0` before use.

---

## Targeted test results

**Command:** `npx vitest run tests/verification/security-verifier.test.ts`  
**Result:** 27 passed, 0 failed (11 ms)

| Test | Status |
|------|--------|
| passes when diff is empty | ✓ |
| passes on a clean diff with no secret patterns | ✓ |
| fails when diff contains a real sk-* token | ✓ |
| fails when diff contains a real ghp_ token | ✓ |
| fails when diff contains an AKIA token | ✓ |
| fails when diff contains an AIza token | ✓ |
| fails when diff contains a sk-ant-* token | ✓ |
| fails when diff contains an xoxb-* token | ✓ |
| fails when diff contains an xoxp-* token | ✓ |
| fails when diff contains a gho_ token | ✓ |
| passes when diff contains only placeholder values | ✓ |
| passes on a false-positive-style short token (sk-abc) | ✓ |
| passes when no changed file matches a forbidden path | ✓ |
| fails when a .env file is in changed files | ✓ |
| fails when a secrets/ sub-path is changed | ✓ |
| fails when a credentials/ path is changed | ✓ |
| fails when a filename containing "key" is changed | ✓ |
| fails when id_rsa is changed | ✓ |
| handles Windows-style backslash paths | ✓ |
| matches .env.* glob patterns against .env.production | ✓ |
| passes when logs are empty | ✓ |
| passes on benign log lines | ✓ |
| fails when a real sk-* token appears in logs | ✓ |
| fails when a real ghp_ token appears in logs | ✓ |
| fails when an AKIA token appears in logs | ✓ |
| passes when only placeholders appear in logs | ✓ |
| passes on a false-positive short token sk-abc in logs | ✓ |

**Lint:** `npx eslint src/verification/security-verifier.ts tests/verification/security-verifier.test.ts` — 0 errors, 0 warnings.  
**Typecheck:** `npx tsc --noEmit` — 0 errors.  
**Regression:** `npx vitest run tests/verification/evidence-store.test.ts` — 13 passed, 0 failed.

---

## Spec deviations

None. All three required methods are implemented:
- `verifyNoSecretsInChanges(gitDiff)` — scans added diff lines for secret patterns
- `verifyNoForbiddenPaths(changedFiles, forbidden)` — checks changed file paths against forbidden patterns
- `verifyNoSecretAccess(logs)` — scans log text for secret tokens

Secret patterns from the spec (`sk-*`, `sk-ant-*`, `ghp_*`, `gho_*`, `xoxb-*`, `xoxp-*`, `AKIA*`, `AIza*`)
are all covered with word-boundary awareness and minimum-length thresholds.
Forbidden paths (`.env`, `.env.*`, `secrets/`, `credentials/`, `*key*`, `id_rsa`) are handled via
a glob-aware matcher. Placeholders are ignored but recorded as notes.

All synthetic secret values used in tests (e.g. `sk-aB3dEfGhIjKlMnOpQrStUvWxYz012345`,
`ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01`) follow the INV-10 rule — no real secrets.

---

## Files changed / created

```
src/verification/security-verifier.ts
tests/verification/security-verifier.test.ts
logs/phase-2.8-security-verifier.txt
docs/reports/phase-2.8-2026-09-27.md
```
