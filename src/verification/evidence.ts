import { createHash } from 'node:crypto';

/**
 * Evidence row shape as stored in the evidence table and returned by EvidenceStore.
 *
 * Fields added by migration 002 beyond the base schema:
 *   - hash       SHA-256 hex digest of evidence_data (NULL when content lives in FS)
 *   - size       byte length of the original content
 *   - source     human-readable origin (e.g. "terminal-output", "file-diff", "agent-report")
 *   - fs_path    absolute path on disk when content exceeds the in-DB size threshold
 */
export interface Evidence {
  id: number;
  /** Foreign key to verification_checks (original schema FK). May be null when linked only via run. */
  verification_check_id: number | null;
  /** Direct link to the verification run that produced this evidence. */
  verification_run_id: number;
  evidence_type: string;
  /** Small payloads (< threshold); null when stored externally on disk. */
  evidence_data: string | null;
  /** Absolute filesystem path when evidence_data is null and content was written to disk. */
  fs_path: string | null;
  /** SHA-256 hex digest of the original (pre-storage) content bytes. */
  hash: string;
  /** Byte length of the original content. */
  size: number;
  /** Source label for the evidence (e.g. terminal output, agent report, file diff). */
  source: string;
  created_at: Date;
}

/**
 * Compute a SHA-256 hex digest over a UTF-8 string.
 */
export function computeHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}
