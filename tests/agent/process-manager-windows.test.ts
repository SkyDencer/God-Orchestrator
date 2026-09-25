import { describe, it, expect, beforeEach } from 'vitest'
import { ProcessManager } from '../../src/agent/process-manager.js'

describe('ProcessManager Windows cmd wrapper', () => {
  let pm: ProcessManager

  beforeEach(() => {
    pm = new ProcessManager()
  })

  it('cmd /c wrapper works for simple commands', async () => {
    const result = await pm.spawn({
      executable: 'echo',
      args: ['hello-world'],
      cwd: process.cwd(),
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello-world')
  })

  it('cmd /c wrapper works for taskkill tree (graceful)', async () => {
    // Start a long-running process via cmd /c and verify timeout kills it
    const result = await pm.spawn({
      executable: 'ping',
      args: ['-n', '10', '127.0.0.1'],
      cwd: process.cwd(),
      useCmdWrapper: true,
      timeoutMs: 300,
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  }, 10000)

  it('spawn via cmd /c with chained commands', async () => {
    const result = await pm.spawn({
      executable: 'cmd',
      args: ['/c', 'echo', 'first', '&&', 'echo', 'second'],
      cwd: process.cwd(),
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('first')
    expect(result.stdout).toContain('second')
  })
})
