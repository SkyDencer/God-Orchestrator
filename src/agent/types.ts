export interface AgentCapabilities {
  codeGeneration: boolean
  multiFileEdit: boolean
  shellAccess: boolean
  gitIntegration: boolean
  testExecution: boolean
  subagents: boolean
  skills: boolean
  mcp: boolean
  streaming: boolean
  sessionResume: boolean
}

export interface SessionConfig {
  projectId: string
  phaseId: string
  attempt: number
  workingDir: string
  model: string
  provider: string
}

export interface AgentSession {
  id: string
  projectId: string
  phaseId: string
  attempt: number
  status: 'starting' | 'active' | 'ended' | 'crashed' | 'timeout' | 'stopped'
  processId?: string
  startedAt: number
  endedAt?: number
  metadata: Record<string, unknown>
}

export interface AgentRun {
  id: string
  sessionId: string
  phaseId: string
  contractId: string
  attempt: number
  startedAt: number
  endedAt?: number
  status: 'running' | 'completed' | 'failed' | 'timeout' | 'crashed' | 'cancelled'
  exitCode?: number
}

export interface HealthStatus {
  healthy: boolean
  version?: string
  details?: Record<string, unknown>
}
