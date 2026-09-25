export interface ExecutionContract {
  id: string
  phaseId: string
  attempt: number
  objective: string
  allowedPaths: string[]
  forbiddenPaths: string[]
  allowedCapabilities: string[]
  acceptanceCriteria: string[]
  verificationPlan: string[]
  timeoutSeconds: number
  maxAttempts: number
  risk: 'low' | 'medium' | 'high' | 'critical'
  rollbackPolicy: 'none' | 'checkpoint' | 'branch'
  expectedOutputs: string[]
  budget?: number
}
