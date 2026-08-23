import type { NextAction, NextActionKind } from './domain.ts'

export interface FreshSessionAvailability {
  round: number
  develop: boolean
  review: boolean
}

/** Select the secondary entry that belongs beside the current continuation action. */
export function freshSessionEntry(
  action: NextActionKind,
  availability: FreshSessionAvailability | null | undefined,
): 'develop' | 'review' | null {
  if ((action === 'resume' || action === 'rework') && availability?.develop) return 'develop'
  if (action === 'review' && availability?.review) return 'review'
  return null
}

/** Preserve the existing client fallback when the server has no persisted workflow yet. */
export function effectiveActionForIssue(
  issueClosed: boolean,
  nextAction: NextAction | undefined,
  hasWorkflow: boolean,
): NextAction {
  if (issueClosed && nextAction?.kind !== 'cleanup') {
    return { kind: 'none', label: '无', hint: 'issue 已关闭,无待办动作' }
  }
  if (nextAction) return nextAction
  return hasWorkflow
    ? { kind: 'none', label: '无', hint: '等待状态…' }
    : { kind: 'develop', label: '开始开发', hint: '创建 worktree 并启动 agent 开发' }
}
