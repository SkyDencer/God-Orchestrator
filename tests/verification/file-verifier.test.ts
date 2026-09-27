import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { FileVerifier } from '../../src/verification/file-verifier.js';

/**
 * Create a temporary fixture directory for tests.
 * Uses the platform temp dir to avoid path-length issues on Windows.
 */
function makeTmpDir(): string {
  const base = process.env.TEMP ?? process.env.TMP ?? '/tmp';
  return fs.mkdtempSync(path.join(base, 'god-filever-'));
}

/**
 * Write a file and return its absolute path inside the given directory.
 */
function writeFixture(dir: string, relPath: string, content: string): string {
  const absPath = path.join(dir, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, 'utf8');
  return absPath;
}

describe('FileVerifier', () => {
  let tmpDir: string;
  let verifier: FileVerifier;

  beforeEach(() => {
    tmpDir = makeTmpDir();
    verifier = new FileVerifier(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('verifyExists', () => {
    it('returns passed when the file exists', async () => {
      const relPath = 'hello.txt';
      writeFixture(tmpDir, relPath, 'world');

      const result = await verifier.verifyExists(relPath);

      expect(result.status).toBe('passed');
      expect(result.name).toBe('file_exists');
      expect(result.summary).toContain(relPath);
      expect(result.evidence).toEqual([]);
    });

    it('returns passed for nested existing files', async () => {
      const relPath = 'sub/deep/nested.md';
      writeFixture(tmpDir, relPath, '# heading');

      const result = await verifier.verifyExists(relPath);

      expect(result.status).toBe('passed');
    });

    it('returns failed when the file is missing', async () => {
      const result = await verifier.verifyExists('nonexistent.txt');

      expect(result.status).toBe('failed');
      expect(result.name).toBe('file_exists');
      expect(result.summary).toContain('nonexistent.txt');
    });

    it('returns failed for a missing nested path', async () => {
      const result = await verifier.verifyExists('sub/missing.txt');

      expect(result.status).toBe('failed');
    });
  });

  describe('verifyContains', () => {
    it('returns passed when the file contains the pattern (string)', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'the quick brown fox');

      const result = await verifier.verifyContains(relPath, 'quick brown');

      expect(result.status).toBe('passed');
      expect(result.name).toBe('file_contains');
    });

    it('returns passed when the file contains the pattern (regex)', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'error: something went wrong');

      const result = await verifier.verifyContains(relPath, /error:\s+\w+/);

      expect(result.status).toBe('passed');
    });

    it('returns failed when the pattern does not match', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'hello world');

      const result = await verifier.verifyContains(relPath, 'GOODBYE');

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('Pattern not found');
    });

    it('returns failed when the file is missing', async () => {
      const result = await verifier.verifyContains('missing.txt', 'anything');

      expect(result.status).toBe('failed');
    });

    it('handles regex special characters in string patterns', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'price is $100.99');

      const result = await verifier.verifyContains(relPath, '\\$100\\.99');

      expect(result.status).toBe('passed');
    });
  });

  describe('verifyNotContains', () => {
    it('returns passed when the pattern is absent', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'hello world');

      const result = await verifier.verifyNotContains(relPath, 'secret');

      expect(result.status).toBe('passed');
      expect(result.name).toBe('file_not_contains');
    });

    it('returns passed for regex absence', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'user: admin');

      const result = await verifier.verifyNotContains(relPath, /password/);

      expect(result.status).toBe('passed');
    });

    it('returns failed when the pattern IS present', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'api_key=sk-FAKE0000');

      const result = await verifier.verifyNotContains(relPath, 'sk-');

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('Pattern found');
    });

    it('returns failed when the file is missing', async () => {
      const result = await verifier.verifyNotContains('missing.txt', 'anything');

      expect(result.status).toBe('failed');
    });
  });

  describe('verifyModifiedSince', () => {
    it('returns passed when the file was modified after the timestamp', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'fresh content');

      // Ensure the file's mtime is after a past timestamp
      const past = new Date(Date.now() - 60_000); // 1 minute ago

      const result = await verifier.verifyModifiedSince(relPath, past);

      expect(result.status).toBe('passed');
      expect(result.name).toBe('file_modified_since');
    });

    it('returns failed when the file was NOT modified after the timestamp', async () => {
      const relPath = 'content.txt';
      writeFixture(tmpDir, relPath, 'old content');

      // Set the mtime to a far-future date so our check will fail
      const farFuture = new Date('2099-01-01T00:00:00Z');
      fs.utimesSync(path.join(tmpDir, relPath), farFuture, farFuture);

      // Now check against a date AFTER the file's modification time
      const afterFile = new Date('2100-01-01T00:00:00Z');

      const result = await verifier.verifyModifiedSince(relPath, afterFile);

      expect(result.status).toBe('failed');
    });

    it('returns failed when the file is missing', async () => {
      const result = await verifier.verifyModifiedSince('missing.txt', new Date());

      expect(result.status).toBe('failed');
    });
  });

  describe('path traversal rejection', () => {
    it('rejects ".." escape sequences as a failed check (verifyExists)', async () => {
      const result = await verifier.verifyExists('../package.json');

      expect(result.status).toBe('failed');
      expect(result.name).toBe('file_exists');
      expect(result.summary).toContain('traversal');
    });

    it('rejects ".." escape sequences as a failed check (verifyContains)', async () => {
      const result = await verifier.verifyContains('../package.json', 'name');

      expect(result.status).toBe('failed');
      expect(result.name).toBe('file_contains');
      expect(result.summary).toContain('traversal');
    });

    it('rejects ".." escape sequences as a failed check (verifyNotContains)', async () => {
      const result = await verifier.verifyNotContains('../package.json', 'name');

      expect(result.status).toBe('failed');
      expect(result.name).toBe('file_not_contains');
      expect(result.summary).toContain('traversal');
    });

    it('rejects ".." escape sequences as a failed check (verifyModifiedSince)', async () => {
      const result = await verifier.verifyModifiedSince('../package.json', new Date());

      expect(result.status).toBe('failed');
      expect(result.name).toBe('file_modified_since');
      expect(result.summary).toContain('traversal');
    });

    it('rejects absolute paths outside the project root', async () => {
      const result = await verifier.verifyExists('/etc/passwd');

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('outside root');
    });

    it('rejects deeply nested traversal like "sub/../../outside"', async () => {
      const result = await verifier.verifyExists('sub/../../outside');

      expect(result.status).toBe('failed');
      expect(result.summary).toContain('traversal');
    });

    it('allows paths that resolve to the project root itself', async () => {
      // A path that normalizes to exactly the root should be allowed
      const result = await verifier.verifyExists('.');

      // '.' resolves to the project root directory which exists — passed is correct
      expect(result.status).toBe('passed');
      // The summary should NOT mention traversal; it should confirm existence
      expect(result.summary).not.toContain('traversal');
      expect(result.summary).not.toContain('outside root');
    });
  });

  describe('constructor', () => {
    it('resolves relative projectRoot to an absolute path', () => {
      const rel = path.relative(process.cwd(), tmpDir);
      const v = new FileVerifier(rel);
      expect(v.projectRoot).toBe(path.resolve(rel));
    });
  });
});
