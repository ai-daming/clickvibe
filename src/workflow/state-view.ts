/**
 * clickvibe authoritative state view — issue #5.
 *
 * From raw git facts + event history, derive the single next action for an
 * issue workflow. Kept as a pure function so the whole decision table is
 * unit-testable without a shell.
 */

// Browser labels/compare URLs live in client/runtime.ts to preserve the client
// boundary; runtime-contract.test.ts anchors their shared behavior here.

export type NextActionKind =
  | 'develop'
  | 'resume'
  | 'sync'
  | 'create-pr'
  | 'review'
  | 'rework'
  | 'merge'
  | 'cleanup'
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
): string {
  const base = workflowBaseBranch(baseRef, defaultBranch)
  return `https://github.com/${repoKey}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?expand=1`
}

export type WorkflowStageInput = 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
export type WorkflowStatus = WorkflowStageInput | 'interrupted'
export type IssueContractStatus = 'current' | 'changed' | 'unknown'
export type IssueContractUnknownReason = 'missing-review-snapshot' | 'current-contract-unavailable' | null

export interface WorkflowFacts {
  /** The issue itself is still open (closed issues have no next action). */
  issueOpen: boolean
  /** A linked PR has been merged: terminal state. */
  prMerged: boolean
  /** Merge is irreversible, but one or more confirmed cleanup steps remain. */
  cleanupPending?: boolean
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
  /** Comparison of the reviewed Issue body snapshot with the live Issue body. */
  issueContractStatus: IssueContractStatus
  /** Why the contract comparison is unknown; null for current/changed. */
  issueContractUnknownReason: IssueContractUnknownReason
  /** HEAD moved beyond the last recorded dev/rework event. */
  hasNewCommits: boolean
  /** Worktree is behind its base / remote branch and should be synced. */
  needsSync: boolean
  /** Worktree sits in an unresolved conflicted merge (MERGE_HEAD exists). */
  mergeConflict?: boolean
  /** Hard git facts used when the workflow cache is absent. */
  branchExists?: boolean
  worktreeExists?: boolean
  worktreeValid?: boolean
  hasUncommittedChanges?: boolean
  hasCommits?: boolean
  hasResumeSession?: boolean
  /** Whether these facts came with a durable workflow.json cache. */
  workflowCachePresent?: boolean
  /** Latest delivered dev/resume/rework HEAD, from local events or the live PR head. */
  deliveryHash?: string | null
}

export type ReviewStartDecision =
  | { allowed: true; reason: 'completed-facts' | 'workflow-ready' }
  | {
      allowed: false
      reason: 'task-running' | 'development-in-progress' | 'workflow-cache-missing' | 'no-completion-facts'
    }

function sameCommit(left: string | null | undefined, right: string | null | undefined): boolean {
  if (!left || !right) return false
  if (Math.min(left.length, right.length) < 7) return false
  return left === right || left.startsWith(right) || right.startsWith(left)
}

/** Decide review launchability from the same cache and hard facts used by the next-action projection. */
export function deriveReviewStartDecision(facts: WorkflowFacts): ReviewStartDecision {
  if (facts.taskRunning) return { allowed: false, reason: 'task-running' }
  if (!facts.issueOpen || facts.prMerged) return { allowed: false, reason: 'no-completion-facts' }
  // An explicitly interrupted development/rework must retain its resumable
  // session even when HEAD still matches the previous delivered PR commit.
  if (facts.stage === 'developing' && facts.devInterrupted) {
    return { allowed: false, reason: 'development-in-progress' }
  }

  const completedByFacts =
    facts.branchExists === true &&
    facts.worktreeExists === true &&
    facts.worktreeValid !== false &&
    facts.hasUncommittedChanges !== true &&
    facts.needsSync === false &&
    facts.mergeConflict !== true &&
    facts.hasCommits === true &&
    facts.prNumber !== null &&
    facts.prStatusKnown !== false &&
    facts.prState === 'OPEN' &&
    sameCommit(facts.head, facts.deliveryHash)
  if (completedByFacts) return { allowed: true, reason: 'completed-facts' }

  const cachePresent = facts.workflowCachePresent !== false
  if (cachePresent && (facts.stage === 'review-ready' || facts.stage === 'reviewing' || facts.stage === 'passed')) {
    return { allowed: true, reason: 'workflow-ready' }
  }
  if (!cachePresent) return { allowed: false, reason: 'workflow-cache-missing' }
  if (facts.stage === 'developing') return { allowed: false, reason: 'development-in-progress' }
  return { allowed: false, reason: 'no-completion-facts' }
}

function action(kind: NextActionKind, label: string, hint: string): NextAction {
  return { kind, label, hint }
}

/** Derive the badge/detail status from the same live facts as the next action. */
export function deriveWorkflowStatus(facts: WorkflowFacts): WorkflowStatus {
  const verdictCurrent =
    facts.reviewPassed !== null &&
    facts.head !== null &&
    facts.reviewedHash !== null &&
    facts.head === facts.reviewedHash &&
    facts.issueContractStatus === 'current'

  if (facts.prMerged) return 'passed'
  // A live task outranks the linked PR and any verdict bound to an older HEAD.
  if (facts.taskRunning) return facts.stage === 'reviewing' ? 'reviewing' : 'developing'
  // A persisted in-flight stage without its host-owned process is a recovery
  // state, never ordinary review-ready. This is deliberately not "running":
  // after host teardown there is no process handle that can prove liveness.
  if (facts.stage === 'developing' || facts.stage === 'reviewing') return 'interrupted'
  // When the worktree cannot be inspected, preserve a known passing verdict
  // unless there is positive evidence of a newer commit. This matches the
  // pre-derived-state behavior without treating a known changed HEAD as current.
  const passedWithoutContradictingHead =
    facts.reviewPassed === true &&
    facts.issueContractStatus === 'current' &&
    (verdictCurrent || (facts.head === null && !facts.hasNewCommits))
  if (passedWithoutContradictingHead) return 'passed'
  if (facts.reviewPassed !== null || facts.prNumber || facts.stage === 'review-ready') return 'review-ready'
  if (facts.hasUncommittedChanges || facts.hasCommits) return 'developing'
  return 'idle'
}

/** Human label shared by the issue list and detail header. */
export function workflowStatusLabel(
  status: WorkflowStatus,
  reviewPassed: boolean | null,
  verdictCurrent: boolean | undefined,
  issueContractStatus?: IssueContractStatus,
  issueContractUnknownReason?: IssueContractUnknownReason,
): string {
  switch (status) {
    case 'idle':
      return '未开发'
    case 'developing':
      return '开发中'
    case 'review-ready':
      if (reviewPassed !== null && verdictCurrent === false) {
        if (issueContractStatus === 'unknown' && issueContractUnknownReason === 'current-contract-unavailable') {
          return '验收状态未知'
        }
        return '待重新 Review'
      }
      if (reviewPassed === true) return 'Review 通过'
      if (reviewPassed === false) return 'Review 未通过'
      return '待 review'
    case 'reviewing':
      return 'review 中'
    case 'interrupted':
      return '任务已中断'
    case 'passed':
      return '✅ 已通过'
  }
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
  const reviewStart = deriveReviewStartDecision(facts)
  if (facts.cleanupPending) {
    return action('cleanup', '重试清理', 'PR 已合并,继续完成已确认的合并后清理')
  }
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
  // 例外(issue #26):会走 resumeDevelop 的动作都放行——resume/rework 的
  // agent 有完整 git 权限,prompt 前置「先合并 origin/main、解决冲突」指令,
  // 由它自己追平基线。否则同步一旦冲突,意见/会话永远送不到 agent,流水线
  // 死锁。注意返工启动后 stage 已变为 developing:返工中断(失败/停止/超时/
  // Host 重启)时若只放行 review-ready,唯一动作会退回 sync 并再次冲突,
  // 死锁在第一次返工中断后复现,所以 developing 的恢复分支同样放行。
  if (facts.needsSync) {
    if (facts.stage === 'developing') {
      return action('resume', '恢复开发', 'worktree 落后基线,恢复会话会先合并 origin/main 解决冲突,再继续开发')
    }
    if (facts.stage === 'review-ready' && facts.reviewPassed === false) {
      return action('rework', '按意见返工', 'worktree 落后基线,返工会先合并 origin/main 解决冲突,再按意见修改')
    }
    // 未完成的冲突合并(MERGE_HEAD 存在):sync 只会因「合并未完成」再次失败,
    // 没有任何非 agent 动作能推进。待 review/复审阶段也一样(PR #33 现场:
    // rework 完成后待复审、同步冲突、唯一按钮永远停在 sync)。放行恢复,
    // 由 agent 先解决冲突,再自然回到 review 流程。
    if (facts.mergeConflict) {
      return action('resume', '恢复开发', '存在未完成的合并冲突,恢复会话由 agent 先解决冲突再继续')
    }
    return action('sync', '同步 worktree', 'worktree 落后远端基线,先同步再继续')
  }

  // GitHub 上 closed-but-unmerged 是异常终态,必须显式交还给人处理。
  if (facts.prState === 'CLOSED') {
    return action('develop', '查看原因 / 重新开发', 'PR 已关闭但未合并,检查原因后重新开发')
  }

  // A slow workflow-cache update must not hide completed git/GitHub delivery facts.
  if (
    reviewStart.allowed &&
    reviewStart.reason === 'completed-facts' &&
    (facts.stage === 'idle' || facts.stage === 'developing')
  ) {
    return action('review', 'Review', '开发完成,审查代码改动')
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
      facts.devInterrupted
        ? '确认旧宿主任务已停止后,续上次 agent 会话恢复开发'
        : '确认旧宿主任务已停止后,尝试恢复失联的开发会话',
    )
  }
  // review 中断:reviewing 但没有存活任务 → 重新 review。
  if (facts.stage === 'reviewing') {
    return reviewStart.allowed
      ? action('review', '重新 Review', '确认旧宿主任务已停止后,重新审查当前代码')
      : action('none', '无', '当前事实不足以重新启动 Review')
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
        return reviewStart.allowed
          ? action('review', 'Review', '开发完成,审查代码改动')
          : action('none', '无', '当前事实不足以启动 Review')
      }
      // 契约证据优先于旧 verdict 的通过/失败语义。
      if (facts.issueContractStatus === 'changed') {
        return reviewStart.allowed
          ? action('review', '重新 Review', '验收已变更,需按当前 Issue 正文重新审查')
          : action('none', '无', '当前事实不足以重新启动 Review')
      }
      if (facts.issueContractStatus === 'unknown') {
        return facts.issueContractUnknownReason === 'missing-review-snapshot'
          ? action('review', '重新 Review', '现有 GitHub approval 缺少验收契约快照,需由 ClickVibe 重新 Review')
          : action('none', '刷新验收状态', '暂时无法读取当前验收契约,已暂停合并;请刷新后重试')
      }
      // 未通过 → 带意见返工(无论 HEAD 是否已变化;agent 会重读当前代码)。
      if (!facts.reviewPassed) {
        return action('rework', '按意见返工', 'Review 未通过,带意见续开发会话')
      }
      // 通过:结论必须仍针对当前 HEAD 和验收契约,任一变化都重新 review。
      const verdictCurrent = facts.head !== null && facts.head === facts.reviewedHash
      if (!verdictCurrent) {
        return reviewStart.allowed
          ? action('review', '重新 Review', '上次通过的结论针对旧提交,当前 HEAD 已变化,需重新审查')
          : action('none', '无', '当前事实不足以重新启动 Review')
      }
      return facts.prNumber
        ? action('merge', '合并 PR', 'Review 通过,打开 PR 完成合并')
        : action('none', '无', 'Review 已通过,但尚未关联 PR')
    }
    case 'passed':
      if (facts.head === null || facts.head !== facts.reviewedHash) {
        return reviewStart.allowed
          ? action('review', '重新 Review', '上次通过的结论针对旧提交,当前 HEAD 已变化,需重新审查')
          : action('none', '无', '当前事实不足以重新启动 Review')
      }
      if (facts.issueContractStatus === 'changed') {
        return reviewStart.allowed
          ? action('review', '重新 Review', '验收已变更,需按当前 Issue 正文重新审查')
          : action('none', '无', '当前事实不足以重新启动 Review')
      }
      if (facts.issueContractStatus === 'unknown') {
        return facts.issueContractUnknownReason === 'missing-review-snapshot'
          ? action('review', '重新 Review', '现有 GitHub approval 缺少验收契约快照,需由 ClickVibe 重新 Review')
          : action('none', '刷新验收状态', '暂时无法读取当前验收契约,已暂停合并;请刷新后重试')
      }
      return facts.prNumber
        ? action('merge', '合并 PR', 'Review 通过,打开 PR 完成合并')
        : action('none', '无', 'Review 已通过,等待合并')
  }
}
