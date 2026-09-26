import { describe, it, expect } from 'vitest'
import type {
  AgentCapabilities,
  AgentSession,
  AgentRun,
  HealthStatus,
  SessionConfig,
} from '../../src/agent/types.js'
import type { ExecutionContract } from '../../src/agent/execution-contract.js'
import type { AgentAdapter } from '../../src/agent/adapter.js'

describe('AgentAdapter types', () => {
  it('compiles — all interfaces exist', () => {
    // These just need to compile. If compilation passes, interfaces are correct.
    const _config: SessionConfig = {
      projectId: 'p1',
      phaseId: 'ph1',
      attempt: 1,
      workingDir: '/tmp',
      model: 'test',
      provider: 'test',
    }
    const _session: AgentSession = {
      id: 's1',
      projectId: 'p1',
      phaseId: 'ph1',
      attempt: 1,
      status: 'starting',
      startedAt: Date.now(),
      metadata: {},
    }
    const _contract: ExecutionContract = {
      id: 'c1',
      phaseId: 'ph1',
      attempt: 1,
      objective: 'test',
      allowedPaths: [],
      forbiddenPaths: [],
      allowedCapabilities: [],
      acceptanceCriteria: [],
      verificationPlan: [],
      timeoutSeconds: 300,
      maxAttempts: 3,
      risk: 'low',
      rollbackPolicy: 'none',
      expectedOutputs: [],
    }
    const _health: HealthStatus = { healthy: true }
    const _capabilities: AgentCapabilities = {
      codeGeneration: true,
      multiFileEdit: true,
      shellAccess: true,
      gitIntegration: true,
      testExecution: true,
      subagents: true,
      skills: true,
      mcp: true,
      streaming: true,
      sessionResume: false,
    }
    expect(_config.projectId).toBe('p1')
    expect(_session.id).toBe('s1')
    expect(_contract.id).toBe('c1')
    expect(_health.healthy).toBe(true)
    expect(_capabilities.codeGeneration).toBe(true)
  })

  it('mock adapter is creatable and all methods callable', async () => {
    const mock: AgentAdapter = {
      name: 'mock',
      capabilities: {
        codeGeneration: true,
        multiFileEdit: true,
        shellAccess: true,
        gitIntegration: true,
        testExecution: true,
        subagents: true,
        skills: true,
        mcp: true,
        streaming: true,
        sessionResume: false,
      },
      healthCheck: async () => ({ healthy: true }),
      startSession: async () =>
        ({
          id: 's1',
          projectId: 'p1',
          phaseId: 'ph1',
          attempt: 1,
          status: 'starting',
          startedAt: Date.now(),
          metadata: {},
        }) as AgentSession,
      executeTask: async () =>
        ({
          id: 'r1',
          sessionId: 's1',
          phaseId: 'ph1',
          contractId: 'c1',
          attempt: 1,
          startedAt: Date.now(),
          status: 'running',
        }) as AgentRun,
      resumeSession: async () =>
        ({
          id: 's1',
          projectId: 'p1',
          phaseId: 'ph1',
          attempt: 1,
          status: 'active',
          startedAt: Date.now(),
          metadata: {},
        }) as AgentSession,
      stopSession: async () => undefined,
    }

    expect(mock.name).toBe('mock')
    expect(mock.capabilities.codeGeneration).toBe(true)
    const health = await mock.healthCheck()
    expect(health.healthy).toBe(true)
    const session = await mock.startSession({
      projectId: 'p1',
      phaseId: 'ph1',
      attempt: 1,
      workingDir: '/tmp',
      model: 'test',
      provider: 'test',
    })
    expect(session.id).toBe('s1')
    const run = await mock.executeTask(session, {
      id: 'c1',
      phaseId: 'ph1',
      attempt: 1,
      objective: 'test',
      allowedPaths: [],
      forbiddenPaths: [],
      allowedCapabilities: [],
      acceptanceCriteria: [],
      verificationPlan: [],
      timeoutSeconds: 300,
      maxAttempts: 3,
      risk: 'low',
      rollbackPolicy: 'none',
      expectedOutputs: [],
    })
    expect(run.id).toBe('r1')
    const resumed = await mock.resumeSession('s1')
    expect(resumed.status).toBe('active')
    await mock.stopSession('s1')
  })
})
