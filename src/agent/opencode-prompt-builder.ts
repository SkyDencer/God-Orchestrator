import type { ExecutionContract } from './execution-contract.js'

/**
 * Builds an OpenCode prompt from an ExecutionContract.
 *
 * Structure:
 *   ### OBJECTIVE
 *   <objective>
 *
 *   ### ALLOWED PATHS
 *   <paths>
 *
 *   ### FORBIDDEN PATHS
 *   <paths>
 *
 *   ### ACCEPTANCE CRITERIA
 *   <criteria>
 *
 *   ### EXPECTED OUTPUTS
 *   <outputs>
 *
 *   Report changes concisely.
 */
export function buildOpenCodePrompt(contract: ExecutionContract): string {
  const lines: string[] = []

  lines.push(`### OBJECTIVE`)
  lines.push('')
  lines.push(contract.objective)
  lines.push('')

  lines.push(`### ALLOWED PATHS`)
  lines.push('')
  if (contract.allowedPaths.length > 0) {
    contract.allowedPaths.forEach((p) => lines.push(`- ${p}`))
  } else {
    lines.push('(none specified — all project paths allowed)')
  }
  lines.push('')

  lines.push(`### FORBIDDEN PATHS`)
  lines.push('')
  if (contract.forbiddenPaths.length > 0) {
    contract.forbiddenPaths.forEach((p) => lines.push(`- ${p}`))
  } else {
    lines.push('(none specified)')
  }
  lines.push('')

  lines.push(`### ACCEPTANCE CRITERIA`)
  lines.push('')
  contract.acceptanceCriteria.forEach((c) => lines.push(`- ${c}`))
  lines.push('')

  lines.push(`### EXPECTED OUTPUTS`)
  lines.push('')
  if (contract.expectedOutputs.length > 0) {
    contract.expectedOutputs.forEach((o) => lines.push(`- ${o}`))
  } else {
    lines.push('(see acceptance criteria)')
  }
  lines.push('')

  lines.push('Report changes concisely.')

  return lines.join('\n')
}
