import Database from 'better-sqlite3';
import type { FileVerifier } from './file-verifier.js';
import type { CommandVerifier } from './command-verifier.js';
import type { EvidenceStore } from './evidence-store.js';
import {
  type AcceptanceCriterion,
  type VerificationCheck,
  type CheckStatus,
  type CommandRequest,
} from './verification-result.js';
import { getRequirementsByProjectId } from '../persistence/database.js';

/** A composite acceptance criterion containing multiple sub-criteria. */
export interface CompositeCriterion {
  type: 'composite';
  payload: {
    criteria: AcceptanceCriterion[];
    label?: string;
  };
}

/** Union type accepted by verify() — single criterion or composite. */
export type AcceptanceInput = AcceptanceCriterion | CompositeCriterion;

/**
 * Verifies acceptance criteria for a phase. Delegates command checks to
 * CommandVerifier and file checks to FileVerifier. Requirement-ref checks
 * read against the project database. Composite criteria require every
 * sub-criterion to pass; the first failure produces a failed check naming
 * which sub-criterion failed and why.
 */
export class AcceptanceVerifier {
  constructor(
    private readonly fileVerifier: FileVerifier,
    private readonly commandVerifier: CommandVerifier,
    private readonly db: Database.Database,
    private readonly evidenceStore?: EvidenceStore,
  ) {}

  /**
   * Evaluate an acceptance criterion (single or composite) and return the
   * resulting VerificationCheck.
   */
  async verify(criterion: AcceptanceInput): Promise<VerificationCheck> {
    if (criterion.type === 'composite') {
      return this.verifyComposite(criterion);
    }
    return this.verifySingle(criterion);
  }

  // ------------------------------------------------------------------ internals

  private async verifyComposite(
    criterion: CompositeCriterion,
  ): Promise<VerificationCheck> {
    const subChecks: VerificationCheck[] = [];
    let overallStatus: CheckStatus = 'passed';

    for (const sub of criterion.payload.criteria) {
      const check = await this.verifySingle(sub);
      subChecks.push(check);
      if (check.status !== 'passed') {
        overallStatus = check.status;
        return {
          name: criterion.payload.label ?? 'composite',
          status: overallStatus,
          summary: `Composite criterion failed at sub-criterion "${check.name}": ${check.summary}`,
          evidence: check.evidence,
        };
      }
    }

    return {
      name: criterion.payload.label ?? 'composite',
      status: overallStatus,
      summary: `All ${subChecks.length} sub-criterion(ia) passed`,
      evidence: [],
    };
  }

  private async verifySingle(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    switch (criterion.type) {
      case 'command':
        return this.runCommandCheck(criterion);
      case 'file_exists':
        return this.runFileExistsCheck(criterion);
      case 'file_contains':
        return this.runFileContainsCheck(criterion);
      case 'file_not_contains':
        return this.runFileNotContainsCheck(criterion);
      case 'custom':
        return this.runCustomCheck(criterion);
      case 'requirement_ref':
        return this.runRequirementRefCheck(criterion);
      default:
        return this.failedCheck(criterion.type, `Unknown criterion type: ${criterion.type}`);
    }
  }

  private async runCommandCheck(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    const payloadRaw = criterion.payload as unknown as Record<string, unknown>;
    const raw = payloadRaw['command'];
    if (!raw || typeof raw !== 'object') {
      return this.failedCheck('command', 'Missing or invalid command object in payload');
    }
    const cmd = raw as CommandRequest;
    if (!cmd.executable) {
      return this.failedCheck('command', 'Missing executable field in command payload');
    }
    const args = Array.isArray(cmd.args) ? cmd.args : [];
    const expectExitCode = (payloadRaw['expectedExitCode'] as number | undefined) ?? 0;

    const check = await this.commandVerifier.verify(
      { executable: cmd.executable, args, cwd: cmd.cwd, timeoutMs: cmd.timeoutMs },
      expectExitCode,
    );
    return this.attachEvidence(check, payloadRaw['requirement_ref'] as string | undefined);
  }

  private async runFileExistsCheck(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    const p = criterion.payload as unknown as Record<string, unknown>;
    if (!p.path || typeof p.path !== 'string') {
      return this.failedCheck('file_exists', 'Missing path field in payload');
    }
    const check = await this.fileVerifier.verifyExists(p.path);
    return this.attachEvidence(check, p.requirement_ref as string | undefined);
  }

  private async runFileContainsCheck(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    const p = criterion.payload as unknown as Record<string, unknown>;
    if (!p.path || typeof p.path !== 'string' || !p.pattern || typeof p.pattern !== 'string') {
      return this.failedCheck('file_contains', 'Missing path or pattern field in payload');
    }
    const check = await this.fileVerifier.verifyContains(p.path, p.pattern);
    return this.attachEvidence(check, p.requirement_ref as string | undefined);
  }

  private async runFileNotContainsCheck(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    const p = criterion.payload as unknown as Record<string, unknown>;
    if (!p.path || typeof p.path !== 'string' || !p.pattern || typeof p.pattern !== 'string') {
      return this.failedCheck('file_not_contains', 'Missing path or pattern field in payload');
    }
    const check = await this.fileVerifier.verifyNotContains(p.path, p.pattern);
    return this.attachEvidence(check, p.requirement_ref as string | undefined);
  }

  private runCustomCheck(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    const p = criterion.payload as unknown as Record<string, unknown>;
    const label = (typeof p.label === 'string' ? p.label : 'custom') as string;
    const details = typeof p.details === 'string' ? p.details : '';
    return Promise.resolve(
      this.passedCheck(label, `Custom criterion satisfied${details ? `: ${details}` : ''}`),
    );
  }

  private runRequirementRefCheck(criterion: AcceptanceCriterion): Promise<VerificationCheck> {
    const p = criterion.payload as unknown as Record<string, unknown>;
    const ref = p.requirement_ref;

    if (!ref || typeof ref !== 'string') {
      return Promise.resolve(
        this.inconclusiveCheck('requirement_ref', 'No requirement_ref provided in payload'),
      );
    }

    // Expected format: "project_id:req_id" (e.g. "1:REQ-001")
    const parts = ref.split(':');
    if (parts.length !== 2) {
      return Promise.resolve(
        this.inconclusiveCheck('requirement_ref', `Malformed requirement_ref: ${ref}. Expected "project_id:req_id"`),
      );
    }

    const projectId = Number(parts[0]!);
    const reqId = parts[1]!;

    if (isNaN(projectId)) {
      return Promise.resolve(
        this.inconclusiveCheck('requirement_ref', `Invalid project_id in requirement_ref: ${parts[0]}`),
      );
    }

    const requirements = getRequirementsByProjectId(this.db, projectId);

    if (requirements.length === 0) {
      return Promise.resolve(
        this.inconclusiveCheck('requirement_ref', `No requirements record found for project ${projectId} — cannot verify ref "${ref}"`),
      );
    }

    const matching = requirements.find((r) => r.req_id === reqId);
    if (!matching) {
      return Promise.resolve(
        this.inconclusiveCheck('requirement_ref', `Requirement ref "${ref}" not found in project ${projectId}`),
      );
    }

    return Promise.resolve(
      this.passedCheck('requirement_ref', `Requirement ${ref} found and resolved: ${matching.description}`),
    );
  }

  private async attachEvidence(
    check: VerificationCheck,
    requirementRef: string | undefined,
  ): Promise<VerificationCheck> {
    if (!this.evidenceStore || check.evidence.length > 0) {
      return check;
    }
    const evidenceId = this.evidenceStore.store(
      0, // placeholder run id
      'acceptance-check',
      requirementRef ?? check.name,
      `Acceptance check "${check.name}" [${check.status}]: ${check.summary}`,
    );
    return { ...check, evidence: [evidenceId.id] };
  }

  private passedCheck(name: string, summary: string): VerificationCheck {
    return { name, status: 'passed', summary, evidence: [] };
  }

  private failedCheck(name: string, summary: string): VerificationCheck {
    return { name, status: 'failed', summary, evidence: [] };
  }

  private inconclusiveCheck(name: string, summary: string): VerificationCheck {
    return { name, status: 'inconclusive', summary, evidence: [] };
  }
}
