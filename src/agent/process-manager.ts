import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import * as path from 'node:path'

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

/** Resolve a single arg to an absolute path if it looks like a relative file path. */
function resolveArg(arg: string): string {
  // Skip flags, URLs, and already-absolute paths
  if (arg.startsWith('-') || arg.startsWith('http://') || arg.startsWith('https://')) {
    return arg
  }
  if (path.isAbsolute(arg)) {
    return arg
  }
  // Resolve relative paths (starts with . or contains path separators)
  if (arg.startsWith('.') || arg.includes('/') || arg.includes('\\')) {
    return path.resolve(arg)
  }
  return arg
}

export class ProcessManager {
  private readonly processes = new Map<string, ChildProcess>()

  async spawn(options: SpawnOptions): Promise<ProcessResult> {
    const id = generateId()
    const start = Date.now()
    let timedOut = false

    const isWindows = process.platform === 'win32'
    const wrapper = options.useCmdWrapper ?? isWindows

    // On Windows with cmd wrapper, resolve all path-like arguments to absolute paths
    // to work around the opencode CLI ignoring spawn cwd (Phase 0.9 finding B3).
    const resolvedCwd = path.resolve(options.cwd)
    const resolvedExecutable = (wrapper && !path.isAbsolute(options.executable)
      && (options.executable.startsWith('.') || options.executable.includes('/') || options.executable.includes('\\')))
      ? path.resolve(resolvedCwd, options.executable)
      : options.executable
    const resolvedArgs = wrapper
      ? options.args.map(resolveArg)
      : options.args

    const command = wrapper ? 'cmd' : resolvedExecutable
    const args = wrapper
      ? ['/c', resolvedExecutable, ...resolvedArgs]
      : resolvedArgs

    const child = spawn(command, args, {
      cwd: resolvedCwd,
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
