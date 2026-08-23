/** Plain-data contracts shared by adapters and upper-layer workflows. */
export type AgentKind = 'codex' | 'claude'

export interface PromptSnapshot {
  url: string
  title: string
  body: string
  state: string
  updatedAt: string
  comments: { author: string; body: string }[]
}

export interface DeliveryPublication {
  target: 'pr' | 'issue'
  status: 'posted' | 'failed'
  url?: string
  error?: string
}

export interface IssueContractCheck {
  ok: boolean
  missing: string[]
}
