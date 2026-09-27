import {
  type CommandRequest,
  type VerificationCheck,
} from './verification-result.js';
import { CommandVerifier } from './command-verifier.js';

/**
 * Verifier that runs TypeScript build and typecheck commands via a
 * {@link CommandVerifier} and records results as VerificationChecks.
 *
 * Both methods delegate to the embedded CommandVerifier, treating an exit
 * code of 0 as success and any non-zero exit (or execution error) as failure.
 * Stderr from failed runs is attached as evidence when an EvidenceStore is
 * wired into the CommandVerifier.
 */
export class BuildVerifier {
  constructor(
    private readonly projectRoot: string,
    private readonly commandVerifier: CommandVerifier,
  ) {}

  /**
   * Run a build command (e.g. `tsc --build`) and return a VerificationCheck.
   * Exit code 0 → passed; any other exit code or execution error → failed.
   */
  async verify(buildCommand: CommandRequest): Promise<VerificationCheck> {
    return this.commandVerifier.verify(buildCommand, 0);
  }

  /**
   * Run a TypeScript typecheck command (e.g. `tsc --noEmit`) and return a
   * VerificationCheck. Exit code 0 → passed; any other exit code or execution
   * error → failed.
   */
  async verifyTypecheck(command: CommandRequest): Promise<VerificationCheck> {
    return this.commandVerifier.verify(command, 0);
  }
}
