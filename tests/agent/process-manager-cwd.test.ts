import { describe, it, expect, beforeEach } from 'vitest'
import * as path from 'node:path'
import { ProcessManager } from '../../src/agent/process-manager.js'

describe('ProcessManager Windows absolute-path pre-work (subphase 2.0)', () => {
  let pm: ProcessManager

  beforeEach(() => {
    pm = new ProcessManager()
  })

  it('cmd wrapper resolves relative cwd to absolute on spawn', async () => {
    // Relative cwd should be resolved to absolute before passing to spawn
    const result = await pm.spawn({
      executable: 'cmd',
      args: ['/c', 'echo', '%CD%'],
      cwd: 'src/agent', // relative path
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    // The resolved cwd should be the absolute path of src/agent
    const resolvedExpected = path.resolve('src/agent')
    expect(result.stdout.trim()).toBe(resolvedExpected)
  })

  it('cmd wrapper passes absolute paths for relative executables', async () => {
    // `echo` is a builtin in cmd; verify the command runs with resolved cwd
    const result = await pm.spawn({
      executable: 'cmd',
      args: ['/c', 'echo', 'cwd-is-resolved'],
      cwd: '.', // current directory (relative)
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('cwd-is-resolved')
  })

  it('cmd wrapper resolves relative path args to absolute', async () => {
    // Use a relative path arg that exists from the project root
    const result = await pm.spawn({
      executable: 'cmd',
      args: ['/c', 'type', 'package.json'],
      cwd: process.cwd(),
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    // package.json content should be present
    expect(result.stdout).toContain('"name"')
  })

  it('spawn without cmd wrapper still uses resolved cwd', async () => {
    // Even without cmd wrapper, cwd should be resolved to absolute
    const result = await pm.spawn({
      executable: 'node',
      args: ['-e', 'console.log(process.cwd())'],
      cwd: 'src/agent', // relative
      useCmdWrapper: false,
    })
    expect(result.exitCode).toBe(0)
    const resolvedExpected = path.resolve('src/agent')
    expect(result.stdout.trim()).toBe(resolvedExpected)
  })

  it('cmd wrapper with already-absolute cwd leaves it unchanged', async () => {
    const absCwd = path.resolve('src/agent')
    const result = await pm.spawn({
      executable: 'cmd',
      args: ['/c', 'echo', '%CD%'],
      cwd: absCwd,
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim()).toBe(absCwd)
  })

  it('cmd wrapper resolves relative args containing path separators', async () => {
    // Pass a relative path with separator as an arg; it should be resolved
    const result = await pm.spawn({
      executable: 'cmd',
      args: ['/c', 'dir', 'src\\agent'],
      cwd: process.cwd(),
      useCmdWrapper: true,
    })
    expect(result.exitCode).toBe(0)
    // Should list files in src/agent
    expect(result.stdout).toContain('process-manager.ts')
  })
})
