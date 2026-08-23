/**
 * Browser-local copies of pure wire/view helpers; this module performs no I/O.
 *
 * The browser bundle must not import host modules. Keep these copies aligned
 * with infra/live-output.ts, infra/task-history.ts, workflow/state-view.ts and
 * workflow/delivery-publication.ts. tests/runtime-contract.test.ts compares
 * both boundaries so a one-sided protocol or label change fails CI.
 */
import type { WorkflowEvent } from './domain.ts'

export type AgentKind = 'codex' | 'claude'

export function latestDevelopmentEvent(events: WorkflowEvent[]): WorkflowEvent | undefined {
  return [...events]
    .reverse()
    .find((event) => event.kind === 'dev' || event.kind === 'rework' || event.kind === 'resume')
}
export type LiveLogKind =
  | 'system'
  | 'stage'
  | 'command'
  | 'command_output'
  | 'reasoning'
  | 'tool'
  | 'thinking'
  | 'message'
  | 'text'
  | 'usage'

export interface TokenUsage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface LiveLogEvent {
  source: 'system' | 'agent'
  agent?: AgentKind
  kind: LiveLogKind
  text: string
  usage?: TokenUsage
}

export interface DeliveryPublication {
  target: 'pr' | 'issue'
  status: 'posted' | 'failed'
  url?: string
  error?: string
}

const EVENT_PREFIX = '[clickvibe:event]'

export function decodeLiveLogLine(line: string): LiveLogEvent {
  if (line.startsWith(EVENT_PREFIX)) {
    try {
      const value = JSON.parse(decodeURIComponent(line.slice(EVENT_PREFIX.length))) as LiveLogEvent
      if ((value.source === 'system' || value.source === 'agent') && typeof value.text === 'string') return value
    } catch {
      // Corrupt records remain visible as plain text instead of breaking history.
    }
  }
  return line.startsWith('[clickvibe]')
    ? { source: 'system', kind: 'system', text: line }
    : { source: 'agent', kind: 'text', text: line }
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function taskStartedAt(taskId: string | null): number | null {
  const matched = taskId?.match(/^[a-z]+-(\d+)-/)
  if (!matched) return null
  const value = Number(matched[1])
  return Number.isSafeInteger(value) ? value : null
}

export function latestTokenUsage(events: LiveLogEvent[]): TokenUsage | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].usage) return events[index].usage
  }
  return undefined
}

export function deliveryPublicationLabel(publication: DeliveryPublication | undefined): string {
  if (!publication) return '本地事件'
  if (publication.status === 'failed') return 'GitHub 评论发布失败'
  return `GitHub ${publication.target === 'pr' ? 'PR' : 'Issue'} 评论${publication.url ? ' ↗' : '已发布'}`
}

export interface TaskHistoryWorkflow {
  stage: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
  devTaskId: string | null
  reviewTaskId: string | null
  hasReviewResult: boolean
}

export function selectHistoryTask(workflow: TaskHistoryWorkflow): { taskId: string | null; expectRunning: boolean } {
  if (workflow.stage === 'developing') return { taskId: workflow.devTaskId, expectRunning: true }
  if (workflow.stage === 'reviewing') return { taskId: workflow.reviewTaskId, expectRunning: true }
  const started = (taskId: string | null) => Number(taskId?.match(/^[a-z]+-(\d+)-/)?.[1] ?? 0)
  const showReview =
    workflow.stage === 'passed' ||
    workflow.hasReviewResult ||
    started(workflow.reviewTaskId) > started(workflow.devTaskId)
  return { taskId: showReview ? workflow.reviewTaskId : workflow.devTaskId, expectRunning: false }
}

function workflowBaseBranch(baseRef: string | null | undefined, defaultBranch = 'main'): string {
  const ref = String(baseRef ?? '')
    .split(/\s+@\s+/, 1)[0]
    .trim()
  const branch = ref.replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '')
  return branch !== '' && branch !== 'HEAD' ? branch : defaultBranch
}

export function githubCompareUrl(
  repoKey: string,
  branch: string,
  baseRef: string | null | undefined,
  defaultBranch = 'main',
  _baseRefAvailable = true,
): string {
  const base = workflowBaseBranch(baseRef, defaultBranch)
  return `https://github.com/${repoKey}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`
}

export function workflowStatusLabel(
  status: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed',
  reviewPassed: boolean | null,
  verdictCurrent: boolean | undefined,
  issueContractStatus?: 'current' | 'changed' | 'unknown',
  issueContractUnknownReason?: 'missing-review-snapshot' | 'current-contract-unavailable' | null,
): string {
  if (status === 'idle') return '未开发'
  if (status === 'developing') return '开发中'
  if (status === 'reviewing') return 'review 中'
  if (status === 'passed') return '✅ 已通过'
  if (reviewPassed !== null && verdictCurrent === false) {
    return issueContractStatus === 'unknown' && issueContractUnknownReason === 'current-contract-unavailable'
      ? '验收状态未知'
      : '待重新 Review'
  }
  if (reviewPassed === true) return 'Review 通过'
  if (reviewPassed === false) return 'Review 未通过'
  return '待 review'
}
