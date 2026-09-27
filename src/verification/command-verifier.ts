import { ProcessManager } from '../agent/process-manager.js';
import { EvidenceStore } from './evidence-store.js';
import {
  type CommandRequest,
  type VerificationCheck,
  type CheckStatus,
} from './verification-result.js';

/** Default timeout in ms when the request does not specify one. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Shell metacharacters that indicate a command is a shell string rather than a
 * structured, safe-to-spawn invocation.
 */
const SHELL_METACHARACTER_RE = /[|&;<>\u0026\u007c\u003b\u003c\u003e]/;

/**
 * Returns true if the value contains any shell metacharacter.
 */
function containsShellMetacharacters(value: string): boolean {
  return SHELL_METACHARACTER_RE.test(value);
}

/**
 * Builds a failed VerificationCheck for an invalid or rejected command request.
 */
function makeFailedCheck(name: string, reason: string): VerificationCheck {
  return {
    name,
    status: 'failed' as CheckStatus,
    summary: `Rejected: ${reason}`,
    evidence: [],
  };
}

/**
 * Verifier that runs structured CommandRequest invocations via a ProcessManager
 * and records results as VerificationChecks.
 *
 * Only structured (non-shell) commands are supported. Requests whose executable
 * or any argument contains shell metacharacters (||, &&, |, ;, &, <, >) are
 * rejected as a failed check — never by throwing.
 */
export class CommandVerifier {
  constructor(
    private readonly projectRoot: string,
    private readonly processManager: ProcessManager,
    private readonly evidenceStore?: EvidenceStore,
  ) {}

  /**
   * Run a structured command and return a VerificationCheck indicating whether
   * the actual exit code matches the expected one.
   *
   * @param command   A structured CommandRequest (executable + args, no shell).
   * @param expectExitCode  The exit code considered a pass.
   */
  async verify(
    command: CommandRequest,
    expectExitCode: number,
  ): Promise<VerificationCheck> {
    // Runtime guard: reject plain strings or objects without executable.
    if (typeof command === 'string') {
      return makeFailedCheck(
        'command-verifier',
        'Request is a shell string, not a structured CommandRequest',
      );
    }
    if (!command || typeof command.executable !== 'string') {
      return makeFailedCheck(
        'command-verifier',
        'Request is missing a structured executable field',
      );
    }

    // Reject shell metacharacters in the executable.
    if (containsShellMetacharacters(command.executable)) {
      return makeFailedCheck(
        'command-verifier',
        `executable contains shell metacharacters: "${command.executable}"`,
      );
    }

    // Reject shell metacharacters in any argument.
    for (const arg of command.args) {
      if (containsShellMetacharacters(arg)) {
        return makeFailedCheck(
          'command-verifier',
          `argument contains shell metacharacters: "${arg}"`,
        );
      }
    }

    const checkName = `${command.executable} ${command.args.join(' ')}`;
    const cwd = command.cwd ?? this.projectRoot;
    const timeoutMs = command.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    try {
      const result = await this.processManager.spawn({
        executable: command.executable,
        args: command.args,
        cwd,
        timeoutMs,
      });

      const exitCodeMatch = result.exitCode === expectExitCode;
      const status: CheckStatus = exitCodeMatch ? 'passed' : 'failed';
      const summary = exitCodeMatch
        ? `Exit code ${result.exitCode} matched expected ${expectExitCode}`
        : `Exit code ${result.exitCode} did not match expected ${expectExitCode}`;

      const check: VerificationCheck = {
        name: checkName,
        status,
        summary,
        evidence: [],
      };

      // Attach stderr as evidence when available and a store is provided.
      if (this.evidenceStore && result.stderr.length > 0) {
        const evidenceId = this.evidenceStore.store(
          0, // run id placeholder; caller can re-attach if needed
          'stderr',
          `verification:${checkName}`,
          result.stderr,
        );
        check.evidence.push(evidenceId.id);
      }

      return check;
    } catch (err) {
      return makeFailedCheck(
        checkName,
        `Execution error: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Capture stdout from a structured command. Returns the stdout string.
   * Shell-string requests are rejected as an empty string with a console error.
   */
  async captureStdout(command: CommandRequest): Promise<string> {
    const validation = this.validate(command);
    if (!validation.valid) {
      console.error(`captureStdout rejected: ${validation.reason}`);
      return '';
    }

    const result = await this.processManager.spawn({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd ?? this.projectRoot,
      timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    return result.stdout;
  }

  /**
   * Capture stderr from a structured command. Returns the stderr string.
   * Shell-string requests are rejected as an empty string with a console error.
   */
  async captureStderr(command: CommandRequest): Promise<string> {
    const validation = this.validate(command);
    if (!validation.valid) {
      console.error(`captureStderr rejected: ${validation.reason}`);
      return '';
    }

    const result = await this.processManager.spawn({
      executable: command.executable,
      args: command.args,
      cwd: command.cwd ?? this.projectRoot,
      timeoutMs: command.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    });

    return result.stderr;
  }

  /**
   * Lightweight validation without side effects. Returns { valid: true } or
   * { valid: false, reason }.
   */
  validate(command: CommandRequest): { valid: true } | { valid: false; reason: string } {
    if (typeof command === 'string') {
      return {
        valid: false,
        reason: 'Request is a shell string, not a structured CommandRequest',
      };
    }
    if (!command || typeof command.executable !== 'string') {
      return {
        valid: false,
        reason: 'Request is missing a structured executable field',
      };
    }
    if (containsShellMetacharacters(command.executable)) {
      return {
        valid: false,
        reason: `executable contains shell metacharacters: "${command.executable}"`,
      };
    }
    for (const arg of command.args) {
      if (containsShellMetacharacters(arg)) {
        return {
          valid: false,
          reason: `argument contains shell metacharacters: "${arg}"`,
        };
      }
    }
    return { valid: true };
  }
}
