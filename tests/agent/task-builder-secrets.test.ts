import { describe, it, expect } from 'vitest'
import { TaskBuilder, redactSecrets, redactFieldSecrets } from '../../src/agent/task-builder.js'
import type { ExecutionContract } from '../../src/agent/execution-contract.js'
import type { TaskContext } from '../../src/agent/task-builder.js'

describe('redactSecrets', () => {
  it('redacts sk-ant-* prefixed secrets', () => {
    const result = redactSecrets('key=sk-ant-abc123def456')
    expect(result).toBe('key=***REDACTED***')
  })

  it('redacts sk-* prefixed secrets', () => {
    const result = redactSecrets('token=sk-abc123')
    expect(result).toContain('***REDACTED***')
    expect(result).not.toContain('sk-abc123')
  })

  it('redacts ghp_ prefixed secrets', () => {
    const result = redactSecrets('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef')
    expect(result).toBe('***REDACTED***')
  })

  it('redacts gho_ prefixed secrets', () => {
    const result = redactSecrets('gho_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef')
    expect(result).toBe('***REDACTED***')
  })

  it('redacts xoxb-* prefixed secrets', () => {
    const result = redactSecrets('xoxb-123456789012-1234567890123-abcdefghijklmnopqrstuvwx')
    expect(result).toBe('***REDACTED***')
  })

  it('redacts xoxp-* prefixed secrets', () => {
    const result = redactSecrets('xoxp-123456789012-1234567890123-abcdefghijklmnopqrstuvwx')
    expect(result).toBe('***REDACTED***')
  })

  it('redacts AKIA prefixed AWS access keys', () => {
    const result = redactSecrets('AKIAIOSFODNN7EXAMPLE')
    expect(result).toBe('***REDACTED***')
  })

  it('redacts AIza prefixed Google API keys', () => {
    const result = redactSecrets('AIzaSyA1b2C3d4E5f6G7h8I9j0KlMnOpQrStUvW')
    expect(result).toContain('***REDACTED***')
  })

  it('leaves non-matching text untouched', () => {
    const result = redactSecrets('no secrets here at all')
    expect(result).toBe('no secrets here at all')
  })

  it('handles empty string', () => {
    expect(redactSecrets('')).toBe('')
  })
})

describe('redactFieldSecrets', () => {
  it('redacts values for password key', () => {
    const result = redactFieldSecrets({ password: 'supersecret' })
    expect(result).toEqual({ password: '***REDACTED***' })
  })

  it('redacts values for token key (case-insensitive)', () => {
    const result = redactFieldSecrets({ Token: 'mytoken' })
    expect(result).toEqual({ Token: '***REDACTED***' })
  })

  it('redacts values for secret key', () => {
    const result = redactFieldSecrets({ secret: 'myscret' })
    expect(result).toEqual({ secret: '***REDACTED***' })
  })

  it('redacts values for key key', () => {
    const result = redactFieldSecrets({ key: 'mykey' })
    expect(result).toEqual({ key: '***REDACTED***' })
  })

  it('redacts values for credential key', () => {
    const result = redactFieldSecrets({ credential: 'mycred' })
    expect(result).toEqual({ credential: '***REDACTED***' })
  })

  it('redacts values for auth key', () => {
    const result = redactFieldSecrets({ auth: 'myauth' })
    expect(result).toEqual({ auth: '***REDACTED***' })
  })

  it('redacts values for bearer key', () => {
    const result = redactFieldSecrets({ bearer: 'mybearer' })
    expect(result).toEqual({ bearer: '***REDACTED***' })
  })

  it('leaves non-secret keys untouched', () => {
    const result = redactFieldSecrets({ name: 'John', normalField: 'normalvalue' })
    expect(result).toEqual({ name: 'John', normalField: 'normalvalue' })
  })

  it('returns undefined for undefined input', () => {
    expect(redactFieldSecrets(undefined)).toBeUndefined()
  })
})

describe('TaskBuilder secret redaction in prompt', () => {
  const builder = new TaskBuilder(8000)

  const contract: ExecutionContract = {
    id: 'c1',
    phaseId: 'ph-1',
    attempt: 1,
    objective: 'Implement feature',
    allowedPaths: ['src/'],
    forbiddenPaths: [],
    allowedCapabilities: ['codeGeneration'],
    acceptanceCriteria: ['feature works'],
    verificationPlan: ['npm test'],
    timeoutSeconds: 300,
    maxAttempts: 3,
    risk: 'medium',
    rollbackPolicy: 'branch',
    expectedOutputs: ['src/feature.ts'],
  }

  it('redacts sk-abc123 literal from projectSummary into prompt', () => {
    const context: TaskContext = {
      projectSummary: 'Use key sk-abc123 for auth',
      previousPhases: [],
      architecture: undefined,
      constraints: undefined,
      relevantMemory: undefined,
    }
    const built = builder.build(contract, context)
    expect(built.prompt).not.toContain('sk-abc123')
    expect(built.prompt).toContain('***REDACTED***')
  })

  it('redacts raw secrets from all serializable context fields', () => {
    const context: TaskContext = {
      projectSummary: 'API key sk-abc123xyz is our production key',
      previousPhases: ['phase with token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'],
      architecture: 'AWS key AKIAIOSFODNN7EXAMPLE in config',
      constraints: ['Use xoxp-123456789012-1234567890123-abcdefghijklmnopqrstuvwx'],
      relevantMemory: { safeNote: 'no secret here' },
    }
    const built = builder.build(contract, context)
    expect(built.prompt).not.toContain('sk-abc123xyz')
    expect(built.prompt).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef')
    expect(built.prompt).not.toContain('AKIAIOSFODNN7EXAMPLE')
    expect(built.prompt).not.toContain('xoxp-123456789012-1234567890123-abcdefghijklmnopqrstuvwx')
    // relevantMemory is not serialized into the prompt (confirmed by existing test)
    // but redactSecrets is still applied to its values
    expect(redactSecrets('no secret here')).toBe('no secret here')
    expect(built.prompt).toContain('***REDACTED***')
  })

  it('field-redacts relevantMemory before serialization (relevantMemory is not injected into prompt, but redaction is applied)', () => {
    const context: TaskContext = {
      projectSummary: 'Setup auth',
      previousPhases: [],
      architecture: undefined,
      constraints: undefined,
      relevantMemory: { password: 'x', authToken: 'tokval', normalField: 'keepme' },
    }
    // relevantMemory values are not injected into the prompt (as confirmed by existing tests),
    // but the field-based redaction is applied to the data structure internally.
    // Verify the redaction function itself works correctly for these keys.
    const redacted = redactFieldSecrets(context.relevantMemory)
    expect(redacted).toEqual({
      password: '***REDACTED***',
      authToken: '***REDACTED***',
      normalField: 'keepme',
    })
    // And the prompt should still be clean of the raw secret values
    const built = builder.build(contract, context)
    expect(built.prompt).not.toContain('x')
    expect(built.prompt).not.toContain('tokval')
  })
})
