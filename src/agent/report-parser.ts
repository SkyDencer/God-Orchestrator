import { z } from 'zod'
import * as fs from 'node:fs'
import { execSync } from 'node:child_process'

export const AgentReportSchema = z.object({
  status: z.enum(['completed', 'failed', 'partial', 'blocked']),
  summary: z.string().min(1),
  filesChanged: z.array(
    z.object({
      path: z.string(),
      action: z.enum(['created', 'modified', 'deleted']),
    }),
  ),
  testsRun: z.array(
    z.object({
      suite: z.string(),
      passed: z.number(),
      failed: z.number(),
    }),
  ),
  errors: z.array(z.string()),
  recommendation: z.string().optional(),
  durationMs: z.number().optional(),
  tokensUsed: z
    .object({
      input: z.number(),
      output: z.number(),
    })
    .optional(),
})

export type AgentReport = z.infer<typeof AgentReportSchema>

const DELIMITER_START = '<<<REPORT_START>>>'
const DELIMITER_END = '<<<REPORT_END>>>'

export class ReportParser {
  /**
   * Parse agent stdout/stderr into an AgentReport.
   *
   * Strategies attempted in order:
   * 1. Native JSON — if the entire stdout is valid JSON, parse it directly.
   * 2. Delimiter extraction — look for <<<REPORT_START>>>...<<<REPORT_END>>> block.
   * 3. Markdown section extraction — look for a ### AGENT REPORT section.
   * 4. Filesystem fallback — read cached report from the agent's output directory.
   * 5. Fallback — construct minimal report from exit code + stderr.
   */
  parse(
    stdout: string,
    stderr: string,
    exitCode: number | null,
    workingDir?: string,
  ): AgentReport {
    // Strategy 1: Native JSON
    try {
      const parsed = JSON.parse(stdout)
      const report = AgentReportSchema.safeParse(parsed)
      if (report.success) return report.data
    } catch {
      // Not valid JSON — proceed to next strategy
    }

    // Strategy 2: Delimiter extraction
    const delimiterMatch = stdout.match(
      new RegExp(`${DELIMITER_START}([\\s\\S]*?)${DELIMITER_END}`),
    )
    if (delimiterMatch?.[1]) {
      try {
        const parsed = JSON.parse(delimiterMatch[1].trim())
        const report = AgentReportSchema.safeParse(parsed)
        if (report.success) return report.data
      } catch {
        // Malformed delimited JSON — proceed
      }
    }

    // Strategy 3: Markdown section extraction
    // Allow optional leading whitespace before the header
    const mdMatch = stdout.match(
      /(?:^|\n)\s*###\s*AGENT\s*REPORT\s*\n([\s\S]*?)(?=\n\s*###|$)/i,
    )
    if (mdMatch?.[1]) {
      try {
        // Try to parse as JSON first
        const parsed = JSON.parse(mdMatch[1].trim())
        const report = AgentReportSchema.safeParse(parsed)
        if (report.success) return report.data
      } catch {
        // Not JSON — parse as key-value markdown
        const parsed = this.parseMarkdownSection(mdMatch[1])
        const report = AgentReportSchema.safeParse(parsed)
        if (report.success) return report.data
      }
    }

    // Strategy 4: Filesystem fallback — read cached report from disk
    // The agent may write a report file to its output directory even when stdout
    // does not contain structured data. Look for common report names.
    const fsReport = this.tryFilesystemFallback()
    if (fsReport) return fsReport

    // Strategy 5: Fallback — construct minimal report from exit code + stderr
    return this.fallbackReport(stdout, stderr, exitCode, workingDir)
  }

  /**
   * Attempt to read a previously saved agent report from the filesystem.
   * Checks common paths: the current working directory and well-known report locations.
   */
  private tryFilesystemFallback(): AgentReport | undefined {
    const candidates = [
      'agent-report.json',
      'report.json',
      '.god-orchestrator/report.json',
      'output/report.json',
    ]
    for (const name of candidates) {
      try {
        const content = fs.readFileSync(name, 'utf8')
        const parsed = JSON.parse(content)
        const report = AgentReportSchema.safeParse(parsed)
        if (report.success) return report.data
      } catch {
        // File not found or invalid JSON — try next candidate
        continue
      }
    }
    return undefined
  }

  /**
   * Parse a markdown-like key-value section into a partial report object.
   */
  private parseMarkdownSection(text: string): Partial<AgentReport> {
    const lines = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l): l is string => l.length > 0)
    const result: Partial<AgentReport> = {}

    let currentKey: string | null = null

    for (const line of lines) {
      const trimmed = line.trim()
      // Check for key: value pattern (key can have optional value after colon)
      const kvMatch = trimmed.match(/^([^:]+):\s*(.*)$/)
      if (kvMatch) {
        const key = kvMatch[1]
        const value = kvMatch[2]
        if (!key) continue
        const lowerKey = key.toLowerCase()
        const valueStr = value?.trim() ?? ''

        // If this line has only a key and no value, prepare for list items
        if (valueStr === '') {
          currentKey = lowerKey
          continue
        }

        if (lowerKey === 'status') {
          result.status = this.toStatus(valueStr)
        } else if (lowerKey === 'summary') {
          result.summary = valueStr
        } else if (lowerKey === 'recommendation') {
          result.recommendation = valueStr
        } else if (lowerKey === 'durationms' || lowerKey === 'duration_ms') {
          const num = parseInt(valueStr, 10)
          if (!isNaN(num)) result.durationMs = num
        } else if (lowerKey === 'tokensused') {
          try {
            result.tokensUsed = JSON.parse(valueStr)
          } catch {
            // Ignore malformed tokens
          }
        }
        currentKey = lowerKey
        continue
      }

      // List items under current key
      if (trimmed.startsWith('- ') && currentKey) {
        const item = trimmed.slice(2)
        if (currentKey === 'fileschanged') {
          if (!result.filesChanged) result.filesChanged = []
          const m = item.match(/^(\S+)\s+\((created|modified|deleted)\)$/)
          if (m) {
            result.filesChanged.push({
              path: m[1]!,
              action: m[2] as 'created' | 'modified' | 'deleted',
            })
          } else {
            result.filesChanged.push({ path: item, action: 'modified' })
          }
        } else if (currentKey === 'errors') {
          if (!result.errors) result.errors = []
          result.errors.push(item)
        }
      }
    }

    // Ensure required fields
    if (!result.status) result.status = 'failed'
    if (!result.summary)
      result.summary = `Task completed with exit code ${typeof result.durationMs !== 'undefined' ? 'unknown' : 'non-zero'}. Review stderr for details.`
    if (!result.filesChanged) result.filesChanged = []
    if (!result.testsRun) result.testsRun = []

    return result
  }

  /**
   * Fallback report when no structured output is found.
   * When workingDir is provided, attempts to read git status to populate filesChanged.
   */
  private fallbackReport(
    stdout: string,
    stderr: string,
    exitCode: number | null,
    workingDir?: string,
  ): AgentReport {
    const status = exitCodeToStatus(exitCode)
    const summaryParts = [
      status === 'completed'
        ? 'Task completed successfully.'
        : `Task failed with exit code ${exitCode ?? 'unknown'}.`,
    ]
    if (stderr) {
      summaryParts.push(`stderr: ${stderr.slice(0, 200)}`)
    }
    if (stdout && !stdout.trim().startsWith('{')) {
      summaryParts.push(`Output preview: ${stdout.slice(0, 200).trim()}`)
    }

    return {
      status,
      summary: summaryParts.join('\n'),
      filesChanged: workingDir
        ? this.readFilesChangedFromGit(workingDir)
        : [],
      testsRun: [],
      errors: stderr ? [stderr.slice(0, 500)] : [],
      durationMs: undefined,
      tokensUsed: undefined,
    }
  }

  /**
   * Run `git status --porcelain` in workingDir and parse the output
   * into a list of file changes. Returns an empty array on any error.
   */
  private readFilesChangedFromGit(workingDir: string): AgentReport['filesChanged'] {
    try {
      const isWindows = process.platform === 'win32'
      const command = isWindows
        ? `cmd /c git status --porcelain`
        : 'git status --porcelain'
      const stdout = execSync(command, {
        cwd: workingDir,
        encoding: 'utf8',
        maxBuffer: 10 * 1024 * 1024,
      })
      const filesChanged: AgentReport['filesChanged'] = []
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        const match = trimmed.match(/^.{2} (.+)$/)
        if (!match) continue
        let path = match![1]!.trim()
        // Handle rename notation: "old -> new"
        const renameIdx = path.indexOf(' -> ')
        if (renameIdx !== -1) {
          path = path.slice(renameIdx + 4)
        }
        const staged = trimmed[0]!
        const working = trimmed[1]!
        const effective = working !== ' ' ? working : staged
        let action: 'created' | 'modified' | 'deleted'
        if (effective === 'A' || effective === '?') {
          action = 'created'
        } else if (effective === 'D') {
          action = 'deleted'
        } else {
          action = 'modified'
        }
        filesChanged.push({ path, action })
      }
      return filesChanged
    } catch {
      return []
    }
  }

  private toStatus(value: string): AgentReport['status'] {
    const lower = value.toLowerCase()
    if (lower.includes('completed') || lower.includes('success')) return 'completed'
    if (lower.includes('failed') || lower.includes('failure')) return 'failed'
    if (lower.includes('partial')) return 'partial'
    if (lower.includes('blocked')) return 'blocked'
    return 'failed'
  }
}

function exitCodeToStatus(exitCode: number | null): AgentReport['status'] {
  if (exitCode === 0) return 'completed'
  if (exitCode === null) return 'failed'
  // Exit code 124 is conventional for timeout but maps to 'failed' in our schema
  return 'failed'
}
