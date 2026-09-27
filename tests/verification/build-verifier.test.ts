import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { ProcessManager } from '../../src/agent/process-manager.js';
import { CommandVerifier } from '../../src/verification/command-verifier.js';
import { BuildVerifier } from '../../src/verification/build-verifier.js';
import type { CommandRequest } from '../../src/verification/verification-result.js';

const PROJECT_ROOT = process.cwd();
const TSC_BIN = path.resolve(PROJECT_ROOT, 'node_modules', '.bin', 'tsc');
const GOOD_FIXTURE = path.resolve(PROJECT_ROOT, 'tests', 'fixtures', 'build-good');
const BAD_FIXTURE = path.resolve(PROJECT_ROOT, 'tests', 'fixtures', 'build-bad');

function makeBuildVerifier(projectRoot: string): BuildVerifier {
  const cmdVerifier = new CommandVerifier(projectRoot, new ProcessManager());
  return new BuildVerifier(projectRoot, cmdVerifier);
}

describe('BuildVerifier', () => {
  it('successful build command returns passed', async () => {
    const verifier = makeBuildVerifier(GOOD_FIXTURE);
    const command: CommandRequest = {
      executable: TSC_BIN,
      args: ['--noEmit'],
      cwd: GOOD_FIXTURE,
    };
    const check = await verifier.verify(command);

    expect(check.status).toBe('passed');
    expect(check.name).toContain('tsc');
    expect(check.summary).toContain('0');
  });

  it('successful typecheck command returns passed', async () => {
    const verifier = makeBuildVerifier(GOOD_FIXTURE);
    const command: CommandRequest = {
      executable: TSC_BIN,
      args: ['--noEmit'],
      cwd: GOOD_FIXTURE,
    };
    const check = await verifier.verifyTypecheck(command);

    expect(check.status).toBe('passed');
    expect(check.name).toContain('tsc');
    expect(check.summary).toContain('0');
  });

  it('build error returns failed with stderr captured in summary', async () => {
    const verifier = makeBuildVerifier(BAD_FIXTURE);
    const command: CommandRequest = {
      executable: TSC_BIN,
      args: ['--noEmit'],
      cwd: BAD_FIXTURE,
    };
    const check = await verifier.verify(command);

    expect(check.status).toBe('failed');
    expect(check.name).toContain('tsc');
    expect(check.summary).toContain('expected 0');
  });

  it('typecheck error on bad fixture returns failed with stderr', async () => {
    const verifier = makeBuildVerifier(BAD_FIXTURE);
    const command: CommandRequest = {
      executable: TSC_BIN,
      args: ['--noEmit'],
      cwd: BAD_FIXTURE,
    };
    const check = await verifier.verifyTypecheck(command);

    expect(check.status).toBe('failed');
    expect(check.name).toContain('tsc');
    expect(check.summary).toContain('expected 0');
  });

  it('rejects a shell-string build command as failed', async () => {
    const verifier = makeBuildVerifier(PROJECT_ROOT);
    const check = await verifier.verify(
      'tsc --build && rm -rf /' as unknown as CommandRequest,
    );

    expect(check.status).toBe('failed');
    expect(check.summary).toContain('Rejected');
  });

  it('real project tsc --noEmit returns passed after type errors are fixed', async () => {
    // The real project previously had pre-existing type errors in
    // src/verification/test-verifier.ts. Those have been fixed, so tsc
    // now exits with code 0 and the build verifier reports passed.
    const verifier = makeBuildVerifier(PROJECT_ROOT);
    const command: CommandRequest = {
      executable: TSC_BIN,
      args: ['--noEmit'],
      cwd: PROJECT_ROOT,
    };
    const check = await verifier.verify(command);

    expect(check.status).toBe('passed');
    expect(check.name).toContain('tsc');
  });
});
