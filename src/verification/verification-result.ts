/** Status of an individual verification check. */
export type CheckStatus = 'passed' | 'failed' | 'inconclusive';

/** A single verification check with its result and associated evidence. */
export interface VerificationCheck {
  name: string;
  status: CheckStatus;
  summary: string;
  /** IDs of evidence rows produced by this check. */
  evidence: number[];
}

/** Top-level result for one verification run. */
export interface VerificationResult {
  status: CheckStatus;
  checks: VerificationCheck[];
  evidenceRefs: number[];
}

/** A finding produced when a bypass is attempted or detected. */
export interface BypassFinding {
  type: string;
  severity: 'low' | 'medium' | 'high' | 'critical';
  description: string;
  location: string;
}

/**
 * Payload shape for each acceptance-criterion kind.
 * All fields are optional except where noted; each concrete subclass
 * (below) pins the relevant ones.
 */
interface BasePayload {
  requirement_ref?: string;
}

export interface CommandPayload extends BasePayload {
  command: string;
  expectedExitCode?: number;
  timeoutMs?: number;
}

export interface FileExistsPayload extends BasePayload {
  path: string;
}

export interface FileContainsPayload extends BasePayload {
  path: string;
  pattern: string;
  expected: boolean; // true = expect match, false = expect no match
}

export interface CustomPayload extends BasePayload {
  label: string;
  details?: string;
}

/** Union of all accepted payload shapes keyed by type. */
export type AcceptanceCriterionPayload =
  | CommandPayload
  | FileExistsPayload
  | FileContainsPayload
  | CustomPayload;

/**
 * An acceptance criterion that a verifier evaluates.
 *
 * Types:
 *   - command         — run an executable and check exit code / output
 *   - file_exists     — assert a path exists (or not, via negative criteria)
 *   - file_contains   — grep-like assertion on a file's contents
 *   - file_not_contains — negated file_contains (provided for clarity)
 *   - custom          — arbitrary verifier-specific assertion
 *   - requirement_ref — link back to a project requirement (resolved later)
 */
export interface AcceptanceCriterion {
  type: 'command' | 'file_exists' | 'file_contains' | 'file_not_contains' | 'custom' | 'requirement_ref';
  payload: AcceptanceCriterionPayload;
}

/**
 * Snapshot of a test run for diffing across versions.
 */
export interface TestSnapshot {
  testFiles: string[];
  fileHashes: Record<string, string>;
  assertionCount: number;
  skipCount: number;
  coveragePct: number;
  testConfigHash: string;
}

/**
 * A structured command request — no shell strings.
 * Each field maps directly to a spawn() argument.
 */
export interface CommandRequest {
  executable: string;
  args: string[];
  cwd?: string;
  timeoutMs?: number;
}

/**
 * Snapshot of a test-run count for drop-detection across runs.
 */
export interface TestCountSnapshot {
  /** Total number of tests discovered/executed in this run. */
  testCount: number;
  passed: number;
  failed: number;
  /** ISO-8601 timestamp of capture. */
  capturedAt: string;
}
