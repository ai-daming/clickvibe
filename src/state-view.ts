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
  | 'create-pr'
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

/** Resolve the PR base from the frozen workflow baseline, then the live repo default. */
export function workflowBaseBranch(baseRef: string | null | undefined, defaultBranch = 'main'): string {
  const ref = String(baseRef ?? '').split(/\s+@\s+/, 1)[0].trim()
  const branch = ref.replace(/^refs\/remotes\/origin\//, '').replace(/^origin\//, '')
  return branch !== '' && branch !== 'HEAD' ? branch : defaultBranch
}

export function githubCompareUrl(
  repoKey: string,
  branch: string,
  baseRef: string | null | undefined,
  defaultBranch = 'main',
): string {
  const base = workflowBaseBranch(baseRef, defaultBranch)
  return `https://github.com/${repoKey}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`
}

export type WorkflowStageInput = 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'

export interface WorkflowFacts {
  /** The issue itself is still open (closed issues have no next action). */
  issueOpen: boolean
  /** A linked PR has been merged: terminal state. */
  prMerged: boolean
  /** Current GitHub PR state, queried live. */
  prState?: 'OPEN' | 'MERGED' | 'CLOSED' | null
  /** False means a linked PR exists in cache but its live GitHub state could not be read. */
  prStatusKnown?: boolean
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
  /** Hard git facts used when the workflow cache is absent. */
  branchExists?: boolean
  worktreeExists?: boolean
  worktreeValid?: boolean
  hasUncommittedChanges?: boolean
  hasCommits?: boolean
  hasResumeSession?: boolean
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
  if (facts.prNumber && facts.prStatusKnown === false) {
    return action('none', '刷新 PR 状态', 'GitHub PR 实时状态查询失败,为避免误合并已暂停动作')
  }

  // P2 结构恢复。统一走 develop,由 ensureWorktree 按硬事实幂等恢复。
  if (facts.worktreeExists && facts.worktreeValid === false) {
    return action('develop', '修复 worktree', 'worktree 未附着到约定分支,修复后继续开发')
  }
  if (facts.branchExists && facts.worktreeExists === false && (facts.hasCommits || facts.stage !== 'idle')) {
    return action('develop', '恢复 worktree 继续开发', '分支仍存在,重建 worktree 后继续开发')
  }

  // worktree 落后远端基线 → 先同步(唯一动作)。
  // 例外(issue #26):review 未通过等返工时放行 rework——返工 agent 有完整
  // git 权限,由它先合并 origin/main 解决冲突、再修意见。否则同步一旦冲突,
  // 意见永远送不到 agent,流水线死锁。
  if (facts.needsSync) {
    if (facts.stage === 'review-ready' && facts.reviewPassed === false) {
      return action('rework', '按意见返工', 'worktree 落后基线,返工会先合并 origin/main 解决冲突,再按意见修改')
    }
    return action('sync', '同步 worktree', 'worktree 落后远端基线,先同步再继续')
  }

  // GitHub 上 closed-but-unmerged 是异常终态,必须显式交还给人处理。
  if (facts.prState === 'CLOSED') {
    return action('develop', '查看原因 / 重新开发', 'PR 已关闭但未合并,检查原因后重新开发')
  }

  // 没有 workflow 缓存时,从 git 内容与 PR 硬事实恢复生命周期。
  if (!facts.prNumber && facts.hasUncommittedChanges) {
    return facts.hasResumeSession
      ? action('resume', '恢复开发', 'worktree 有未提交改动,续上次 agent 会话')
      : action('develop', '重新开发', 'worktree 有未提交改动但无可恢复会话,启动新会话')
  }
  if (!facts.prNumber && facts.hasCommits) {
    return action('create-pr', '创建 PR', '开发分支已有提交,推送并创建 PR 后 Review')
  }

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

  // worktree 缺失(非 idle,且分支也无法确认):无法继续,需要人工检查。
  if (facts.stage !== 'idle' && facts.head === null) {
    return action('none', '无', 'worktree 缺失,请检查本地配置')
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
