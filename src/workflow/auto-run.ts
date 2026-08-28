import type { Context } from '@deepseek-ai/cordis'
import { ensureWorktree } from '../agent/worktree.ts'
import { fetchIssue, issueSnapshot, sameIssueContract } from '../github/issue.ts'
import { githubRest } from '../github/rest.ts'
import { type IssuePromptSnapshot } from '../infra/develop-core.ts'
import { localGitSnapshots } from '../infra/local-git-snapshot.ts'
import { liveTasks, parseUrl } from '../infra/runtime.ts'
import {
  appendEvent,
  WorkflowConflictError,
  issueKey,
  loadWorkflow,
  commitWorkflowMetadata,
  workflowRevision,
} from '../infra/state.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { observeWorkflowTask, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { createPullRequest } from './create-pr.ts'
import { startDevelop } from './develop-start.ts'
import { mergeAndCleanup } from './merge.ts'
import {
  type AutoRunDecision,
  type AutoRunConfig,
  type AutoRunTaskOutcome,
  autoRunFailureReason,
  decideAutoRun,
  validateAutoRunConfig,
} from './auto-run-policy.ts'
import type { AutoRunState, IssueWorkflow } from '../infra/state.ts'
import {
  armAutoRunDeadline,
  autoRunWakePending,
  AutoRunControllerError,
  clearAutoRunControllerFailure,
  completeAutoRun,
  handleAutoRunControllerFailure,
  maintainPausedAutoRun,
  pauseAutoRun,
  scheduleAutoRunObservation,
} from './auto-run-recovery.ts'
import { registerAutoRunReconciler } from './auto-run-signal.ts'
import { enrichWorkflowStates } from './repository-state.ts'
import { resumeDevelop } from './resume.ts'
import { startReview } from './review-flow.ts'
import { syncWorktree } from './sync.ts'

interface AutoRunCommandState {
  running: Set<string>
  queued: Map<string, AutoRunTaskOutcome | undefined>
}

const commandStateSymbol = Symbol.for('clickvibe.auto-run-command-state')
const commandStateRoot = globalThis as unknown as Record<PropertyKey, unknown>
const commandState = (commandStateRoot[commandStateSymbol] as AutoRunCommandState | undefined) ?? {
  running: new Set(),
  queued: new Map(),
}
commandStateRoot[commandStateSymbol] = commandState
const { running, queued } = commandState

async function persistDecision(key: string, decision: Exclude<AutoRunDecision, { kind: 'manual' }>): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  workflow.autoRun.rounds = decision.rounds
  workflow.autoRun.unresolved = decision.unresolved
  if (decision.kind === 'trigger') workflow.autoRun.step = decision.step
  workflow.autoRun.lastObservedAt = new Date().toISOString()
  try {
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), { autoRun: workflow.autoRun }),
    )
  } catch (error) {
    if (!(error instanceof WorkflowConflictError)) throw error
    // 记账数据(rounds/step/lastObservedAt)每轮 reconcile 重算重写;条件提交拦住
    // 旧写是它正确工作。对"有人更新"的正确反应是放手让路(#122 现场:与 defer
    // 事件/完成收尾并发写撞车曾把控制器打停)。丢一次记账,下一轮自愈。
    logTaskDiagnostic('auto-run-persist-skipped', {
      workflowKey: key,
      reason: 'revision-conflict',
      rounds: decision.rounds,
      step: decision.kind === 'trigger' ? decision.step : null,
    })
  }
}

async function applyDecision(ctx: Context, key: string, decision: AutoRunDecision): Promise<void> {
  if (decision.kind === 'manual') return
  if (decision.kind === 'wait') {
    const workflow = await loadWorkflow(key)
    if (workflow?.autoRun?.status === 'running') {
      scheduleAutoRunObservation(ctx, key, workflow.autoRun.deadline, requestAutoRunReconcile)
    }
    return
  }
  if (decision.kind === 'pause') {
    await pauseAutoRun(key, decision.reason, undefined, ctx)
    return
  }
  if (decision.kind === 'complete') {
    await completeAutoRun(key, decision.reason === 'issue-closed' ? 'Issue 已关闭,自动跑到底结束' : undefined)
    return
  }
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  let result: {
    ok: boolean
    error?: string
    conflict?: boolean
    merged?: boolean
    cleanupPending?: boolean
    gateFailures?: unknown[]
    controllerError?: boolean
    semanticFailure?: 'authorization-denied'
  }
  switch (decision.action) {
    case 'develop':
      result = await startDevelop(
        ctx,
        { url: workflow.url, agent: workflow.autoRun.devAgent },
        workflow.issueSnapshot ?? null,
      )
      break
    case 'create-pr':
      result = await createPullRequest(ctx, { url: workflow.url })
      break
    case 'review':
      result = await startReview(ctx, { url: workflow.url, agent: workflow.autoRun.reviewAgent })
      break
    case 'rework':
      result = await resumeDevelop(ctx, { url: workflow.url })
      break
    case 'sync':
      result = await syncWorktree(ctx, { url: workflow.url })
      break
    case 'merge':
    case 'cleanup':
      result = await mergeAndCleanup(ctx, { url: workflow.url })
      break
  }
  if (!result.ok) {
    const circuit = githubRest(ctx as never).rateLimitError()
    if (circuit) throw circuit
    if (result.conflict) {
      // 原则 10(可恢复性优于预防):sync 冲突现场已由 syncWorktree 保留并记录,
      // 属可恢复工作——不暂停,直接排队下一轮 reconcile,由 derive 推导出 resume
      // 并自动转交 agent 解决(#107 现场:并行落后 61 提交,首步 sync 必撞冲突,
      // 旧路径每次都要人工重挂一次)。
      requestAutoRunReconcile(ctx, key)
      return
    }
    const reason = autoRunFailureReason(decision.action, result)
    if (reason === 'controller-error' || reason === 'cleanup-failed') {
      throw new AutoRunControllerError(`action:${decision.action}`, result.error ?? reason)
    }
    await pauseAutoRun(
      key,
      reason,
      {
        action: decision.action,
        error: result.error,
      },
      ctx,
    )
    return
  }
  if (decision.action === 'create-pr' || decision.action === 'sync') requestAutoRunReconcile(ctx, key)
}

async function reconcileOnce(ctx: Context, key: string, outcome?: AutoRunTaskOutcome): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  if (Date.now() >= Date.parse(workflow.autoRun.deadline)) {
    await pauseAutoRun(key, 'budget-exhausted', undefined, ctx)
    return
  }
  const [observed] = await enrichWorkflowStates(ctx, [workflow], undefined, localGitSnapshots)
  if (!observed) return
  const decision = decideAutoRun({
    autoRun: workflow.autoRun,
    nextAction: observed.derived.nextAction,
    now: Date.now(),
    reviewEvents: workflow.events,
    issueOpen: observed.issueState !== 'CLOSED',
    ...(outcome ? { taskOutcome: outcome } : {}),
  })
  if (decision.kind !== 'manual') await persistDecision(key, decision)
  await applyDecision(ctx, key, decision)
  await clearAutoRunControllerFailure(key)
}

export function requestAutoRunReconcile(ctx: Context, key: string, outcome?: AutoRunTaskOutcome): void {
  if (running.has(key)) {
    queued.set(key, outcome ?? queued.get(key))
    return
  }
  running.add(key)
  void (async () => {
    let nextOutcome = outcome
    try {
      do {
        queued.delete(key)
        const current = await loadWorkflow(key)
        if (current?.autoRun?.status === 'paused' && current.autoRun.pausedReason === 'controller-error') {
          const maintained = await maintainPausedAutoRun(ctx, key, requestAutoRunReconcile)
          if (maintained === 'reattached') await reconcileOnce(ctx, key, nextOutcome)
        } else {
          await reconcileOnce(ctx, key, nextOutcome)
        }
        nextOutcome = queued.get(key)
      } while (queued.has(key))
    } catch (error) {
      logTaskDiagnostic('auto-run-reconcile-error', {
        workflowKey: key,
        outcome: nextOutcome ?? null,
        errorName: error instanceof Error ? error.name : typeof error,
        errorMessage: error instanceof Error ? error.message : String(error),
        errorStack: error instanceof Error ? error.stack : null,
      })
      const source = error instanceof AutoRunControllerError ? error.source : 'reconcile'
      await handleAutoRunControllerFailure(ctx, key, error, source, requestAutoRunReconcile)
    } finally {
      running.delete(key)
      if (queued.has(key)) {
        const pending = queued.get(key)
        queued.delete(key)
        requestAutoRunReconcile(ctx, key, pending)
      }
    }
  })()
}

registerAutoRunReconciler(requestAutoRunReconcile)

export async function startAutoRun(
  ctx: Context,
  payload: unknown,
  authorizedSnapshot: IssuePromptSnapshot | null,
): Promise<{ ok: true; workflowKey: string } | { ok: false; error: string }> {
  const body = (payload ?? {}) as { url?: unknown; autoRun?: unknown }
  const url = String(body.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '自动跑到底目标必须是 GitHub Issue URL' }
  if (!authorizedSnapshot || authorizedSnapshot.url !== url || authorizedSnapshot.state !== 'OPEN') {
    return { ok: false, error: '缺少与该 OPEN Issue 和配置绑定的服务端确认快照' }
  }
  let config: AutoRunConfig
  try {
    config = validateAutoRunConfig(body.autoRun)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  const refreshed = await fetchIssue(ctx, { url, forceRefresh: true })
  if (!refreshed.ok) return { ok: false, error: `执行前无法刷新 Issue 快照: ${refreshed.error}` }
  const currentSnapshot = issueSnapshot(refreshed.data.item as Record<string, unknown>)
  if (!sameIssueContract(currentSnapshot, authorizedSnapshot)) {
    return { ok: false, error: 'Issue 契约已变化(正文/标题/状态),拒绝使用旧授权启动自动跑到底' }
  }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  const ensured = await ensureWorktree(ctx, parsed)
  if (!ensured.ok) return ensured
  const ownership = observeWorkflowTask(ctx as unknown as TaskOwnershipContext, ensured.workflow)
  if (ownership.state === 'running') {
    return { ok: false, error: '该 issue 当前有任务运行,请等待或停止后再启动自动跑到底' }
  }
  if (ownership.state === 'unknown') {
    return { ok: false, error: '当前控制器无法确认旧任务生死,为避免双开已禁止启动自动跑到底' }
  }
  const startedAt = new Date().toISOString()
  ensured.workflow.issueSnapshot = authorizedSnapshot
  ensured.workflow.autoRun = {
    status: 'running',
    ...config,
    startedAt,
    deadline: new Date(Date.parse(startedAt) + config.budgetHours * 3_600_000).toISOString(),
    step: 0,
    rounds: 0,
    unresolved: [],
    lastObservedAt: null,
    pausedReason: null,
  }
  await appendEvent(
    ensured.workflow,
    { kind: 'auto-run', at: startedAt, round: 0, note: '自动跑到底已启动' },
    workflowRevision(ensured.workflow) ?? 0,
  )
  armAutoRunDeadline(ctx, key, ensured.workflow.autoRun.deadline, requestAutoRunReconcile)
  requestAutoRunReconcile(ctx, key)
  return { ok: true, workflowKey: key }
}

export async function pauseOrphanedAutoRuns(
  ctx: Context,
  workflows: readonly (IssueWorkflow & { autoRun?: AutoRunState })[],
): Promise<void> {
  for (const candidate of workflows) {
    const autoRun = candidate.autoRun
    if (!autoRun) continue
    const eligible =
      autoRun.status === 'running' || (autoRun.status === 'paused' && autoRun.pausedReason === 'controller-error')
    if (!eligible || running.has(candidate.key) || autoRunWakePending(candidate.key)) {
      continue
    }
    armAutoRunDeadline(ctx, candidate.key, autoRun.deadline, requestAutoRunReconcile)
    let ownership: ReturnType<typeof observeWorkflowTask> | null = null
    try {
      ownership = observeWorkflowTask(ctx as unknown as TaskOwnershipContext, candidate)
    } catch (error) {
      logTaskDiagnostic('auto-run-ownership-error', {
        workflowKey: candidate.key,
        error: error instanceof Error ? error.message : String(error),
        trigger: 'state-refresh',
      })
    }
    logTaskDiagnostic('auto-run-ownership-observed', {
      workflowKey: candidate.key,
      step: autoRun.step ?? 0,
      updatedAt: candidate.updatedAt,
      ownership: ownership ?? { state: 'unknown', source: 'registry-error' },
      devTaskId: candidate.devTaskId,
      reviewTaskId: candidate.reviewTaskId,
      liveTaskKeys: [...liveTasks.entries()].filter(([, task]) => !task.closed).map(([taskId]) => taskId),
      trigger: 'state-refresh',
    })
    requestAutoRunReconcile(ctx, candidate.key, ownership?.state === 'interrupted' ? 'stopped' : undefined)
  }
}
