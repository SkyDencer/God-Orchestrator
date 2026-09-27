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
 * A single check specification within a VerificationPlan.
 */
export interface VerificationPlanCheck {
  /** Check name (e.g. 'git', 'build', 'test'). */
  check: string;
  /** Whether this check is required for an overall pass. Defaults to true. */
  required?: boolean;
}

/**
 * Plan that tells the VerificationPipeline which checks to run and which are required.
 */
export interface VerificationPlan {
  /** Ordered list of check specifications. */
  checks: VerificationPlanCheck[];
}

/**
 * A composite acceptance criterion containing multiple sub-criteria.
 * Defined here to avoid a circular dependency with acceptance-verifier.ts.
 */
export interface CompositeCriterion {
  type: 'composite';
  payload: {
    criteria: AcceptanceCriterion[];
    label?: string;
  };
}

/**
 * Union type accepted by the acceptance verifier — single criterion or composite.
 */
export type PipelineAcceptanceInput = AcceptanceCriterion | CompositeCriterion;

/**
 * Contract passed to VerificationPipeline.run(). Carries runtime configuration
 * for the pipeline (commands, acceptance criteria, baseline snapshots, etc.).
 */
export interface PipelineContract {
  /** Absolute path to the project root. */
  projectRoot: string;
  /** Build command to run; when omitted the build check is skipped. */
  buildCommand?: CommandRequest;
  /** Test command to run; when omitted the test check is skipped. */
  testCommand?: CommandRequest;
  /** Lint command to run; when omitted the lint check is skipped. */
  lintCommand?: CommandRequest;
  /** TypeScript typecheck command to run; when omitted the typecheck check is skipped. */
  typecheckCommand?: CommandRequest;
  /** Acceptance criteria to evaluate; when omitted the acceptance check is skipped. */
  acceptanceCriteria?: PipelineAcceptanceInput[];
  /** Snapshot captured before the current change (used by coverage_delta and test_integrity). */
  beforeSnapshot?: TestSnapshot;
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
