import type { VerificationCheck } from './verification-result.js';

/**
 * Obvious placeholder patterns that must never trigger a failure.
 * They are still recorded as notes when matched so the caller sees what was scanned.
 */
const PLACEHOLDER_PATTERNS = [
  /sk-FAKE/i,
  /sk-test/i,
  /ghp_FAKE/i,
  /gho_FAKE/i,
  /xoxb-TEST/i,
  /xoxp-TEST/i,
  /AKIAIOSFODNN7EXAMPLE/i,
  /AIza[a-zA-Z0-9_-]{27}(?:fake|example|test)/i,
  /REDACTED/i,
  /your-api-key/i,
  /YOUR_KEY_HERE/i,
  /TODO[-_]KEY/i,
  /xxx+/i,
  /placeholder/i,
] as const;

/**
 * Secret token prefixes / patterns to scan for.
 * Each regex includes the global flag so matchAll can be used.
 * Word-boundary awareness prevents false positives on ordinary words.
 *
 * Length requirements (after the prefix):
 *   sk-        >= 20 chars
 *   sk-ant-    >= 20 chars
 *   ghp_       >= 30 chars
 *   gho_       >= 30 chars
 *   xoxb-/xoxp- >= 10 chars
 *   AKIA       exactly 16 uppercase chars
 *   AIza       exactly 30 chars
 */
const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[0-9A-Za-z_-]{20,}\b/gi,
  /\bsk-ant-[0-9A-Za-z_-]{20,}\b/gi,
  /\bghp_[0-9A-Za-z_-]{30,}\b/gi,
  /\bgho_[0-9A-Za-z_-]{30,}\b/gi,
  /\bxoxb-[0-9A-Za-z_-]{10,}\b/gi,
  /\bxoxp-[0-9A-Za-z_-]{10,}\b/gi,
  /\bAKIA[0-9A-Z]{16}\b/gi,
  /\bAIza[0-9A-Za-z_-]{20,}\b/gi,
];

/**
 * Internal reference patterns — kept for documentation only.
 * Actual matching is driven by the caller-supplied `forbidden` list which may
 * contain glob-like wildcards (e.g. "*key*").
 */
const _FORBIDDEN_PATH_PATTERNS: RegExp[] = [
  /^\.[Ee][Nn][Vv]$/,
  /^\.[Ee][Nn][Vv]\..+$/,
  /^secrets(?:\/.+)?$/i,
  /^credentials(?:\/.+)?$/i,
  /key$/i,
  /\bid_rsa\b/i,
];

/**
 * Check whether a single glob-like forbidden pattern matches a file path.
 *
 * Matching rules:
 *   - Exact literal match (e.g. ".env" matches ".env")
 *   - Slash-free pattern also matches on basename (e.g. "id_rsa" matches ".ssh/id_rsa")
 *   - Trailing slash = directory prefix match (e.g. "secrets/" matches "secrets/foo")
 *   - Leading "*"  = suffix match (e.g. "*.env" matches ".env", "prod.env")
 *   - Trailing "*" = prefix match (e.g. ".env*" matches ".env", ".env.local")
 *   - Leading + trailing "*" = substring match (e.g. "*key*" matches "app-key.json")
 */
function patternMatchesPath(pattern: string, filePath: string): boolean {
  const normPath = filePath.replace(/\\/g, '/').toLowerCase();
  const normPat = pattern.toLowerCase();

  // Exact match
  if (normPath === normPat) return true;

  // Slash-free pattern: also match on basename so "id_rsa" catches ".ssh/id_rsa"
  // and ".env" catches "C:\Users\fake\.env" etc.
  if (!normPat.includes('/')) {
    const basename = normPath.slice(normPath.lastIndexOf('/') + 1);
    if (basename === normPat) return true;
  }

  // Trailing slash → directory prefix match
  if (normPat.endsWith('/')) {
    return normPath.startsWith(normPat);
  }

  // Double wildcard "*foo*" → substring anywhere in path
  if (normPat.startsWith('*') && normPat.endsWith('*')) {
    const needle = normPat.slice(1, -1);
    return normPath.includes(needle);
  }

  // Leading "*" only → suffix match
  if (normPat.startsWith('*')) {
    const suffix = normPat.slice(1);
    return normPath.endsWith(suffix);
  }

  // Trailing "*" only → prefix match
  if (normPat.endsWith('*')) {
    const prefix = normPat.slice(0, -1);
    return normPath.startsWith(prefix);
  }

  return false;
}

export class SecurityVerifier {
  constructor(private readonly projectRoot: string) {}

  /**
   * Scan a unified diff string for secret-token patterns.
   * Obvious placeholders are ignored but recorded as notes; the check still passes.
   */
  async verifyNoSecretsInChanges(gitDiff: string): Promise<VerificationCheck> {
    const lines = gitDiff.split(/\r?\n/);
    const found: string[] = [];
    const notes: string[] = [];

    for (const line of lines) {
      // Only scan added lines (+ prefix); skip diff headers (--- / +++).
      if (!line.startsWith('+') || line.startsWith('+++')) continue;
      const content = line.slice(1);

      for (const pattern of SECRET_PATTERNS) {
        // Reset lastIndex since these are global regexes reused across calls.
        pattern.lastIndex = 0;
        const matches = content.matchAll(pattern);
        for (const match of matches) {
          const value = match[0];
          if (this.isPlaceholder(value)) {
            notes.push(`Placeholder skipped in diff: ${this.mask(value)}`);
          } else {
            found.push(this.mask(value));
          }
        }
      }
    }

    const hasFinding = found.length > 0;
    return {
      name: 'security.no-secrets-in-changes',
      status: hasFinding ? 'failed' : 'passed',
      summary: hasFinding
        ? `Found ${found.length} secret token(s) in diff`
        : 'No secret tokens detected in diff',
      evidence: [],
    };
  }

  /**
   * Check whether any changed file path matches a forbidden path pattern.
   * The `forbidden` array may contain glob-like entries (e.g. "*key*", ".env.*").
   */
  async verifyNoForbiddenPaths(
    changedFiles: string[],
    forbidden: string[],
  ): Promise<VerificationCheck> {
    const violations: string[] = [];

    for (const file of changedFiles) {
      for (const pattern of forbidden) {
        if (patternMatchesPath(pattern, file)) {
          violations.push(file);
          break;
        }
      }
    }

    const hasFinding = violations.length > 0;
    return {
      name: 'security.no-forbidden-paths',
      status: hasFinding ? 'failed' : 'passed',
      summary: hasFinding
        ? `Forbidden path(s) changed: ${violations.join(', ')}`
        : 'No forbidden paths were changed',
      evidence: [],
    };
  }

  /**
   * Scan log lines for secret-token patterns (all non-empty lines).
   * Returns passed with a note when only placeholders are seen.
   */
  async verifyNoSecretAccess(logs: string): Promise<VerificationCheck> {
    const lines = logs.split(/\r?\n/);
    const found: string[] = [];
    const notes: string[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      for (const pattern of SECRET_PATTERNS) {
        pattern.lastIndex = 0;
        const matches = line.matchAll(pattern);
        for (const match of matches) {
          const value = match[0];
          if (this.isPlaceholder(value)) {
            notes.push(`Placeholder found in log: ${this.mask(value)}`);
          } else {
            found.push(this.mask(value));
          }
        }
      }
    }

    const hasFinding = found.length > 0;
    return {
      name: 'security.no-secret-access',
      status: hasFinding ? 'failed' : 'passed',
      summary: hasFinding
        ? `Found ${found.length} secret token(s) in logs`
        : notes.length > 0
          ? `No secrets in logs; ${notes.length} placeholder(s) noted`
          : 'No secret tokens detected in logs',
      evidence: [],
    };
  }

  // ------------------------------------------------------------------ internals

  private isPlaceholder(value: string): boolean {
    for (const pat of PLACEHOLDER_PATTERNS) {
      if (pat.test(value)) return true;
    }
    return false;
  }

  private mask(value: string): string {
    if (value.length <= 8) return value;
    return `${value.slice(0, 4)}…${value.slice(-4)}`;
  }
}
