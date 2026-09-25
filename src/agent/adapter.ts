import type {
  AgentCapabilities,
  AgentSession,
  AgentRun,
  HealthStatus,
  SessionConfig,
} from './types.js'
import type { ExecutionContract } from './execution-contract.js'

export interface AgentAdapter {
  readonly name: string
  readonly capabilities: AgentCapabilities

  healthCheck(): Promise<HealthStatus>
  startSession(config: SessionConfig): Promise<AgentSession>
  executeTask(
    session: AgentSession,
    contract: ExecutionContract,
  ): Promise<AgentRun>
  resumeSession(sessionId: string): Promise<AgentSession>
  stopSession(sessionId: string): Promise<void>
}
