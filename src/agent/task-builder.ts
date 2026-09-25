import type { ExecutionContract } from './execution-contract.js'

export interface TaskContext {
  projectSummary: string
  previousPhases: string[]
  architecture?: string
  constraints?: string[]
  relevantMemory?: Record<string, string>
}

export interface BuiltTask {
  prompt: string
  metadata: {
    contractId: string
    phaseId: string
    attempt: number
    estimatedTokens: number
  }
}

const AVG_CHARS_PER_TOKEN = 4

function estimateTokens(text: string): number {
  return Math.ceil(text.length / AVG_CHARS_PER_TOKEN)
}

/**
 * Assembles a task prompt from an ExecutionContract and TaskContext.
 *
 * Rules:
 * - Includes objective, allowed/forbidden paths, acceptance criteria, constraints, expected outputs
 * - Does NOT include secrets or out-of-scope files
 * - Respects contextBudget (estimated token limit) by truncating sections if needed
 */
export class TaskBuilder {
  private readonly contextBudget: number

  constructor(contextBudget: number) {
    this.contextBudget = contextBudget
  }

  build(contract: ExecutionContract, context: TaskContext): BuiltTask {
    const lines: string[] = []
    let totalTokens = 0

    // Section: Objective (always included)
    lines.push('### OBJECTIVE')
    lines.push('')
    lines.push(contract.objective)
    lines.push('')
    totalTokens += estimateTokens(contract.objective)

    // Section: Context Budget
    const availableBudget = this.contextBudget - totalTokens
    if (availableBudget <= 0) {
      // Fallback: objective only
      const fallbackPrompt = `### OBJECTIVE\n\n${contract.objective}\n\nReport changes concisely.`
      return {
        prompt: fallbackPrompt,
        metadata: {
          contractId: contract.id,
          phaseId: contract.phaseId,
          attempt: contract.attempt,
          estimatedTokens: estimateTokens(fallbackPrompt),
        },
      }
    }

    // Section: Project Summary (budget permitting)
    if (context.projectSummary && estimateTokens(context.projectSummary) < availableBudget) {
      lines.push('### PROJECT SUMMARY')
      lines.push('')
      lines.push(context.projectSummary)
      lines.push('')
      totalTokens += estimateTokens(context.projectSummary)
    }

    // Section: Previous Phases (budget permitting)
    if (context.previousPhases.length > 0) {
      const phasesText = context.previousPhases.join('\n- ')
      if (estimateTokens(phasesText) < availableBudget) {
        lines.push('### PREVIOUS PHASES')
        lines.push('')
        lines.push(context.previousPhases.length > 0 ? context.previousPhases.map((p) => `- ${p}`).join('\n') : '(none)')
        lines.push('')
        totalTokens += estimateTokens(phasesText)
      }
    }

    // Section: Architecture (budget permitting)
    if (context.architecture && estimateTokens(context.architecture) < availableBudget) {
      lines.push('### ARCHITECTURE')
      lines.push('')
      lines.push(context.architecture)
      lines.push('')
      totalTokens += estimateTokens(context.architecture)
    }

    // Section: Constraints (budget permitting)
    if (context.constraints?.length && estimateTokens(context.constraints.join('\n')) < availableBudget) {
      lines.push('### CONSTRAINTS')
      lines.push('')
      lines.push(context.constraints.map((c) => `- ${c}`).join('\n'))
      lines.push('')
      totalTokens += estimateTokens(context.constraints.join('\n'))
    }

    // Section: Allowed Paths (always)
    lines.push('### ALLOWED PATHS')
    lines.push('')
    if (contract.allowedPaths.length > 0) {
      lines.push(contract.allowedPaths.map((p) => `- ${p}`).join('\n'))
    } else {
      lines.push('(none specified — all project paths allowed)')
    }
    lines.push('')
    totalTokens += estimateTokens(contract.allowedPaths.join('\n'))

    // Section: Forbidden Paths (always)
    lines.push('### FORBIDDEN PATHS')
    lines.push('')
    if (contract.forbiddenPaths.length > 0) {
      lines.push(contract.forbiddenPaths.map((p) => `- ${p}`).join('\n'))
    } else {
      lines.push('(none specified)')
    }
    lines.push('')
    totalTokens += estimateTokens(contract.forbiddenPaths.join('\n'))

    // Section: Acceptance Criteria (always)
    lines.push('### ACCEPTANCE CRITERIA')
    lines.push('')
    contract.acceptanceCriteria.forEach((c) => lines.push(`- ${c}`))
    lines.push('')
    totalTokens += estimateTokens(contract.acceptanceCriteria.join('\n'))

    // Section: Expected Outputs (always)
    lines.push('### EXPECTED OUTPUTS')
    lines.push('')
    if (contract.expectedOutputs.length > 0) {
      lines.push(contract.expectedOutputs.map((o) => `- ${o}`).join('\n'))
    } else {
      lines.push('(see acceptance criteria)')
    }
    lines.push('')
    totalTokens += estimateTokens(contract.expectedOutputs.join('\n'))

    // Footer
    lines.push('Report changes concisely.')

    const prompt = lines.join('\n')
    return {
      prompt,
      metadata: {
        contractId: contract.id,
        phaseId: contract.phaseId,
        attempt: contract.attempt,
        estimatedTokens: Math.min(totalTokens, this.contextBudget),
      },
    }
  }
}
