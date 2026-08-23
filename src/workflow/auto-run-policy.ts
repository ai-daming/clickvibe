import type { AutoRunPausedReason, AutoRunState, AutoRunUnresolvedRound, IssueWorkflow } from '../infra/state.ts'
import type { NextAction, NextActionKind } from './state-view.ts'

export interface AutoRunConfig {
  autoMerge: boolean
  devAgent: 'codex' | 'claude'
  reviewAgent: 'codex' | 'claude'
  maxRounds: number
  budgetHours: number
}

export type AutoRunTaskOutcome = 'done' | 'failed' | 'stopped' | 'timed_out'

export type AutoRunDecision =
  | { kind: 'manual' }
  | { kind: 'wait'; rounds: number; unresolved: AutoRunUnresolvedRound[] }
  | { kind: 'complete'; rounds: number; unresolved: AutoRunUnresolvedRound[] }
  | {
      kind: 'trigger'
      action: Extract<NextActionKind, 'develop' | 'create-pr' | 'review' | 'rework' | 'sync' | 'merge' | 'cleanup'>
      rounds: number
      unresolved: AutoRunUnresolvedRound[]
    }
  | { kind: 'pause'; reason: AutoRunPausedReason; rounds: number; unresolved: AutoRunUnresolvedRound[] }

function agent(value: unknown, label: string, fallback: 'codex' | 'claude'): 'codex' | 'claude' {
  const resolved = value ?? fallback
  if (resolved !== 'codex' && resolved !== 'claude') throw new Error(`${label} 只支持 codex / claude`)
  return resolved
}

function positive(value: unknown, fallback: number, label: string, integer: boolean): number {
  const resolved = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(resolved) || resolved <= 0 || (integer && !Number.isInteger(resolved))) {
    throw new Error(`${label}必须是${integer ? '正整数' : '正数'}`)
  }
  return resolved
}

export function validateAutoRunConfig(
  value: unknown,
  defaults: { devAgent?: 'codex' | 'claude'; reviewAgent?: 'codex' | 'claude' } = {},
): AutoRunConfig {
  const raw = (value ?? {}) as Record<string, unknown>
  const devAgent = agent(raw.devAgent, '开发 agent', defaults.devAgent ?? 'codex')
  return {
    autoMerge: raw.autoMerge === true,
    devAgent,
    reviewAgent: agent(raw.reviewAgent, 'Review agent', defaults.reviewAgent ?? devAgent),
    maxRounds: positive(raw.maxRounds, 20, '轮次上限', true),
    budgetHours: positive(raw.budgetHours, 24, '总预算', false),
  }
}

export function aggregateAutoRunReviews(
  autoRun: AutoRunState,
  events: readonly IssueWorkflow['events'][number][],
): { rounds: number; unresolved: AutoRunUnresolvedRound[] } {
  const startedAt = Date.parse(autoRun.startedAt)
  const reviews = events.filter(
    (event) => event.kind === 'review' && event.verdict !== undefined && Date.parse(event.at) >= startedAt,
  )
  return {
    rounds: reviews.length,
    unresolved: reviews.flatMap((event, index) =>
      event.verdict?.passed === false ? [{ round: index + 1, issues: [...event.verdict.issues] }] : [],
    ),
  }
}

function paused(reason: AutoRunPausedReason, reviews: ReturnType<typeof aggregateAutoRunReviews>): AutoRunDecision {
  return { kind: 'pause', reason, ...reviews }
}

export function decideAutoRun(input: {
  autoRun: AutoRunState | undefined
  nextAction: NextAction
  now: number
  reviewEvents: readonly IssueWorkflow['events'][number][]
  taskOutcome?: AutoRunTaskOutcome
}): AutoRunDecision {
  if (!input.autoRun || input.autoRun.status !== 'running') return { kind: 'manual' }
  const reviews = aggregateAutoRunReviews(input.autoRun, input.reviewEvents)
  if (input.taskOutcome === 'timed_out') return paused('task-timeout', reviews)
  if (input.taskOutcome === 'failed' || input.taskOutcome === 'stopped') {
    return paused('session-interrupted', reviews)
  }
  if (input.now >= Date.parse(input.autoRun.deadline)) return paused('budget-exhausted', reviews)
  if (reviews.rounds >= input.autoRun.maxRounds && input.nextAction.kind === 'rework') {
    return paused('rounds-exhausted', reviews)
  }
  switch (input.nextAction.kind) {
    case 'develop':
    case 'create-pr':
    case 'review':
    case 'rework':
    case 'sync':
      return { kind: 'trigger', action: input.nextAction.kind, ...reviews }
    case 'resume':
      return paused('session-interrupted', reviews)
    case 'merge':
      return input.autoRun.autoMerge
        ? { kind: 'trigger', action: 'merge', ...reviews }
        : { kind: 'complete', ...reviews }
    case 'cleanup':
      return input.autoRun.autoMerge
        ? { kind: 'trigger', action: 'cleanup', ...reviews }
        : { kind: 'complete', ...reviews }
    case 'none':
      return { kind: 'wait', ...reviews }
  }
}
