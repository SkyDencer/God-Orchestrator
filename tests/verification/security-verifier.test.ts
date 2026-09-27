import { describe, it, expect } from 'vitest';
import { SecurityVerifier } from '../../src/verification/security-verifier.js';

const PROJECT_ROOT = '/fake/project/root';
const verifier = new SecurityVerifier(PROJECT_ROOT);

// ── verifyNoSecretsInChanges ────────────────────────────────────────────────

describe('verifyNoSecretsInChanges', () => {
  it('passes when diff is empty', async () => {
    const result = await verifier.verifyNoSecretsInChanges('');
    expect(result.status).toBe('passed');
    expect(result.name).toBe('security.no-secrets-in-changes');
  });

  it('passes on a clean diff with no secret patterns', async () => {
    const diff = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '+++ b/src/foo.ts',
      '+console.log("hello world");',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('passed');
  });

  it('fails when diff contains a real sk-* token', async () => {
    // sk- + 25 alphanumeric chars = valid token (>= 20 required)
    const diff = [
      'diff --git a/.env b/.env',
      '+++ b/.env',
      '+API_KEY=sk-aB3dEfGhIjKlMnOpQrStUvWxYz012345',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('secret token');
  });

  it('fails when diff contains a real ghp_ token', async () => {
    // ghp_ + 36 alphanumeric chars (>= 30 required)
    const diff = [
      'diff --git a/config.ts b/config.ts',
      '+++ b/config.ts',
      '+export const GITHUB_TOKEN = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01";',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
  });

  it('fails when diff contains an AKIA token (exactly 16 uppercase chars after prefix)',
    async () => {
      // AKIA + exactly 16 uppercase letters/digits
      const diff = [
        'diff --git a/aws.ts b/aws.ts',
        '+++ b/aws.ts',
        '+const ACCESS_KEY = "AKIAIOSFODNN7EXAMPL1";',
      ].join('\n');
      const result = await verifier.verifyNoSecretsInChanges(diff);
      expect(result.status).toBe('failed');
    });

  it('fails when diff contains an AIza token (exactly 30 chars after prefix)', async () => {
    // AIza + exactly 30 chars
    const diff = [
      'diff --git a/gcp.ts b/gcp.ts',
      '+++ b/gcp.ts',
      '+export const API_KEY = "AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0t";',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
  });

  it('fails when diff contains a sk-ant-* token', async () => {
    // sk-ant- + 40 chars (>= 20 required)
    const diff = [
      'diff --git a/anthropic.ts b/anthropic.ts',
      '+++ b/anthropic.ts',
      '+const KEY = "sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-";',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
  });

  it('fails when diff contains an xoxb-* token', async () => {
    // xoxb- + 45 chars (>= 10 required)
    const diff = [
      'diff --git a/slack.ts b/slack.ts',
      '+++ b/slack.ts',
      '+export const BOT_TOKEN = "xoxb-THEQUICKBROWNFOXJUMPSOVERTHELAZYDOG";',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
  });

  it('fails when diff contains an xoxp-* token', async () => {
    const diff = [
      'diff --git a/slack.ts b/slack.ts',
      '+++ b/slack.ts',
      '+export const USER_TOKEN = "xoxp-123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx";',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
  });

  it('fails when diff contains a gho_ token', async () => {
    // gho_ + 36 chars (>= 30 required)
    const diff = [
      'diff --git a/github.ts b/github.ts',
      '+++ b/github.ts',
      '+export const OAUTH_TOKEN = "gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef01";',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('failed');
  });

  it('passes when diff contains only placeholder values', async () => {
    const diff = [
      'diff --git a/docs/example.md b/docs/example.md',
      '+++ b/docs/example.md',
      '+// Use your key here: sk-FAKE0000000000000000000000',
      '+// Or try: sk-test-token-here',
    ].join('\n');
    const result = await verifier.verifyNoSecretsInChanges(diff);
    expect(result.status).toBe('passed');
  });

  it('passes on a false-positive-style short token that does not meet minimum length',
    async () => {
      // "sk-abc" is too short (needs 20+ chars after the prefix) → should pass.
      const diff = [
        'diff --git a/readme.md b/readme.md',
        '+++ b/readme.md',
        '+// see sk-abc for details',
      ].join('\n');
      const result = await verifier.verifyNoSecretsInChanges(diff);
      expect(result.status).toBe('passed');
    });
});

// ── verifyNoForbiddenPaths ──────────────────────────────────────────────────

describe('verifyNoForbiddenPaths', () => {
  // Mirror the spec: .env, .env.*, secrets/, credentials/, *key*, id_rsa
  const FORBIDDEN = ['.env', '.env.*', 'secrets/', 'credentials/', '*key*', 'id_rsa'];

  it('passes when no changed file matches a forbidden path', async () => {
    const files = ['src/main.ts', 'docs/readme.md', 'tests/helper.test.ts'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('passed');
  });

  it('fails when a .env file is in changed files', async () => {
    const files = ['src/main.ts', '.env'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
    expect(result.summary).toContain('.env');
  });

  it('fails when a secrets/ sub-path is changed', async () => {
    const files = ['src/main.ts', 'secrets/api-key.txt'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
  });

  it('fails when a credentials/ path is changed', async () => {
    const files = ['src/app.ts', 'credentials/db-pass.json'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
  });

  it('fails when a filename containing "key" is changed (*key* glob)', async () => {
    const files = ['src/service.ts', 'app-key.json'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
  });

  it('fails when id_rsa is changed', async () => {
    const files = ['src/main.ts', '.ssh/id_rsa'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
  });

  it('handles Windows-style backslash paths', async () => {
    const files = ['C:\\Users\\fake\\.env'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
  });

  it('matches .env.* glob patterns against .env.production', async () => {
    const files = ['src/main.ts', '.env.production'];
    const result = await verifier.verifyNoForbiddenPaths(files, FORBIDDEN);
    expect(result.status).toBe('failed');
  });
});

// ── verifyNoSecretAccess ─────────────────────────────────────────────────────

describe('verifyNoSecretAccess', () => {
  it('passes when logs are empty', async () => {
    const result = await verifier.verifyNoSecretAccess('');
    expect(result.status).toBe('passed');
  });

  it('passes on benign log lines', async () => {
    const logs = [
      '[INFO] server started on port 3000',
      '[DEBUG] processing request /api/health',
      '[INFO] connection established',
    ].join('\n');
    const result = await verifier.verifyNoSecretAccess(logs);
    expect(result.status).toBe('passed');
  });

  it('fails when a real sk-* token appears in logs', async () => {
    const logs = '[ERROR] unauthorised request with key sk-REALKEY1234567890abcdefghij';
    const result = await verifier.verifyNoSecretAccess(logs);
    expect(result.status).toBe('failed');
  });

  it('fails when a real ghp_ token appears in logs', async () => {
    // ghp_ + 32 chars (>= 30 required)
    const logs = '[WARN] leaking github token ghp_REALTOKEN12345678901abcdefghij';
    const result = await verifier.verifyNoSecretAccess(logs);
    expect(result.status).toBe('failed');
  });

  it('fails when an AKIA token appears in logs', async () => {
    // AKIA + 16 uppercase chars
    const logs = '[TRACE] AWS access key AKIAIOSFODNN7EXAMPL1 was used';
    const result = await verifier.verifyNoSecretAccess(logs);
    expect(result.status).toBe('failed');
  });

  it('passes when only placeholders appear in logs', async () => {
    const logs = [
      '[INFO] using placeholder key sk-FAKE00000000000000000000',
      '[INFO] example: sk-test-placeholder',
    ].join('\n');
    const result = await verifier.verifyNoSecretAccess(logs);
    expect(result.status).toBe('passed');
  });

  it('passes on a false-positive short token sk-abc in logs', async () => {
    const logs = '[INFO] mention sk-abc in docs';
    const result = await verifier.verifyNoSecretAccess(logs);
    expect(result.status).toBe('passed');
  });
});
