import type { Context } from '@deepseek-ai/cordis'
import { ensureWorktree } from '../agent/worktree.ts'
import { fetchIssue, issueSnapshot, sameIssueContract } from '../github/issue.ts'
import { type IssuePromptSnapshot } from '../infra/develop-core.ts'
import { liveTasks, parseUrl } from '../infra/runtime.ts'
import {
  appendEvent,
  type AutoRunPausedReason,
  issueKey,
  loadWorkflow,
  commitWorkflowMetadata,
  workflowRevision,
} from '../infra/state.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import {
  observeWorkflowTask,
  taskLaunchDecision,
  type TaskOwnershipContext,
  type WorkflowTaskRef,
} from '../infra/task-ownership.ts'
import { createPullRequest } from './create-pr.ts'
import { startDevelop } from './develop-start.ts'
import { mergeAndCleanup } from './merge.ts'
import {
  type AutoRunDecision,
  type AutoRunConfig,
  type AutoRunTaskOutcome,
  autoRunFailureReason,
  autoRunRetryDelay,
  decideAutoRun,
  validateAutoRunConfig,
} from './auto-run-policy.ts'
import type { AutoRunState, IssueWorkflow } from '../infra/state.ts'
import type { LiveTask } from '../infra/runtime.ts'
import { registerAutoRunReconciler } from './auto-run-signal.ts'
import { enrichWorkflowStates } from './repository-state.ts'
import { resumeDevelop } from './resume.ts'
import { startReview } from './review-flow.ts'
import { syncWorktree } from './sync.ts'

const running = new Set<string>()
const queued = new Map<string, AutoRunTaskOutcome | undefined>()
const deadlineTimers = new Map<string, ReturnType<typeof setTimeout>>()
const observationTimers = new Map<string, ReturnType<typeof setTimeout>>()

function liveTaskFor(taskRef: WorkflowTaskRef | null): LiveTask | null {
  if (!taskRef) return null
  const task = liveTasks.get(taskRef.taskId)
  return task && !task.closed ? task : null
}

async function persistDecision(key: string, decision: Exclude<AutoRunDecision, { kind: 'manual' }>): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  workflow.autoRun.rounds = decision.rounds
  workflow.autoRun.unresolved = decision.unresolved
  if (decision.kind === 'trigger') workflow.autoRun.step = decision.step
  workflow.autoRun.lastObservedAt = new Date().toISOString()
  Object.assign(
    workflow,
    await commitWorkflowMetadata(workflow, workflowRevision(workflow), { autoRun: workflow.autoRun }),
  )
}

interface PauseEvidence {
  action?: string
  error?: string
}

async function pauseAutoRun(key: string, reason: AutoRunPausedReason, evidence?: PauseEvidence): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  const evidenceNote = evidence
    ? `(${[
        evidence.action ? `动作 ${evidence.action}` : null,
        evidence.error ? `错误: ${evidence.error.slice(0, 200)}` : null,
      ]
        .filter(Boolean)
        .join(' · ')})`
    : ''
  logTaskDiagnostic('auto-run-pause', {
    reason,
    ...(evidence ? { action: evidence.action ?? null, error: evidence.error?.slice(0, 500) ?? null } : {}),
    workflowKey: key,
    step: workflow.autoRun.step ?? 0,
    updatedAt: workflow.updatedAt,
    devTaskId: workflow.devTaskId,
    reviewTaskId: workflow.reviewTaskId,
    liveTaskKeys: [...liveTasks.entries()].filter(([, task]) => !task.closed).map(([taskId]) => taskId),
  })
  workflow.autoRun.status = 'paused'
  workflow.autoRun.pausedReason = reason
  workflow.autoRun.lastObservedAt = new Date().toISOString()
  await appendEvent(
    workflow,
    {
      kind: 'auto-run',
      at: new Date().toISOString(),
      round: workflow.autoRun.rounds,
      step: workflow.autoRun.step,
      note: `自动跑到底已暂停:${reason}${evidenceNote}`,
    },
    workflowRevision(workflow) ?? 0,
  )
  clearDeadline(key)
  clearObservation(key)
}

async function completeAutoRun(key: string): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  workflow.autoRun.status = 'completed'
  workflow.autoRun.pausedReason = null
  await appendEvent(
    workflow,
    {
      kind: 'auto-run',
      at: new Date().toISOString(),
      round: workflow.autoRun.rounds,
      step: workflow.autoRun.step,
      note: '自动跑到底已收敛,等待人工合并',
    },
    workflowRevision(workflow) ?? 0,
  )
  clearDeadline(key)
  clearObservation(key)
}

function clearObservation(key: string): void {
  const timer = observationTimers.get(key)
  if (timer) clearTimeout(timer)
  observationTimers.delete(key)
}

function scheduleObservation(ctx: Context, key: string, deadline: string): void {
  clearObservation(key)
  const delay = autoRunRetryDelay(Date.now(), Date.parse(deadline))
  if (delay === null) return
  const timer = setTimeout(() => {
    observationTimers.delete(key)
    requestAutoRunReconcile(ctx, key)
  }, delay)
  timer.unref?.()
  observationTimers.set(key, timer)
}

function clearDeadline(key: string): void {
  const timer = deadlineTimers.get(key)
  if (timer) clearTimeout(timer)
  deadlineTimers.delete(key)
}

function armDeadline(ctx: Context, key: string, deadline: string): void {
  clearDeadline(key)
  const delay = Math.max(0, Date.parse(deadline) - Date.now())
  const timer = setTimeout(
    () => {
      void (async () => {
        if (Date.now() < Date.parse(deadline)) {
          armDeadline(ctx, key, deadline)
          return
        }
        await pauseAutoRun(key, 'budget-exhausted')
        const workflow = await loadWorkflow(key)
        if (workflow) {
          const gate = taskLaunchDecision(observeWorkflowTask(ctx as unknown as TaskOwnershipContext, workflow))
          if (!gate.allowed && gate.running) liveTaskFor(gate.task)?.process?.kill()
        }
      })()
    },
    Math.min(delay, 2_147_483_647),
  )
  timer.unref?.()
  deadlineTimers.set(key, timer)
}

async function applyDecision(ctx: Context, key: string, decision: AutoRunDecision): Promise<void> {
  if (decision.kind === 'manual') return
  if (decision.kind === 'wait') {
    const workflow = await loadWorkflow(key)
    if (workflow?.autoRun?.status === 'running') scheduleObservation(ctx, key, workflow.autoRun.deadline)
    return
  }
  if (decision.kind === 'pause') {
    await pauseAutoRun(key, decision.reason)
    return
  }
  if (decision.kind === 'complete') {
    await completeAutoRun(key)
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
    await pauseAutoRun(key, autoRunFailureReason(decision.action, result), {
      action: decision.action,
      error: result.error,
    })
    return
  }
  if (decision.action === 'create-pr' || decision.action === 'sync') requestAutoRunReconcile(ctx, key)
}

async function reconcileOnce(ctx: Context, key: string, outcome?: AutoRunTaskOutcome): Promise<void> {
  clearObservation(key)
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  const [observed] = await enrichWorkflowStates(ctx, [workflow])
  if (!observed) return
  const decision = decideAutoRun({
    autoRun: workflow.autoRun,
    nextAction: observed.derived.nextAction,
    now: Date.now(),
    reviewEvents: workflow.events,
    ...(outcome ? { taskOutcome: outcome } : {}),
  })
  if (decision.kind !== 'manual') await persistDecision(key, decision)
  await applyDecision(ctx, key, decision)
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
        await reconcileOnce(ctx, key, nextOutcome)
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
      await pauseAutoRun(key, 'controller-error', {
        error: `${error instanceof Error ? error.message : String(error)}`,
      })
    } finally {
      running.delete(key)
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
  armDeadline(ctx, key, ensured.workflow.autoRun.deadline)
  requestAutoRunReconcile(ctx, key)
  return { ok: true, workflowKey: key }
}

export async function pauseOrphanedAutoRuns(
  ctx: Context,
  workflows: readonly (IssueWorkflow & { autoRun?: AutoRunState })[],
): Promise<void> {
  for (const candidate of workflows) {
    if (candidate.autoRun?.status !== 'running' || running.has(candidate.key) || observationTimers.has(candidate.key)) {
      continue
    }
    const ownership = observeWorkflowTask(ctx as unknown as TaskOwnershipContext, candidate)
    logTaskDiagnostic('auto-run-ownership-observed', {
      workflowKey: candidate.key,
      step: candidate.autoRun.step ?? 0,
      updatedAt: candidate.updatedAt,
      ownership,
      devTaskId: candidate.devTaskId,
      reviewTaskId: candidate.reviewTaskId,
      liveTaskKeys: [...liveTasks.entries()].filter(([, task]) => !task.closed).map(([taskId]) => taskId),
      trigger: 'state-refresh',
    })
    if (ownership.state === 'interrupted') {
      await pauseAutoRun(candidate.key, 'session-interrupted')
      continue
    }
    requestAutoRunReconcile(ctx, candidate.key)
  }
}
