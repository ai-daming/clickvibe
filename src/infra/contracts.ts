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

export interface DeliveryCommit {
  hash: string
  subject: string
}

export interface DeliveryDiffstat {
  path: string
  /** Binary files have no meaningful line count. */
  insertions: number | null
  deletions: number | null
}

/** Immutable git facts for one delivery generation. */
export interface DeliveryStats {
  commits: DeliveryCommit[]
  filesChanged: number
  insertions: number
  deletions: number
  diffstat: DeliveryDiffstat[]
}

export interface IssueContractCheck {
  ok: boolean
  missing: string[]
}
