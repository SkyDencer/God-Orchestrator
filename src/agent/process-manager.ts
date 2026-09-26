import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'

export interface SpawnOptions {
  executable: string
  args: string[]
  cwd: string
  env?: NodeJS.ProcessEnv
  timeoutMs?: number
  onStdout?: (chunk: string) => void
  onStderr?: (chunk: string) => void
  useCmdWrapper?: boolean
}

export interface ProcessResult {
  exitCode: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  durationMs: number
  timedOut: boolean
}

let nextId = 0
function generateId(): string {
  return `proc-${++nextId}-${randomUUID()}`
}

export class ProcessManager {
  private readonly processes = new Map<string, ChildProcess>()

  async spawn(options: SpawnOptions): Promise<ProcessResult> {
    const id = generateId()
    const start = Date.now()
    let timedOut = false

    const isWindows = process.platform === 'win32'
    const wrapper = options.useCmdWrapper ?? isWindows
    const command = wrapper ? 'cmd' : options.executable
    const args = wrapper
      ? ['/c', options.executable, ...options.args]
      : options.args

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    this.processes.set(id, child)

    let stdout = ''
    let stderr = ''

    child.stdout?.on('data', (chunk: Buffer) => {
      const str = chunk.toString()
      stdout += str
      options.onStdout?.(str)
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      const str = chunk.toString()
      stderr += str
      options.onStderr?.(str)
    })

    return new Promise<ProcessResult>((resolve) => {
      const cleanup = () => {
        this.processes.delete(id)
      }

      child.on('close', (exitCode, signal) => {
        cleanup()
        resolve({
          exitCode,
          signal,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
        })
      })

      child.on('error', () => {
        cleanup()
        resolve({
          exitCode: null,
          signal: null,
          stdout,
          stderr,
          durationMs: Date.now() - start,
          timedOut,
        })
      })

      if (options.timeoutMs) {
        setTimeout(() => {
          timedOut = true
          this.kill(id)
        }, options.timeoutMs)
      }
    })
  }

  async kill(processId: string): Promise<void> {
    const child = this.processes.get(processId)
    if (!child) return

    if (process.platform === 'win32' && child.pid) {
      // Windows: kill the entire process tree
      try {
        spawn('taskkill', ['/F', '/T', '/PID', child.pid.toString()], {
          stdio: 'ignore',
        })
      } catch {
        // taskkill may fail if process already exited
      }
    }

    try {
      child.kill()
    } catch {
      // Process may have already exited
    }

    this.processes.delete(processId)
  }

  listRunning(): string[] {
    return Array.from(this.processes.keys())
  }

  countRunning(): number {
    return this.processes.size
  }
}
