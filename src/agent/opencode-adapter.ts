import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import * as fs from 'node:fs/promises'
import type {
  AgentSession,
  AgentRun,
  HealthStatus,
  SessionConfig,
} from './types.js'
import type { AgentAdapter } from './adapter.js'
import type { ExecutionContract } from './execution-contract.js'
import { buildOpenCodePrompt } from './opencode-prompt-builder.js'

export interface OpenCodeAdapterConfig {
  executable: string
  model: string
  useCmdWrapper: boolean
}

export class OpenCodeAdapter implements AgentAdapter {
  readonly name = 'opencode'

  readonly capabilities = {
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

  private readonly executable: string
  private readonly model: string
  private readonly useCmdWrapper: boolean
  private readonly sessions = new Map<string, AgentSession>()
  private readonly runs = new Map<string, AgentRun>()
  private readonly processes = new Map<string, ReturnType<typeof spawn>>()

  constructor(config: OpenCodeAdapterConfig) {
    this.executable = config.executable
    this.model = config.model
    this.useCmdWrapper = config.useCmdWrapper
  }

  async healthCheck(): Promise<HealthStatus> {
    try {
      const version = await this.runVersionCheck()
      return { healthy: true, version, details: { executable: this.executable } }
    } catch (err) {
      return {
        healthy: false,
        details: { error: err instanceof Error ? err.message : String(err) },
      }
    }
  }

  async startSession(config: SessionConfig): Promise<AgentSession> {
    const id = randomUUID()
    const session: AgentSession = {
      id,
      projectId: config.projectId,
      phaseId: config.phaseId,
      attempt: config.attempt,
      status: 'starting',
      startedAt: Date.now(),
      metadata: {
        model: config.model,
        provider: config.provider,
        workingDir: config.workingDir,
      },
    }
    this.sessions.set(id, session)
    // Transition to active after a brief delay to simulate startup
    setTimeout(() => {
      const s = this.sessions.get(id)
      if (s && s.status === 'starting') {
        s.status = 'active'
        this.sessions.set(id, s)
      }
    }, 100)
    return session
  }

  async executeTask(
    session: AgentSession,
    contract: ExecutionContract,
  ): Promise<AgentRun> {
    const runId = randomUUID()
    const prompt = buildOpenCodePrompt(contract)
    const run: AgentRun = {
      id: runId,
      sessionId: session.id,
      phaseId: contract.phaseId,
      contractId: contract.id,
      attempt: contract.attempt,
      startedAt: Date.now(),
      status: 'running',
    }
    this.runs.set(runId, run)

    const cwd = (session.metadata.workingDir as string) ?? process.cwd()
    const args = ['run', '--auto', '--model', this.model, prompt]

    const command = this.useCmdWrapper ? 'cmd' : this.executable
    const spawnArgs = this.useCmdWrapper
      ? ['/c', this.executable, ...args]
      : args

    const child = spawn(command, spawnArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.processes.set(runId, child)

    let _stdout = ''
    let _stderr = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      _stdout += chunk.toString()
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      _stderr += chunk.toString()
    })

    const timeoutMs = (contract.timeoutSeconds ?? 300) * 1000
    const timeoutTimer = setTimeout(() => {
      this.killProcess(runId)
      const r = this.runs.get(runId)
      if (r) {
        r.status = 'timeout'
        r.endedAt = Date.now()
        this.runs.set(runId, r)
      }
      const s = this.sessions.get(session.id)
      if (s) {
        s.status = 'timeout'
        s.endedAt = Date.now()
        this.sessions.set(session.id, s)
      }
    }, timeoutMs)

    child.on('close', (exitCode) => {
      clearTimeout(timeoutTimer)
      this.processes.delete(runId)
      const r = this.runs.get(runId)
      if (r) {
        r.exitCode = exitCode ?? undefined
        r.endedAt = Date.now()
        if (exitCode === 0) {
          r.status = 'completed'
        } else {
          r.status = 'failed'
        }
        this.runs.set(runId, r)
      }
      const s = this.sessions.get(session.id)
      if (s && s.status !== 'timeout') {
        s.status = 'ended'
        s.endedAt = Date.now()
        this.sessions.set(session.id, s)
      }
    })

    child.on('error', () => {
      clearTimeout(timeoutTimer)
      this.processes.delete(runId)
      const r = this.runs.get(runId)
      if (r && r.status === 'running') {
        r.status = 'crashed'
        r.endedAt = Date.now()
        this.runs.set(runId, r)
      }
      const s = this.sessions.get(session.id)
      if (s && s.status !== 'timeout') {
        s.status = 'crashed'
        s.endedAt = Date.now()
        this.sessions.set(session.id, s)
      }
    })

    return run
  }

  async resumeSession(sessionId: string): Promise<AgentSession> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new Error(`Session ${sessionId} not found`)
    }
    // Gateway reconstruction: verify working dir still exists and read file state
    const workingDir = (session.metadata.workingDir as string) ?? process.cwd()
    try {
      await fs.access(workingDir)
    } catch {
      session.status = 'crashed'
      session.endedAt = Date.now()
      this.sessions.set(sessionId, session)
      throw new Error(`Working directory ${workingDir} no longer exists`)
    }
    session.status = 'active'
    this.sessions.set(sessionId, session)
    return session
  }

  async stopSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    // Kill any running processes for this session
    for (const [runId] of this.processes) {
      if (this.runs.get(runId)?.sessionId === sessionId) {
        this.killProcess(runId)
      }
    }
    session.status = 'stopped'
    session.endedAt = Date.now()
    this.sessions.set(sessionId, session)
  }

  getSession(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId)
  }

  getRun(runId: string): AgentRun | undefined {
    return this.runs.get(runId)
  }

  private async runVersionCheck(): Promise<string> {
    return new Promise((resolve, reject) => {
      // On Windows, opencode is a .cmd file and must be invoked via cmd /c
      const isWindows = process.platform === 'win32'
      const command = isWindows ? 'cmd' : this.executable
      const args = isWindows
        ? ['/c', this.executable, '--version']
        : ['--version']
      const child = spawn(command, args)
      let stdout = ''
      let stderr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })
      child.on('close', (code) => {
        if (code === 0) {
          resolve(stdout.trim())
        } else {
          reject(new Error(`Version check failed with code ${code}: ${stderr}`))
        }
      })
      child.on('error', (err) => {
        reject(new Error(`Version check spawn failed: ${err.message}`))
      })
    })
  }

  private killProcess(runId: string): void {
    const child = this.processes.get(runId)
    if (!child) return
    try {
      if (process.platform === 'win32') {
        // Windows: use taskkill to kill process tree
        spawn('taskkill', ['/F', '/T', '/PID', child.pid!.toString()])
      } else {
        child.kill()
      }
    } catch {
      // Process may have already exited
    }
    this.processes.delete(runId)
  }
}
