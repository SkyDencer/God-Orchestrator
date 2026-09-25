import { describe, it, expect, beforeEach } from 'vitest'
import { ProcessManager } from '../../src/agent/process-manager.js'

describe('ProcessManager', () => {
  let pm: ProcessManager

  beforeEach(() => {
    pm = new ProcessManager()
  })

  it('simple command returns 0', async () => {
    const result = await pm.spawn({
      executable: process.platform === 'win32' ? 'cmd' : 'echo',
      args: process.platform === 'win32' ? ['/c', 'echo', 'hello'] : ['hello'],
      cwd: process.cwd(),
      useCmdWrapper: process.platform === 'win32',
    })
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
  })

  it('failing command returns non-zero', async () => {
    const result = await pm.spawn({
      executable: process.platform === 'win32' ? 'cmd' : 'sh',
      args: process.platform === 'win32'
        ? ['/c', 'exit', '1']
        : ['-c', 'exit 1'],
      cwd: process.cwd(),
      useCmdWrapper: process.platform === 'win32',
    })
    expect(result.exitCode).not.toBe(0)
  })

  it('timeout kills process', async () => {
    const result = await pm.spawn({
      executable: process.platform === 'win32' ? 'cmd' : 'sleep',
      args: process.platform === 'win32'
        ? ['/c', 'ping', '-n', '5', '127.0.0.1']
        : ['5'],
      cwd: process.cwd(),
      timeoutMs: 500,
      useCmdWrapper: process.platform === 'win32',
    })
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBeNull()
  })

  it('captures stdout', async () => {
    const result = await pm.spawn({
      executable: process.platform === 'win32' ? 'cmd' : 'echo',
      args: process.platform === 'win32' ? ['/c', 'echo', 'test-output'] : ['test-output'],
      cwd: process.cwd(),
      useCmdWrapper: process.platform === 'win32',
    })
    expect(result.stdout).toContain('test-output')
  })

  it('captures stderr', async () => {
    // On Windows, use cmd to redirect stderr; on POSIX use sh
    const isWin = process.platform === 'win32'
    const result = await pm.spawn({
      executable: isWin ? 'cmd' : 'sh',
      args: isWin
        ? ['/c', 'cmd', '/c', 'echo', 'err-msg', '1>&2']
        : ['-c', 'echo err-msg >&2'],
      cwd: process.cwd(),
      useCmdWrapper: isWin,
    })
    // stderr may be mixed with stdout on Windows; check either
    expect(result.stdout + result.stderr).toContain('err-msg')
  })

  it('concurrent spawns work', async () => {
    const results = await Promise.all([
      pm.spawn({
        executable: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'a'] : ['a'],
        cwd: process.cwd(),
        useCmdWrapper: process.platform === 'win32',
      }),
      pm.spawn({
        executable: process.platform === 'win32' ? 'cmd' : 'echo',
        args: process.platform === 'win32' ? ['/c', 'echo', 'b'] : ['b'],
        cwd: process.cwd(),
        useCmdWrapper: process.platform === 'win32',
      }),
    ])
    expect(results).toHaveLength(2)
    expect(results[0].exitCode).toBe(0)
    expect(results[1].exitCode).toBe(0)
  })

  it('onStdout callback receives data', async () => {
    const chunks: string[] = []
    const result = await pm.spawn({
      executable: process.platform === 'win32' ? 'cmd' : 'echo',
      args: process.platform === 'win32' ? ['/c', 'echo', 'callback-test'] : ['callback-test'],
      cwd: process.cwd(),
      onStdout: (chunk) => chunks.push(chunk),
      useCmdWrapper: process.platform === 'win32',
    })
    expect(chunks.length).toBeGreaterThan(0)
    expect(result.stdout).toContain('callback-test')
  })

  it('listRunning reports zero after completion', async () => {
    await pm.spawn({
      executable: process.platform === 'win32' ? 'cmd' : 'echo',
      args: process.platform === 'win32' ? ['/c', 'echo', 'done'] : ['done'],
      cwd: process.cwd(),
      useCmdWrapper: process.platform === 'win32',
    })
    expect(pm.countRunning()).toBe(0)
    expect(pm.listRunning()).toHaveLength(0)
  })
})
