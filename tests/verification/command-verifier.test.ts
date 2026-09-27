import { describe, it, expect, beforeEach } from 'vitest';
import { ProcessManager } from '../../src/agent/process-manager.js';
import { CommandVerifier } from '../../src/verification/command-verifier.js';
import type { CommandRequest } from '../../src/verification/verification-result.js';

const PROJECT_ROOT = process.cwd();

function makeVerifier(): CommandVerifier {
  return new CommandVerifier(PROJECT_ROOT, new ProcessManager());
}

describe('CommandVerifier', () => {
  let verifier: CommandVerifier;

  beforeEach(() => {
    verifier = makeVerifier();
  });

  it('exit 0 as expected → passed', async () => {
    const command: CommandRequest = {
      executable: 'node',
      args: ['-e', 'process.exit(0)'],
    };
    const check = await verifier.verify(command, 0);

    expect(check.status).toBe('passed');
    expect(check.name).toContain('node');
    expect(check.summary).toContain('0');
  });

  it('non-zero exit code → failed with mismatch in summary', async () => {
    const command: CommandRequest = {
      executable: 'node',
      args: ['-e', 'process.exit(42)'],
    };
    const check = await verifier.verify(command, 0);

    expect(check.status).toBe('failed');
    expect(check.summary).toContain('42');
    expect(check.summary).toContain('expected 0');
  });

  it('timeout handled — process killed, returns failed check', async () => {
    const command: CommandRequest = {
      executable: 'ping',
      args: ['-n', '5', '127.0.0.1'],
      timeoutMs: 300,
    };

    const check = await verifier.verify(command, 0);

    expect(check.status).toBe('failed');
    // Summary should mention the exit code mismatch or timeout.
    expect(check.summary).toContain('expected 0');
  }, 30000);

  it('arbitrary shell-string request rejected as failed check', async () => {
    // Pass a plain string where a CommandRequest is expected.
    // TypeScript types forbid this, but at runtime the check must handle it.
    const check = await verifier.verify(
       
      'echo hello && rm -rf /' as unknown as CommandRequest,
      0,
    );

    expect(check.status).toBe('failed');
    expect(check.summary).toContain('Rejected');
  });

  it('an arg containing "&&" is rejected as failed check', async () => {
    const command: CommandRequest = {
      executable: 'echo',
      args: ['foo&&bar'],
    };

    const check = await verifier.verify(command, 0);

    expect(check.status).toBe('failed');
    expect(check.summary).toContain('Rejected');
    expect(check.summary).toContain('&&');
  });

  it('captureStdout returns stdout from a successful command', async () => {
    const stdout = await verifier.captureStdout({
      executable: 'node',
      args: ['-e', 'console.log("captured-stdout")'],
    });

    expect(stdout).toContain('captured-stdout');
  });

  it('captureStderr returns stderr from a failing command', async () => {
    const stderr = await verifier.captureStderr({
      executable: 'node',
      args: ['-e', 'console.error("captured-stderr")'],
    });

    expect(stderr).toContain('captured-stderr');
  });

  it('captureStdout rejects a shell-string request and returns empty string', async () => {
     
    const result = await verifier.captureStdout('bad-shell-cmd' as unknown as CommandRequest);
    expect(result).toBe('');
  });

  it('captureStderr rejects an arg with shell metacharacters and returns empty string', async () => {
    const result = await verifier.captureStderr({
      executable: 'echo',
      args: ['a;b'],
    } as CommandRequest);
    expect(result).toBe('');
  });

  it('validate accepts a well-formed CommandRequest', () => {
    const result = verifier.validate({
      executable: 'node',
      args: ['-e', 'process.exit(0)'],
    });
    expect(result).toEqual({ valid: true });
  });

  it('validate rejects a plain string', () => {
    const result = verifier.validate(
       
      'shell-string' as unknown as CommandRequest,
    );
    expect(result).toEqual({
      valid: false,
      reason: expect.stringContaining('shell string'),
    });
  });

  it('validate rejects an arg containing ||', () => {
    const result = verifier.validate({
      executable: 'cmd',
      args: ['foo||bar'],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain('||');
    }
  });

  it('validate rejects an executable containing ;', () => {
    const result = verifier.validate({
      executable: 'echo;rm',
      args: [],
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.reason).toContain(';');
    }
  });
});
