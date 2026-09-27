import { describe, it, expect } from 'vitest'
import { TaskBuilder } from '../../src/agent/task-builder.js'
import type { ExecutionContract } from '../../src/agent/execution-contract.js'
import type { TaskContext } from '../../src/agent/task-builder.js'

describe('TaskBuilder', () => {
  const builder = new TaskBuilder(8000)

  const contract: ExecutionContract = {
    id: 'c1',
    phaseId: 'ph-1',
    attempt: 1,
    objective: 'Implement authentication module',
    allowedPaths: ['src/auth/', 'src/routes/'],
    forbiddenPaths: ['config/secrets/', '.git/'],
    allowedCapabilities: ['codeGeneration'],
    acceptanceCriteria: ['Login endpoint returns 200', 'Invalid creds return 401'],
    verificationPlan: ['npm test'],
    timeoutSeconds: 300,
    maxAttempts: 3,
    risk: 'high',
    rollbackPolicy: 'branch',
    expectedOutputs: ['src/auth/index.ts', 'src/auth/middleware.ts'],
  }

  const context: TaskContext = {
    projectSummary: 'A Node.js web app with Express.',
    previousPhases: ['phase-setup', 'phase-config'],
    architecture: 'Layered architecture: controllers, services, models.',
    constraints: ['No external auth libraries', 'Use JWT tokens'],
    relevantMemory: { note: 'Auth tests written previously' },
  }

  it('includes objective in prompt', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('Implement authentication module')
  })

  it('includes allowed paths', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('src/auth/')
    expect(built.prompt).toContain('src/routes/')
  })

  it('includes forbidden paths', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('config/secrets/')
    expect(built.prompt).toContain('.git/')
  })

  it('includes acceptance criteria', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('Login endpoint returns 200')
    expect(built.prompt).toContain('Invalid creds return 401')
  })

  it('includes expected outputs', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('src/auth/index.ts')
    expect(built.prompt).toContain('src/auth/middleware.ts')
  })

  it('includes project summary when budget allows', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('A Node.js web app with Express.')
  })

  it('includes previous phases', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('phase-setup')
    expect(built.prompt).toContain('phase-config')
  })

  it('includes architecture when provided', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('Layered architecture')
  })

  it('includes constraints when provided', () => {
    const built = builder.build(contract, context)
    expect(built.prompt).toContain('No external auth libraries')
    expect(built.prompt).toContain('Use JWT tokens')
  })

  it('respects budget — truncates large sections', () => {
    const bigContext: TaskContext = {
      projectSummary: 'x'.repeat(10000),
      previousPhases: [],
      architecture: undefined,
      constraints: undefined,
      relevantMemory: undefined,
    }
    const built = builder.build(contract, bigContext)
    expect(built.metadata.estimatedTokens).toBeLessThanOrEqual(8000)
    // Objective and critical sections still present
    expect(built.prompt).toContain('Implement authentication module')
    expect(built.prompt).toContain('### FORBIDDEN PATHS')
  })

  it('metadata contains contract fields', () => {
    const built = builder.build(contract, context)
    expect(built.metadata.contractId).toBe('c1')
    expect(built.metadata.phaseId).toBe('ph-1')
    expect(built.metadata.attempt).toBe(1)
    expect(typeof built.metadata.estimatedTokens).toBe('number')
  })

  it('does not include out-of-scope memory fields', () => {
    const built = builder.build(contract, context)
    // relevantMemory values are informational but not injected as content
    // The prompt should not leak raw memory content verbatim as instructions
    expect(built.prompt).not.toContain('Auth tests written previously')
  })

  it('handles empty context gracefully', () => {
    const emptyContext: TaskContext = {
      projectSummary: '',
      previousPhases: [],
    }
    const built = builder.build(contract, emptyContext)
    expect(built.prompt).toContain('Implement authentication module')
    expect(built.prompt).toContain('### ACCEPTANCE CRITERIA')
  })

  it('redacts secrets from context', () => {
    const secretContext: TaskContext = {
      projectSummary: 'API key: sk-abc123xyz789 is our production key',
      previousPhases: ['phase with token=ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef'],
      architecture: undefined,
      constraints: undefined,
      relevantMemory: { dbPassword: 'supersecret123' },
    }
    const built = builder.build(contract, secretContext)
    expect(built.prompt).not.toContain('sk-abc123xyz789')
    expect(built.prompt).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef')
    expect(built.prompt).not.toContain('supersecret123')
    expect(built.prompt).toContain('***REDACTED***')
  })
})
