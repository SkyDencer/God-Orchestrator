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

const SECRET_PATTERNS = [
  // Match "api key", "apikey", "api_key", "api-key" followed by : or = and a secret value
  /(?:api\s*[_-]?key|apikey)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  /(?:api\s*[_-]?secret|apisecret)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  /(?:secret[_-]?key|secretkey)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  // Password patterns
  /(?:password|passwd|pwd)\s*[:=]\s*['"]?([^\s'"]{4,})['"]?/gi,
  // Token patterns
  /(?:token|auth[_-]?token|access[_-]?token|bearer)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  // AWS credentials
  /(?:aws[_-]?access[_-]?key[_-]?id|aws[_-]?secret[_-]?access[_-]?key)\s*[:=]\s*['"]?([^\s'"]{8,})['"]?/gi,
  // Private keys
  /-----BEGIN\s+(RSA|EC|OPENSSH)\s+PRIVATE\s+KEY-----/gi,
  // GitHub personal access tokens
  /ghp_[A-Za-z0-9]{36}/g,
  // GitLab personal access tokens
  /glpat-[A-Za-z0-9_-]{20,}/g,
] as const

/**
 * Redact common secret patterns from text.
 * Replaces values matching known secret formats with [REDACTED].
 */
function redactSecrets(text: string): string {
  let result = text
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, (match, secret: string) => {
      // Replace the captured secret value with [REDACTED]
      if (secret) {
        return match.replace(secret, '[REDACTED]')
      }
      return match
    })
  }
  return result
}

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
    // Redact secrets from context before assembling prompt
    const safeContext: TaskContext = {
      projectSummary: redactSecrets(context.projectSummary),
      previousPhases: context.previousPhases.map(redactSecrets),
      architecture: context.architecture ? redactSecrets(context.architecture) : undefined,
      constraints: context.constraints?.map(redactSecrets),
      relevantMemory: context.relevantMemory
        ? Object.fromEntries(
            Object.entries(context.relevantMemory).map(([k, v]) => [k, redactSecrets(v)]),
          )
        : undefined,
    }

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
    if (safeContext.projectSummary && estimateTokens(safeContext.projectSummary) < availableBudget) {
      lines.push('### PROJECT SUMMARY')
      lines.push('')
      lines.push(safeContext.projectSummary)
      lines.push('')
      totalTokens += estimateTokens(safeContext.projectSummary)
    }

    // Section: Previous Phases (budget permitting)
    if (safeContext.previousPhases.length > 0) {
      const phasesText = safeContext.previousPhases.join('\n- ')
      if (estimateTokens(phasesText) < availableBudget) {
        lines.push('### PREVIOUS PHASES')
        lines.push('')
        lines.push(safeContext.previousPhases.map((p) => `- ${p}`).join('\n'))
        lines.push('')
        totalTokens += estimateTokens(phasesText)
      }
    }

    // Section: Architecture (budget permitting)
    if (safeContext.architecture && estimateTokens(safeContext.architecture) < availableBudget) {
      lines.push('### ARCHITECTURE')
      lines.push('')
      lines.push(safeContext.architecture)
      lines.push('')
      totalTokens += estimateTokens(safeContext.architecture)
    }

    // Section: Constraints (budget permitting)
    if (safeContext.constraints?.length && estimateTokens(safeContext.constraints.join('\n')) < availableBudget) {
      lines.push('### CONSTRAINTS')
      lines.push('')
      lines.push(safeContext.constraints.map((c) => `- ${c}`).join('\n'))
      lines.push('')
      totalTokens += estimateTokens(safeContext.constraints.join('\n'))
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
