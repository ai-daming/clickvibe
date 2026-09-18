import type { WorkItemContractSnapshot } from './contracts.ts'
/** Assessment facts are advisory and never become development authorization. */
export type AssessmentVerdict =
  | 'READY'
  | 'NEEDS_DECISION'
  | 'NEEDS_EVIDENCE'
  | 'DESIGN_REQUIRED'
  | 'AWAITING_ACCEPTANCE'
  | 'REFRAME'
export interface AssessmentModel {
  provider: string
  model: string
  reasoningEffort?: string
}
export interface AssessmentInput {
  contract?: Pick<
    WorkItemContractSnapshot,
    'goal' | 'acceptanceCriteria' | 'nonGoals' | 'constraints' | 'dependencies' | 'architectureImpact'
  >
  url: string
  repoKey: string
  repoPath: string
  title: string
  body: string
  basis: string
  baseOid: string
  model: AssessmentModel
}
export interface AssessmentReport {
  verdict: AssessmentVerdict
  text: string
}
export interface AssessmentRun {
  id: string
  input: AssessmentInput
  sessionId: string
  messageId: string
  phase: 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'cancelled'
  owner: { token: string; pid: number } | null
  reportHash?: string
  verdict?: AssessmentVerdict
  error?: string
  publication: {
    status: 'pending' | 'published' | 'unknown' | 'failed'
    body?: string
    commentId?: number
    error?: string
  }
}
export interface AssessmentState {
  error?: string
  schema: 1
  revision: number
  runs: AssessmentRun[]
  projects: Record<string, { enabled: boolean; model: AssessmentModel }>
  discussions: Record<string, { url: string; runId: string; body: string }>
}
