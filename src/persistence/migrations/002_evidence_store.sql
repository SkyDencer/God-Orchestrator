-- Migration 002: Evidence store columns
--
-- The original evidence table (from migration 001) has:
--   verification_check_id INTEGER NOT NULL  (FK → verification_checks)
--
-- EvidenceStore.store(runId, ...) links evidence to a verification run by
-- integer id.  To keep the store usable without pre-creating run/check rows
-- in the database, this migration recreates the evidence table with:
--   - verification_check_id made nullable (no FK enforced here)
--   - verification_run_id added as a plain integer
--   - hash, size, source, fs_path added for tamper detection and FS overflow
--
-- Existing rows are preserved via INSERT ... SELECT.

CREATE TABLE IF NOT EXISTS evidence_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  verification_check_id INTEGER,
  verification_run_id INTEGER,
  evidence_type TEXT NOT NULL,
  evidence_data TEXT,
  fs_path TEXT,
  hash TEXT,
  size INTEGER,
  source TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO evidence_new (
  id,
  verification_check_id,
  verification_run_id,
  evidence_type,
  evidence_data,
  fs_path,
  hash,
  size,
  source,
  created_at
)
SELECT
  id,
  verification_check_id,
  NULL,
  evidence_type,
  evidence_data,
  NULL,
  NULL,
  NULL,
  NULL,
  created_at
FROM evidence;

DROP TABLE evidence;
ALTER TABLE evidence_new RENAME TO evidence;
