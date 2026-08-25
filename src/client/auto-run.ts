import type { Workflow } from './domain.ts'

export const AUTO_RUN_PAUSE_LABEL: Record<string, string> = {
  'session-interrupted': '会话中断',
  'controller-error': '控制器异常',
  'authorization-denied': '授权被拒',
  'sync-conflict': '同步冲突降级',
  'merge-gate-rejected': '合并门禁拒绝',
  'cleanup-failed': '合并后清理失败',
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

export type AutoRunDraft = ReturnType<typeof autoRunDefaults>

export function synchronizeAutoRunDraft(
  current: AutoRunDraft,
  workflow: Workflow | null,
  edited: boolean,
): AutoRunDraft {
  return edited ? current : autoRunDefaults(workflow)
}

export function unresolvedFindingCount(workflow: Workflow | null): number {
  return workflow?.autoRun?.unresolved.reduce((sum, round) => sum + round.issues.length, 0) ?? 0
}

/**
 * 自动推进横幅文案。列表行(compact)不展示暂停横幅——行的真实状态由交付阶段徽章表达,
 * 控制器的暂停(session-interrupted 等)不冒充流程状态;详情视图展示原因,宿主仍持有
 * 运行任务时如实追加「任务继续运行中」。
 */
/**
 * 「自动跑到底」按钮的文案与可点性。只要还有任务在跑(autoRun 自己在跑,或
 * 宿主仍持有开发/review 任务——即使 autoRun 因会话中断已暂停),按钮就必须
 * 禁用,防止任务运行期间双开自动推进。
 */
export function autoRunTrigger(
  active: Workflow['autoRun'],
  workflow: Workflow | null,
): { label: string; disabled: boolean } {
  if (active?.status === 'running') {
    return {
      label: `自动运行 · 第 ${active.step ?? 0} 步 · 已完成 ${active.rounds}/${active.maxRounds} 轮`,
      disabled: true,
    }
  }
  if (workflow?.runStartedAt != null) {
    return { label: '任务进行中', disabled: true }
  }
  if (workflow?.derived?.status === 'task-unknown') {
    return { label: '等待任务确认', disabled: true }
  }
  return { label: '自动跑到底', disabled: false }
}

export function autoRunBanner(
  active: Workflow['autoRun'],
  workflow: Workflow | null,
  options: { compact: boolean },
): string | null {
  if (!active) return null
  if (active.status === 'completed') return '已到待合并'
  if (active.status !== 'paused') return null
  if (options.compact) return null
  const label = AUTO_RUN_PAUSE_LABEL[active.pausedReason ?? ''] ?? active.pausedReason
  return workflow?.runStartedAt != null ? `已暂停:${label} · 任务继续运行中` : `已暂停:${label}`
}
