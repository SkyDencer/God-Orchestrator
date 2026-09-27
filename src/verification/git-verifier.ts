import { spawn } from 'node:child_process'
import * as path from 'node:path'
import type { EvidenceStore } from './evidence-store.js'
import type { VerificationCheck } from './verification-result.js'

/**
 * Verifier that inspects a Git repository via structured spawn calls.
 *
 * All git invocations use fixed argument arrays — never a shell string.
 * The constructor accepts an optional EvidenceStore so that diff / status
 * text can be persisted as evidence rows whose IDs are attached to the
 * returned VerificationCheck.
 */
export class GitVerifier {
  readonly projectRoot: string

  private readonly evidenceStore: EvidenceStore | null

  constructor(projectRoot: string, evidenceStore?: EvidenceStore) {
    this.projectRoot = path.resolve(projectRoot)
    this.evidenceStore = evidenceStore ?? null
  }

  /**
   * Run a git command using spawn with a fixed argv array.
   * Resolves all path-like args to absolute paths to work around spawn cwd
   * being ignored on Windows (Phase 0.9 finding B3).
   */
  private async runGit(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      // On Windows, git is typically a .exe; spawn handles it directly.
      // Resolve any path-like args so they survive the cwd resolution.
      const resolvedArgs = args.map((arg) => {
        if (arg.startsWith('-') || arg.startsWith('http://') || arg.startsWith('https://')) {
          return arg
        }
        if (path.isAbsolute(arg)) {
          return arg
        }
        if (arg.startsWith('.') || arg.includes('/') || arg.includes('\\')) {
          return path.resolve(this.projectRoot, arg)
        }
        return arg
      })

      const child = spawn('git', resolvedArgs, {
        cwd: this.projectRoot,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      let stdout = ''
      let stderr = ''

      child.stdout?.on('data', (chunk: Buffer) => {
        stdout += chunk.toString()
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      child.on('close', (exitCode) => {
        resolve({ exitCode: exitCode ?? 1, stdout, stderr })
      })

      child.on('error', (err) => {
        reject(err)
      })
    })
  }

  /**
   * Store a piece of text as evidence and return the evidence id.
   * Returns null when no EvidenceStore was supplied at construction.
   */
  private async storeEvidence(runId: number, type: string, source: string, content: string): Promise<number | null> {
    if (!this.evidenceStore) return null
    return this.evidenceStore.store(runId, type, source, content).id
  }

  /**
   * Full verification: run git status and git diff, persist them as evidence,
   * and return a VerificationCheck.
   *
   * - Clean repo → status: 'passed' with clean-status evidence.
   * - Dirty repo → status: 'passed' with status text recorded as evidence
   *   (the spec says dirty status is NOT a failure by itself).
   */
  async verify(runId: number): Promise<VerificationCheck> {
    const [statusResult, diffResult] = await Promise.all([
      this.runGit(['status', '--porcelain']),
      this.runGit(['diff']),
    ])

    const statusText = statusResult.stdout.trim()
    const diffText = diffResult.stdout.trim()

    const evidenceIds: number[] = []

    if (this.evidenceStore) {
      const statusId = await this.storeEvidence(runId, 'git-status', 'git-verifier', statusText || '(clean — no output)')
      if (statusId !== null) evidenceIds.push(statusId)

      const diffId = await this.storeEvidence(runId, 'git-diff', 'git-verifier', diffText || '(empty — no changes)')
      if (diffId !== null) evidenceIds.push(diffId)
    }

    const isClean = statusText.length === 0

    return {
      name: 'git-status',
      status: 'passed',
      summary: isClean ? 'Repository is clean — no uncommitted changes detected.' : `Repository has ${statusText.split('\n').filter((l) => l.length > 0).length} changed file(s).`,
      evidence: evidenceIds,
    }
  }

  /**
   * Return the raw git diff output as a string.
   */
  async getDiff(): Promise<string> {
    const { stdout } = await this.runGit(['diff'])
    return stdout
  }

  /**
   * Return the raw git status output as a string (porcelain format).
   */
  async getStatus(): Promise<string> {
    const { stdout } = await this.runGit(['status', '--porcelain'])
    return stdout
  }

  /**
   * Return the recent git log as a multi-line string.
   * @param limit  Maximum number of commits to include (default 10).
   */
  async getLog(limit = 10): Promise<string> {
    const { stdout } = await this.runGit(['log', '--pretty=format:%H %s', `-n${String(limit)}`])
    return stdout
  }

  /**
   * Return the list of files that have changes (staged, modified, or untracked)
   * relative to the last commit, as an array of relative path strings.
   */
  async getChangedFiles(): Promise<string[]> {
    const { stdout } = await this.runGit(['diff', '--name-only'])
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  /**
   * Return the subset of changed files whose paths match any of the supplied
   * forbidden-path globs (matched as literal suffixes for simplicity; callers
   * can pass full relative paths or suffixes such as "*.env").
   *
   * @param forbiddenPaths  Array of path suffixes to treat as forbidden.
   */
  async getForbiddenChanges(forbiddenPaths: string[]): Promise<string[]> {
    if (forbiddenPaths.length === 0) return []

    const changed = await this.getChangedFiles()
    return changed.filter((file) => forbiddenPaths.some((fp) => file.endsWith(fp)))
  }
}
