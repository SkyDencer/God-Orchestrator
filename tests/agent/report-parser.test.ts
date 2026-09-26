import { describe, it, expect } from 'vitest'
import { ReportParser, AgentReportSchema, type AgentReport } from '../../src/agent/report-parser.js'

describe('ReportParser', () => {
  const parser = new ReportParser()

  describe('native JSON', () => {
    it('parses valid JSON report', () => {
      const report: AgentReport = {
        status: 'completed',
        summary: 'All tests passed',
        filesChanged: [{ path: 'src/a.ts', action: 'modified' }],
        testsRun: [{ suite: 'unit', passed: 10, failed: 0 }],
        errors: [],
      }
      const result = parser.parse(JSON.stringify(report), '', 0)
      expect(result.status).toBe('completed')
      expect(result.summary).toBe('All tests passed')
      expect(result.filesChanged).toHaveLength(1)
    })
  })

  describe('delimiter extraction', () => {
    it('extracts report from delimiter block', () => {
      const report: AgentReport = {
        status: 'partial',
        summary: 'Partial completion',
        filesChanged: [],
        testsRun: [],
        errors: ['some warning'],
      }
      const output = `Some log output\n${report.filesChanged}\n<<<REPORT_START>>>\n${JSON.stringify(report)}\n<<<REPORT_END>>>\nMore logs`
      const result = parser.parse(output, '', 0)
      expect(result.status).toBe('partial')
      expect(result.summary).toBe('Partial completion')
    })

    it('falls back when delimiter content is invalid JSON', () => {
      const output = '<<<REPORT_START>>>\nnot json\n<<<REPORT_END>>>'
      const result = parser.parse(output, 'some error', 1)
      expect(result.status).toBe('failed')
      expect(result.summary.length).toBeGreaterThan(0)
    })
  })

  describe('markdown section extraction', () => {
    it('parses markdown AGENT REPORT section', () => {
      const output = `
        Some setup output
        ### AGENT REPORT
        status: completed
        summary: All good
        - src/main.ts (modified)
        <<<REPORT_END>>>
      `
      const result = parser.parse(output, '', 0)
      expect(result.status).toBe('completed')
      expect(result.summary).toContain('All good')
    })

    it('parses markdown with list items for errors', () => {
      const output = `
        ### AGENT REPORT
        status: failed
        summary: Build failed
        errors:
        - compilation error in main.ts
        - type mismatch in utils.ts
      `
      const result = parser.parse(output, '', 1)
      expect(result.status).toBe('failed')
      expect(result.errors).toHaveLength(2)
      expect(result.errors[0]).toContain('compilation error')
    })
  })

  describe('fallback', () => {
    it('constructs minimal report from non-JSON stdout and exit code 1', () => {
      const result = parser.parse('some random output', 'error msg here', 1)
      expect(result.status).toBe('failed')
      expect(result.summary.length).toBeGreaterThan(0)
      expect(result.filesChanged).toEqual([])
      expect(result.testsRun).toEqual([])
    })

    it('constructs completed report from exit code 0', () => {
      const result = parser.parse('', '', 0)
      expect(result.status).toBe('completed')
    })

    it('handles empty inputs', () => {
      const result = parser.parse('', '', null)
      expect(result.status).toBe('failed')
      expect(result.summary.length).toBeGreaterThan(0)
    })
  })

  describe('zod validation', () => {
    it('rejects invalid status', () => {
      const report = AgentReportSchema.safeParse({
        status: 'unknown',
        summary: 'x',
        filesChanged: [],
        testsRun: [],
        errors: [],
      })
      expect(report.success).toBe(false)
    })

    it('rejects missing summary', () => {
      const report = AgentReportSchema.safeParse({
        status: 'completed',
        summary: '',
        filesChanged: [],
        testsRun: [],
        errors: [],
      })
      expect(report.success).toBe(false)
    })

    it('rejects invalid action in filesChanged', () => {
      const report = AgentReportSchema.safeParse({
        status: 'completed',
        summary: 'ok',
        filesChanged: [{ path: 'x', action: 'renamed' as never }],
        testsRun: [],
        errors: [],
      })
      expect(report.success).toBe(false)
    })

    it('accepts optional fields omitted', () => {
      const report = AgentReportSchema.safeParse({
        status: 'completed',
        summary: 'ok',
        filesChanged: [],
        testsRun: [],
        errors: [],
      })
      expect(report.success).toBe(true)
      if (report.success) {
        expect(report.data.recommendation).toBeUndefined()
        expect(report.data.durationMs).toBeUndefined()
        expect(report.data.tokensUsed).toBeUndefined()
      }
    })
  })
})
