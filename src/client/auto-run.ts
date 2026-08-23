import type { Workflow } from './domain.ts'

export const AUTO_RUN_PAUSE_LABEL: Record<string, string> = {
  'session-interrupted': '会话中断',
  'authorization-denied': '授权被拒',
  'sync-conflict': '同步冲突降级',
  'merge-gate-rejected': '合并门禁拒绝',
  'task-timeout': '单任务超时',
  'budget-exhausted': '总预算耗尽',
  'rounds-exhausted': '轮次耗尽',
}

export function autoRunDefaults(workflow: Workflow | null): {
  autoMerge: boolean
  devAgent: 'codex' | 'claude'
  reviewAgent: 'codex' | 'claude'
  maxRounds: number
  budgetHours: number
} {
  const devAgent = workflow?.devAgent ?? 'codex'
  return {
    autoMerge: false,
    devAgent,
    reviewAgent: workflow?.reviewAgent ?? devAgent,
    maxRounds: 20,
    budgetHours: 24,
  }
}

export function unresolvedFindingCount(workflow: Workflow | null): number {
  return workflow?.autoRun?.unresolved.reduce((sum, round) => sum + round.issues.length, 0) ?? 0
}
