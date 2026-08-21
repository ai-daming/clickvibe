/**
 * clickvibe authoritative state view — issue #5.
 *
 * From raw git facts + event history, derive the single next action for an
 * issue workflow. Kept as a pure function so the whole decision table is
 * unit-testable without a shell.
 */

export type NextActionKind =
  | 'develop'
  | 'resume'
  | 'sync'
  | 'review'
  | 'rework'
  | 'merge'
  | 'none'

export interface NextAction {
  kind: NextActionKind
  /** Short imperative label for the single action button. */
  label: string
  /** One-line explanation of why this is the next action. */
  hint: string
}

export type WorkflowStageInput = 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'

export interface WorkflowFacts {
  /** The issue itself is still open (closed issues have no next action). */
  issueOpen: boolean
  /** A linked PR has been merged: terminal state. */
  prMerged: boolean
  prNumber: string | null
  /** Persisted workflow stage. */
  stage: WorkflowStageInput
  /** Stored devInterrupted flag (dev stopped / failed / killed). */
  devInterrupted: boolean
  /** A dev/review agent process is currently running for this workflow. */
  taskRunning: boolean
  /** Worktree HEAD short hash; null when the worktree is missing. */
  head: string | null
  /** HEAD the latest review verdict was bound to. */
  reviewedHash: string | null
  /** Latest review verdict; null when there is no verdict yet. */
  reviewPassed: boolean | null
  /** HEAD moved beyond the last recorded dev/rework event. */
  hasNewCommits: boolean
  /** Worktree is behind its base / remote branch and should be synced. */
  needsSync: boolean
}

function action(kind: NextActionKind, label: string, hint: string): NextAction {
  return { kind, label, hint }
}

/**
 * Decide the one next action for an issue workflow.
 *
 * Order of precedence:
 *   terminal states (closed issue / merged PR / task running)
 *   → interrupted dev (resume)
 *   → aborted review (re-review)
 *   → missing worktree
 *   → stale worktree (sync)
 *   → stage-specific verdict (develop / review / rework / merge)
 */
export function deriveNextAction(facts: WorkflowFacts): NextAction {
  // Terminal states first: nothing actionable.
  if (!facts.issueOpen) return action('none', '无', 'issue 已关闭,无待办动作')
  if (facts.prMerged) return action('none', '无', 'PR 已合并,交付完成')
  if (facts.taskRunning) return action('none', '任务进行中', '开发/review 正在运行,等待完成')

  // 中断恢复:开发中但没有存活任务(Host 重启 / 用户停止 / agent 失败)→ 恢复会话。
  // taskRunning 已在上方排除,这里 stage==='developing' 即意味着任务已失联。
  if (facts.stage === 'developing') {
    return action(
      'resume',
      '恢复开发',
      facts.devInterrupted ? '开发曾中断,续上次 agent 会话' : '开发任务已失联(Host 重启?),尝试恢复会话',
    )
  }
  // review 中断:reviewing 但没有存活任务 → 重新 review。
  if (facts.stage === 'reviewing') {
    return action('review', '重新 Review', '上次 review 中断,重新审查当前代码')
  }

  // worktree 缺失(非 idle):无法继续,需要人工修复。
  if (facts.stage !== 'idle' && facts.head === null) {
    return action('none', '无', 'worktree 缺失,请检查本地配置')
  }

  // worktree 落后远端基线 → 先同步(唯一动作)。
  if (facts.needsSync) {
    return action('sync', '同步 worktree', 'worktree 落后远端基线,先同步再继续')
  }

  // developing / reviewing 已被上面的早退处理(中断恢复/重新 review)
  switch (facts.stage) {
    case 'idle':
      return action('develop', '开始开发', '创建 worktree 并启动 agent 开发')
    case 'review-ready': {
      if (facts.reviewPassed === null) {
        return action('review', 'Review', '开发完成,审查代码改动')
      }
      // 未通过 → 带意见返工(无论 HEAD 是否已变化;agent 会重读当前代码)。
      if (!facts.reviewPassed) {
        return action('rework', '按意见返工', 'Review 未通过,带意见续开发会话')
      }
      // 通过:结论必须仍针对当前 HEAD 才算数,HEAD 变化后不冒充当前结论。
      const verdictCurrent = facts.head !== null && facts.head === facts.reviewedHash
      if (!verdictCurrent) {
        return action(
          'review',
          '重新 Review',
          '上次通过的结论针对旧提交,当前 HEAD 已变化,需重新审查',
        )
      }
      return facts.prNumber
        ? action('merge', '合并 PR', 'Review 通过,打开 PR 完成合并')
        : action('none', '无', 'Review 已通过,但尚未关联 PR')
    }
    case 'passed':
      return facts.prNumber
        ? action('merge', '合并 PR', 'Review 通过,打开 PR 完成合并')
        : action('none', '无', 'Review 已通过,等待合并')
  }
}
