import { describe, it, expect } from 'vitest'
import { buildOpenCodePrompt } from '../../src/agent/opencode-prompt-builder.js'
import type { ExecutionContract } from '../../src/agent/execution-contract.js'

describe('buildOpenCodePrompt', () => {
  const baseContract: ExecutionContract = {
    id: 'c1',
    phaseId: 'ph-1',
    attempt: 1,
    objective: 'Add auth module',
    allowedPaths: ['src/auth/', 'src/routes/'],
    forbiddenPaths: ['config/secrets/'],
    allowedCapabilities: ['codeGeneration'],
    acceptanceCriteria: ['Login endpoint returns 200', 'Invalid creds return 401'],
    verificationPlan: ['npm test'],
    timeoutSeconds: 120,
    maxAttempts: 2,
    risk: 'high',
    rollbackPolicy: 'branch',
    expectedOutputs: ['src/auth/index.ts'],
  }

  it('includes objective in prompt', () => {
    const prompt = buildOpenCodePrompt(baseContract)
    expect(prompt).toContain('Add auth module')
  })

  it('includes all allowed paths', () => {
    const prompt = buildOpenCodePrompt(baseContract)
    expect(prompt).toContain('src/auth/')
    expect(prompt).toContain('src/routes/')
  })

  it('includes all forbidden paths', () => {
    const prompt = buildOpenCodePrompt(baseContract)
    expect(prompt).toContain('config/secrets/')
  })

  it('includes all acceptance criteria', () => {
    const prompt = buildOpenCodePrompt(baseContract)
    expect(prompt).toContain('Login endpoint returns 200')
    expect(prompt).toContain('Invalid creds return 401')
  })

  it('includes expected outputs', () => {
    const prompt = buildOpenCodePrompt(baseContract)
    expect(prompt).toContain('src/auth/index.ts')
  })

  it('includes footer', () => {
    const prompt = buildOpenCodePrompt(baseContract)
    expect(prompt).toContain('Report changes concisely.')
  })

  it('handles empty allowed paths gracefully', () => {
    const contract = { ...baseContract, allowedPaths: [] }
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('(none specified — all project paths allowed)')
  })

  it('handles empty forbidden paths gracefully', () => {
    const contract = { ...baseContract, forbiddenPaths: [] }
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('(none specified)')
  })

  it('handles empty expected outputs gracefully', () => {
    const contract = { ...baseContract, expectedOutputs: [] }
    const prompt = buildOpenCodePrompt(contract)
    expect(prompt).toContain('(see acceptance criteria)')
  })
})
