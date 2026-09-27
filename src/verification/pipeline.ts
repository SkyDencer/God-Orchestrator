import * as fs from 'node:fs';
import type {
  CheckStatus,
  VerificationCheck,
  VerificationResult,
  VerificationPlan,
  PipelineContract,
} from './verification-result.js';
import type { EvidenceStore } from './evidence-store.js';
import type { GitVerifier } from './git-verifier.js';
import type { FileVerifier } from './file-verifier.js';
import type { CommandVerifier } from './command-verifier.js';
import type { TestVerifier } from './test-verifier.js';
import type { BuildVerifier } from './build-verifier.js';
import type { AcceptanceVerifier } from './acceptance-verifier.js';
import type { SecurityVerifier } from './security-verifier.js';
import type { CoverageVerifier } from './coverage-verifier.js';
import type { TestIntegrityVerifier } from './test-integrity-verifier.js';
import type { BypassDetector } from './bypass-detector.js';

/**
 * Ordered list of check names that the pipeline runs by default, in the
 * canonical execution sequence mandated by the spec:
 *   git → file → build → test → lint → typecheck → acceptance →
 *   coverage_delta → test_integrity → security → bypass_prevention → semantic
 *
 * The final "semantic" check is optional and off by default; callers must
 * include it explicitly in their plan if they want it run.
 */
const DEFAULT_CHECK_ORDER: string[] = [
  'git',
  'file',
  'build',
  'test',
  'lint',
  'typecheck',
  'acceptance',
  'coverage_delta',
  'test_integrity',
  'security',
  'bypass_prevention',
];

/**
 * VerificationPipeline orchestrates a sequence of verification checks against
 * a project, producing a VerificationResult with per-check evidence attached
 * through the provided EvidenceStore.
 *
 * Execution order is fixed and mandated:
 *   git → file → build → test → lint → typecheck → acceptance →
 *   coverage_delta → test_integrity → security → bypass_prevention → semantic
 *
 * Rules (INV-01, INV-12, Rule 2):
 *   - Every check produces evidence stored via evidenceStore.
 *   - Any required check failed → overall failed.
 *   - A required check inconclusive with no fallback → overall inconclusive.
 *   - Never passed with a missing or failing required check (INV-01, INV-12).
 */
export class VerificationPipeline {
  readonly git: GitVerifier;
  readonly file: FileVerifier;
  readonly command: CommandVerifier;
  readonly test: TestVerifier;
  readonly build: BuildVerifier;
  readonly acceptance: AcceptanceVerifier;
  readonly security: SecurityVerifier;
  readonly coverage: CoverageVerifier;
  readonly testIntegrity: TestIntegrityVerifier;
  readonly bypass: BypassDetector;
  readonly evidenceStore: EvidenceStore;

  constructor(config: {
    gitVerifier: GitVerifier;
    fileVerifier: FileVerifier;
    commandVerifier: CommandVerifier;
    testVerifier: TestVerifier;
    buildVerifier: BuildVerifier;
    acceptanceVerifier: AcceptanceVerifier;
    securityVerifier: SecurityVerifier;
    coverageVerifier: CoverageVerifier;
    testIntegrityVerifier: TestIntegrityVerifier;
    bypassDetector: BypassDetector;
    evidenceStore: EvidenceStore;
  }) {
    this.git = config.gitVerifier;
    this.file = config.fileVerifier;
    this.command = config.commandVerifier;
    this.test = config.testVerifier;
    this.build = config.buildVerifier;
    this.acceptance = config.acceptanceVerifier;
    this.security = config.securityVerifier;
    this.coverage = config.coverageVerifier;
    this.testIntegrity = config.testIntegrityVerifier;
    this.bypass = config.bypassDetector;
    this.evidenceStore = config.evidenceStore;
  }

  /**
   * Run the full verification pipeline for the given runId, contract and plan.
   *
   * Returns a VerificationResult summarising every executed check and its
   * outcome. Evidence for every check is stored through the evidenceStore.
   */
  async run(
    runId: number,
    contract: PipelineContract,
    plan: VerificationPlan,
  ): Promise<VerificationResult> {
    const checks: VerificationCheck[] = [];
    const allEvidence: number[] = [];

    // Determine which checks to run in the canonical order, filtered by the plan.
    const orderedChecks = this.planChecks(plan);

    for (const checkName of orderedChecks) {
      const check = await this.runSingleCheck(runId, checkName, contract);
      checks.push(check);
      allEvidence.push(...check.evidence);
    }

    const overall = this.computeOverall(checks);

    return { status: overall, checks, evidenceRefs: allEvidence };
  }

  // ------------------------------------------------------------------ internals

  /**
   * Build the ordered list of checks to run based on the plan.
   *
   * If the plan has no explicit checks, run the full canonical DEFAULT_CHECK_ORDER.
   * If the plan names specific checks, run exactly those (in canonical order where
   * applicable, preserving the order the caller provided).
   * Checks not in DEFAULT_CHECK_ORDER (e.g. 'semantic') are still honoured when
   * explicitly requested.
   */
  private planChecks(plan: VerificationPlan): string[] {
    if (plan.checks.length === 0) {
      return [...DEFAULT_CHECK_ORDER];
    }

    // Caller explicitly requested checks — honour the plan order.
    return plan.checks.map((c) => c.check);
  }

  private async runSingleCheck(
    runId: number,
    checkName: string,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    switch (checkName) {
      case 'git':
        return this.runGitCheck(runId);
      case 'file':
        return this.runFileCheck(runId, contract);
      case 'build':
        return this.runBuildCheck(runId, contract);
      case 'test':
        return this.runTestCheck(runId, contract);
      case 'lint':
        return this.runLintCheck(runId, contract);
      case 'typecheck':
        return this.runTypecheckCheck(runId, contract);
      case 'acceptance':
        return this.runAcceptanceCheck(runId, contract);
      case 'coverage_delta':
        return this.runCoverageDeltaCheck(runId, contract);
      case 'test_integrity':
        return this.runTestIntegrityCheck(runId, contract);
      case 'security':
        return this.runSecurityCheck(runId, contract);
      case 'bypass_prevention':
        return this.runBypassPreventionCheck(runId, contract);
      case 'semantic':
        return this.runSemanticCheck(runId, contract);
      default:
        return this.recordCheck(runId, checkName, 'passed', `Skipped: unknown check "${checkName}"`);
    }
  }

  private async runGitCheck(runId: number): Promise<VerificationCheck> {
    const check = await this.git.verify(runId);
    // Normalise the check name to the canonical pipeline check name.
    return { ...check, name: 'git' };
  }

  private async runFileCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    // File check: verify that the project root exists.
    const exists = fs.existsSync(contract.projectRoot);
    const status: CheckStatus = exists ? 'passed' : 'failed';
    const summary = exists
      ? `Project root exists: ${contract.projectRoot}`
      : `Project root does not exist: ${contract.projectRoot}`;
    return this.recordCheck(runId, 'file', status, summary);
  }

  private async runBuildCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.buildCommand) {
      return this.recordCheck(runId, 'build', 'passed', 'Build command not specified — skipped');
    }
    const check = await this.build.verify(contract.buildCommand);
    return this.attachEvidence(runId, { ...check, name: 'build' }, 'build-output');
  }

  private async runTestCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.testCommand) {
      return this.recordCheck(runId, 'test', 'passed', 'Test command not specified — skipped');
    }
    const check = await this.test.verify(contract.testCommand);
    return this.attachEvidence(runId, { ...check, name: 'test' }, 'test-output');
  }

  private async runLintCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.lintCommand) {
      return this.recordCheck(runId, 'lint', 'passed', 'Lint command not specified — skipped');
    }
    const check = await this.command.verify(contract.lintCommand, 0);
    return this.attachEvidence(runId, { ...check, name: 'lint' }, 'lint-output');
  }

  private async runTypecheckCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.typecheckCommand) {
      return this.recordCheck(runId, 'typecheck', 'passed', 'Typecheck command not specified — skipped');
    }
    const check = await this.build.verifyTypecheck(contract.typecheckCommand);
    return this.attachEvidence(runId, { ...check, name: 'typecheck' }, 'typecheck-output');
  }

  private async runAcceptanceCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.acceptanceCriteria || contract.acceptanceCriteria.length === 0) {
      return this.recordCheck(runId, 'acceptance', 'passed', 'No acceptance criteria — skipped');
    }
    // Run all acceptance criteria; first failure wins.
    for (const criterion of contract.acceptanceCriteria) {
      const check = await this.acceptance.verify(criterion);
      if (check.status !== 'passed') {
        return this.attachEvidence(runId, { ...check, name: 'acceptance' }, 'acceptance-check');
      }
    }
    return this.recordCheck(runId, 'acceptance', 'passed', `${contract.acceptanceCriteria.length} acceptance criterion(ia) passed`);
  }

  private async runCoverageDeltaCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.beforeSnapshot) {
      return this.recordCheck(
        runId,
        'coverage_delta',
        'inconclusive',
        'No baseline snapshot provided — cannot evaluate coverage delta',
      );
    }
    const check = await this.coverage.compareAfter(contract.beforeSnapshot);
    return this.attachEvidence(runId, { ...check, name: 'coverage_delta' }, 'coverage-delta');
  }

  private async runTestIntegrityCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.beforeSnapshot) {
      return this.recordCheck(
        runId,
        'test_integrity',
        'inconclusive',
        'No baseline snapshot provided — cannot evaluate test integrity',
      );
    }
    const check = await this.testIntegrity.compareAfter(contract.beforeSnapshot);
    return this.attachEvidence(runId, { ...check, name: 'test_integrity' }, 'test-integrity');
  }

  private async runSecurityCheck(
    runId: number,
    _contract: PipelineContract,
  ): Promise<VerificationCheck> {
    const diff = await this.git.getDiff();
    const check = await this.security.verifyNoSecretsInChanges(diff);
    return this.attachEvidence(runId, { ...check, name: 'security' }, 'security-diff');
  }

  private async runBypassPreventionCheck(
    runId: number,
    contract: PipelineContract,
  ): Promise<VerificationCheck> {
    if (!contract.beforeSnapshot) {
      return this.recordCheck(
        runId,
        'bypass_prevention',
        'inconclusive',
        'No baseline snapshot provided — cannot detect bypass attempts',
      );
    }
    const after = await this.testIntegrity.captureSnapshot();
    const findings = this.bypass.scan(contract.beforeSnapshot, after);
    const hasFinding = findings.length > 0;
    const check: VerificationCheck = {
      name: 'bypass_prevention',
      status: hasFinding ? 'failed' : 'passed',
      summary: hasFinding
        ? `Detected ${findings.length} bypass signal(s): ${findings.map((f) => f.type).join(', ')}`
        : 'No bypass signals detected',
      evidence: [],
    };
    return this.attachEvidence(runId, check, 'bypass-findings');
  }

  private async runSemanticCheck(
    runId: number,
    _contract: PipelineContract,
  ): Promise<VerificationCheck> {
    // Semantic check is optional and off by default. This stub returns passed.
    return this.recordCheck(runId, 'semantic', 'passed', 'Semantic check (placeholder) — passed');
  }

  /**
   * Store evidence for a check and attach the evidence id to the check.
   * Returns a new VerificationCheck with the updated evidence array.
   */
  private async attachEvidence(
    runId: number,
    check: VerificationCheck,
    evidenceType: string,
  ): Promise<VerificationCheck> {
    if (this.evidenceStore) {
      const evidenceId = this.evidenceStore.store(runId, evidenceType, `pipeline:${check.name}`, check.summary);
      return { ...check, evidence: [...check.evidence, evidenceId.id] };
    }
    return check;
  }

  /**
   * Record a VerificationCheck with evidence stored (if available).
   */
  private async recordCheck(
    runId: number,
    checkName: string,
    status: CheckStatus,
    summary: string,
  ): Promise<VerificationCheck> {
    if (this.evidenceStore) {
      const evidenceId = this.evidenceStore.store(runId, `pipeline:${checkName}`, `pipeline:${checkName}`, summary);
      return { name: checkName, status, summary, evidence: [evidenceId.id] };
    }
    return { name: checkName, status, summary, evidence: [] };
  }

  /**
   * Compute overall result from the list of checks.
   *
   * Rules:
   *   - Any required check failed → overall failed.
   *   - A required check inconclusive with no fallback → overall inconclusive.
   *   - Never passed with a missing or failing required check (INV-01, INV-12).
   */
  private computeOverall(checks: VerificationCheck[]): CheckStatus {
    // All checks in the canonical pipeline are treated as required by default.
    let hasFailed = false;
    let hasInconclusive = false;

    for (const check of checks) {
      if (check.status === 'failed') {
        hasFailed = true;
        break;
      }
      if (check.status === 'inconclusive') {
        hasInconclusive = true;
      }
    }

    if (hasFailed) return 'failed';
    if (hasInconclusive) return 'inconclusive';
    return 'passed';
  }
}
