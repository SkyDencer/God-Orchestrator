import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { OpenCodeAdapter } from '../../src/agent/opencode-adapter.js'
import type { ExecutionContract } from '../../src/agent/execution-contract.js'
import { buildOpenCodePrompt } from '../../src/agent/opencode-prompt-builder.js'

describe('OpenCodeAdapter', () => {
  const adapter = new OpenCodeAdapter({
    executable: 'opencode',
    model: 'test-model',
    useCmdWrapper: false,
  })

  it('has correct name and capabilities', () => {
    expect(adapter.name).toBe('opencode')
    expect(adapter.capabilities.codeGeneration).toBe(true)
    expect(adapter.capabilities.sessionResume).toBe(false)
    expect(adapter.capabilities.streaming).toBe(true)
  })

  it('is instantiable', () => {
    expect(adapter).toBeDefined()
    expect(typeof adapter.healthCheck).toBe('function')
    expect(typeof adapter.startSession).toBe('function')
    expect(typeof adapter.executeTask).toBe('function')
    expect(typeof adapter.resumeSession).toBe('function')
    expect(typeof adapter.stopSession).toBe('function')
  })

  it('startSession creates a session record', async () => {
    const session = await adapter.startSession({
      projectId: 'proj-1',
      phaseId: 'ph-1',
      attempt: 1,
      workingDir: '/tmp/test',
      model: 'test-model',
      provider: 'test-provider',
    })
    expect(session.id).toBeTruthy()
    expect(session.projectId).toBe('proj-1')
    expect(session.phaseId).toBe('ph-1')
    expect(session.attempt).toBe(1)
    expect(session.status).toBe('starting')
    expect(session.startedAt).toBeGreaterThan(0)
  })
})

describe('buildOpenCodePrompt', () => {
  const contract: ExecutionContract = {
    id: 'c1',
    phaseId: 'ph-1',
    attempt: 1,
    objective: 'Implement feature X',
    allowedPaths: ['src/', 'tests/'],
    forbiddenPaths: ['node_modules/', '.git/'],
    allowedCapabilities: ['codeGeneration', 'testExecution'],
    acceptanceCriteria: ['All tests pass', 'No lint errors'],
    verificationPlan: ['npm test'],
    timeoutSeconds: 300,
    maxAttempts: 3,
    risk: 'medium',
    rollbackPolicy: 'checkpoint',
    expectedOutputs: ['src/feature.ts', 'tests/feature.test.ts'],
  }

  it('includes objective', () => {
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('Implement feature X')
  })

  it('includes allowed paths', () => {
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('src/')
    expect(prompt).toContain('tests/')
  })

  it('includes forbidden paths', () => {
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('node_modules/')
    expect(prompt).toContain('.git/')
  })

  it('includes acceptance criteria', () => {
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('All tests pass')
    expect(prompt).toContain('No lint errors')
  })

  it('includes expected outputs', () => {
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('src/feature.ts')
    expect(prompt).toContain('tests/feature.test.ts')
  })

  it('includes footer', () => {
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('Report changes concisely.')
  })
})

describe('OpenCodeAdapter healthCheck (real)', () => {
  it('healthCheck reports version when opencode is available via cmd /c', async () => {
    // Use cmd wrapper since opencode is a .cmd on Windows
    const adapter = new OpenCodeAdapter({
      executable: 'opencode',
      model: 'test-model',
      useCmdWrapper: true,
    })
    const health = await adapter.healthCheck()
    expect(health.healthy).toBe(true)
    expect(typeof health.version).toBe('string')
  })
})
