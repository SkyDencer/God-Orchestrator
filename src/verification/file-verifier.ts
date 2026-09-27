import * as fs from 'node:fs';
import * as path from 'node:path';
import type { VerificationCheck } from './verification-result.js';

/**
 * Verifies file properties inside a project root.
 *
 * Every path argument is resolved relative to the project root and is
 * rejected (as a failed check, never a throw) when the resolved path escapes
 * the root via directory-traversal or an absolute path pointing outside it.
 */
export class FileVerifier {
  readonly projectRoot: string;

  constructor(projectRoot: string) {
    this.projectRoot = path.resolve(projectRoot);
  }

  /** Check whether a path exists on disk. */
  async verifyExists(pathInput: string): Promise<VerificationCheck> {
    const resolved = this.resolvePath(pathInput, 'verifyExists');
    if (!resolved.ok) {
      return this.failedCheck('file_exists', `path-traversal: ${resolved.reason}`);
    }

    const exists = fs.existsSync(resolved.path);
    return exists
      ? this.passedCheck('file_exists', `Path exists: ${resolved.relative}`)
      : this.failedCheck('file_exists', `Path does not exist: ${resolved.relative}`);
  }

  /** Check whether a file's content contains a regex pattern. */
  async verifyContains(pathInput: string, pattern: string | RegExp): Promise<VerificationCheck> {
    const resolved = this.resolvePath(pathInput, 'verifyContains');
    if (!resolved.ok) {
      return this.failedCheck('file_contains', `path-traversal: ${resolved.reason}`);
    }

    if (!fs.existsSync(resolved.path)) {
      return this.failedCheck('file_contains', `Path does not exist: ${resolved.relative}`);
    }

    const content = fs.readFileSync(resolved.path, 'utf8');
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const match = regex.test(content);

    return match
      ? this.passedCheck('file_contains', `Pattern found in ${resolved.relative}`)
      : this.failedCheck('file_contains', `Pattern not found in ${resolved.relative}`);
  }

  /** Check whether a file's content does NOT contain a regex pattern. */
  async verifyNotContains(pathInput: string, pattern: string | RegExp): Promise<VerificationCheck> {
    const resolved = this.resolvePath(pathInput, 'verifyNotContains');
    if (!resolved.ok) {
      return this.failedCheck('file_not_contains', `path-traversal: ${resolved.reason}`);
    }

    if (!fs.existsSync(resolved.path)) {
      return this.failedCheck('file_not_contains', `Path does not exist: ${resolved.relative}`);
    }

    const content = fs.readFileSync(resolved.path, 'utf8');
    const regex = pattern instanceof RegExp ? pattern : new RegExp(pattern);
    const match = regex.test(content);

    return match
      ? this.failedCheck('file_not_contains', `Pattern found in ${resolved.relative} — expected absence`)
      : this.passedCheck('file_not_contains', `Pattern not found in ${resolved.relative}`);
  }

  /** Check whether a file was modified after the given timestamp. */
  async verifyModifiedSince(pathInput: string, timestamp: Date): Promise<VerificationCheck> {
    const resolved = this.resolvePath(pathInput, 'verifyModifiedSince');
    if (!resolved.ok) {
      return this.failedCheck('file_modified_since', `path-traversal: ${resolved.reason}`);
    }

    if (!fs.existsSync(resolved.path)) {
      return this.failedCheck('file_modified_since', `Path does not exist: ${resolved.relative}`);
    }

    const stats = fs.statSync(resolved.path);
    const modified = stats.mtime;

    // Use a small epsilon (1 ms) to avoid floating-point edge cases
    return modified.getTime() > timestamp.getTime() + 1
      ? this.passedCheck('file_modified_since', `File modified at ${modified.toISOString()} (> ${timestamp.toISOString()})`)
      : this.failedCheck('file_modified_since', `File not modified after ${timestamp.toISOString()}`);
  }

  // ------------------------------------------------------------------ internals
  private resolvePath(
    input: string,
    _checkName: string,
  ): { ok: true; path: string; relative: string } | { ok: false; reason: string } {
    const resolved = path.resolve(this.projectRoot, input);

    // Reject absolute paths that are outside the project root
    if (path.isAbsolute(input) && !resolved.startsWith(this.projectRoot + path.sep) && resolved !== this.projectRoot) {
      return { ok: false, reason: `absolute path outside root: ${input}` };
    }

    // Normalize to check for traversal escapes
    const normalized = path.normalize(resolved);
    if (!normalized.startsWith(this.projectRoot + path.sep) && normalized !== this.projectRoot) {
      return { ok: false, reason: `path traversal detected: ${input}` };
    }

    const relative = path.relative(this.projectRoot, resolved);
    return { ok: true, path: resolved, relative };
  }

  private passedCheck(checkType: string, summary: string): VerificationCheck {
    return {
      name: checkType,
      status: 'passed',
      summary,
      evidence: [],
    };
  }

  private failedCheck(checkType: string, summary: string): VerificationCheck {
    return {
      name: checkType,
      status: 'failed',
      summary,
      evidence: [],
    };
  }
}
