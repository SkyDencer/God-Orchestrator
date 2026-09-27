import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { ReportParser } from '../../src/agent/report-parser.js'

describe('ReportParser filesystem fallback', () => {
  const parser = new ReportParser()

  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'report-parser-test-'))
  })

  afterEach(() => {
    // Clean up temp dir
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    } catch {
      // Best-effort cleanup
    }
  })

  function gitStatus(): string {
    const isWin = process.platform === 'win32'
    const result = spawnSync(
      isWin ? 'cmd' : 'git',
      isWin ? ['/c', 'git', 'status', '--porcelain'] : ['status', '--porcelain'],
      { cwd: tmpDir, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 },
    )
    return result.stdout
  }

  function gitInit(): void {
    const isWin = process.platform === 'win32'
    const result = spawnSync(
      isWin ? 'cmd' : 'git',
      isWin ? ['/c', 'git', 'init'] : ['init'],
      { cwd: tmpDir, encoding: 'utf8' },
    )
    if (result.status !== 0) {
      throw new Error(`git init failed: ${result.stderr}`)
    }
  }

  it('returns populated filesChanged when workingDir has git changes and stdout is non-JSON', () => {
    gitInit()

    // Create and commit an initial file so the repo is healthy
    const committedFile = path.join(tmpDir, 'src', 'committed.ts')
    fs.mkdirSync(path.dirname(committedFile), { recursive: true })
    fs.writeFileSync(committedFile, 'committed content\n')
    spawnSync(
      process.platform === 'win32' ? 'cmd' : 'git',
      process.platform === 'win32' ? ['/c', 'git', 'add', '.'] : ['add', '.'],
      { cwd: tmpDir, encoding: 'utf8' },
    )
    spawnSync(
      process.platform === 'win32' ? 'cmd' : 'git',
      process.platform === 'win32' ? ['/c', 'git', 'commit', '-m', 'initial'] : ['commit', '-m', 'initial'],
      { cwd: tmpDir, encoding: 'utf8' },
    )

    // Create a new untracked file (will appear as "??" in porcelain)
    const newFile = path.join(tmpDir, 'src', 'hello.ts')
    fs.writeFileSync(newFile, 'export const hello = "world";\n')

    // Modify the committed file (will appear as " M" in porcelain)
    fs.writeFileSync(committedFile, 'committed content modified\n')

    // Verify git status shows what we expect
    const status = gitStatus()
    const lines = status
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean)
    expect(lines.length).toBeGreaterThan(0)

    // Parse with non-JSON stdout and the workingDir
    const result = parser.parse(
      'some agent output that is not json at all',
      '',
      0,
      tmpDir,
    )

    expect(result.status).toBe('completed')
    expect(result.filesChanged).toHaveLength(lines.length)

    // All entries should have valid paths and actions
    for (const entry of result.filesChanged) {
      expect(entry.path).toBeTruthy()
      expect(['created', 'modified', 'deleted']).toContain(entry.action)
    }

    // The newly created file should be in the list (use forward slash to match git output)
    const newFilePath = 'src/hello.ts'
    const newFileEntry = result.filesChanged.find((e) => e.path === newFilePath)
    expect(newFileEntry).toBeDefined()
    expect(newFileEntry!.action).toBe('created')

    // The modified committed file should be in the list
    const committedFilePath = 'src/committed.ts'
    const committedEntry = result.filesChanged.find((e) => e.path === committedFilePath)
    expect(committedEntry).toBeDefined()
    expect(committedEntry!.action).toBe('modified')
  })

  it('returns empty filesChanged when workingDir is not a git repo', () => {
    // Don't git init — just leave a plain directory with a file
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true })
    fs.writeFileSync(path.join(tmpDir, 'src', 'a.ts'), 'hello')

    const result = parser.parse('non-json output', 'some error', 1, tmpDir)

    expect(result.filesChanged).toEqual([])
    expect(result.status).toBe('failed')
  })

  it('returns empty filesChanged when workingDir is undefined', () => {
    const result = parser.parse('non-json output', 'some error', 1)

    expect(result.filesChanged).toEqual([])
  })

  it('still extracts from JSON even when workingDir is provided', () => {
    gitInit()

    const report = {
      status: 'completed' as const,
      summary: 'from-json',
      filesChanged: [{ path: 'explicit.ts', action: 'created' as const }],
      testsRun: [],
      errors: [],
    }

    const result = parser.parse(JSON.stringify(report), '', 0, tmpDir)
    expect(result.filesChanged).toEqual([{ path: 'explicit.ts', action: 'created' }])
    expect(result.summary).toBe('from-json')
  })
})
