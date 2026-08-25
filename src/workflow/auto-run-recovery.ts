import type { Context } from '@deepseek-ai/cordis'
import { isGithubRateLimitError, recoveryLabel } from '../github/rest.ts'
import type { AutoRunControllerRecovery } from '../infra/contracts.ts'
import {
  armAutoRunDeadline,
  autoRunWakePending,
  clearAutoRunSchedule,
  scheduleAutoRunWake,
  scheduleAutoRunWakeAt,
  type AutoRunWake,
} from '../infra/auto-run-scheduler.ts'
import { liveTasks } from '../infra/runtime.ts'
import {
  appendEvent,
  type AutoRunPausedReason,
  commitWorkflowMetadata,
  type IssueWorkflow,
  loadWorkflow,
  workflowRevision,
} from '../infra/state.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { observeWorkflowTask, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import {
  AUTO_RUN_WATCHDOG_COOLDOWN_MS,
  AUTO_RUN_WATCHDOG_NOTE,
  AUTO_RUN_BASE_RETRY_MS,
  controllerFailureEvidence,
  decideAutoRunWatchdog,
  nextControllerFailure,
  type ControllerFailureAttempt,
} from './auto-run-recovery-policy.ts'
import { autoRunRetryDelay } from './auto-run-policy.ts'

const failureAttemptsSymbol = Symbol.for('clickvibe.auto-run-failure-attempts')
const failureAttemptsRoot = globalThis as unknown as Record<PropertyKey, unknown>
const failureAttempts =
  (failureAttemptsRoot[failureAttemptsSymbol] as Map<string, ControllerFailureAttempt> | undefined) ?? new Map()
failureAttemptsRoot[failureAttemptsSymbol] = failureAttempts
const RATE_RETRY_BUFFER_MS = 2_000

export { armAutoRunDeadline, autoRunWakePending }
export type { AutoRunWake }

export class AutoRunControllerError extends Error {
  readonly source: string

  constructor(source: string, message: string) {
    super(message)
    this.name = 'AutoRunControllerError'
    this.source = source
  }
}

export function clearAutoRunTimers(key: string): void {
  clearAutoRunSchedule(key)
  failureAttempts.delete(key)
}

export function scheduleAutoRunObservation(ctx: Context, key: string, deadline: string, wake: AutoRunWake): void {
  const delay = autoRunRetryDelay(Date.now(), Date.parse(deadline))
  if (delay !== null) scheduleAutoRunWake(ctx, key, Date.now() + delay, deadline, wake)
}

interface PauseEvidence {
  action?: string
  error?: string
  note?: string
}

async function pauseLoaded(
  workflow: IssueWorkflow,
  reason: AutoRunPausedReason,
  evidence?: PauseEvidence,
  ctx?: Context,
): Promise<void> {
  if (!workflow.autoRun) return
  const canTransition =
    workflow.autoRun.status === 'running' ||
    (workflow.autoRun.status === 'paused' &&
      workflow.autoRun.pausedReason === 'controller-error' &&
      (reason === 'budget-exhausted' || reason === 'session-interrupted' || reason === 'task-timeout'))
  if (!canTransition) return
  const evidenceNote = evidence
    ? `(${[
        evidence.action ? `动作 ${evidence.action}` : null,
        evidence.error ? `错误: ${evidence.error.slice(0, 200)}` : null,
        evidence.note ?? null,
      ]
        .filter(Boolean)
        .join(' · ')})`
    : ''
  logTaskDiagnostic('auto-run-pause', {
    reason,
    ...(evidence ? { action: evidence.action ?? null, error: evidence.error?.slice(0, 500) ?? null } : {}),
    workflowKey: workflow.key,
    step: workflow.autoRun.step ?? 0,
    updatedAt: workflow.updatedAt,
    devTaskId: workflow.devTaskId,
    reviewTaskId: workflow.reviewTaskId,
    liveTaskKeys: [...liveTasks.entries()].filter(([, task]) => !task.closed).map(([taskId]) => taskId),
  })
  workflow.autoRun.status = 'paused'
  workflow.autoRun.pausedReason = reason
  workflow.autoRun.lastObservedAt = new Date().toISOString()
  if (reason === 'budget-exhausted' && ctx) stopBudgetTask(ctx, workflow)
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
  if (reason !== 'controller-error') clearAutoRunSchedule(workflow.key)
}

export async function pauseAutoRun(
  key: string,
  reason: AutoRunPausedReason,
  evidence?: PauseEvidence,
  ctx?: Context,
): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (workflow) await pauseLoaded(workflow, reason, evidence, ctx)
}

export async function completeAutoRun(key: string, note = '自动跑到底已收敛,等待人工合并'): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') return
  workflow.autoRun.status = 'completed'
  workflow.autoRun.pausedReason = null
  delete workflow.autoRun.controllerRecovery
  await appendEvent(
    workflow,
    {
      kind: 'auto-run',
      at: new Date().toISOString(),
      round: workflow.autoRun.rounds,
      step: workflow.autoRun.step,
      note,
    },
    workflowRevision(workflow) ?? 0,
  )
  clearAutoRunTimers(key)
}

function persistedAttempt(workflow: IssueWorkflow, evidence: ReturnType<typeof controllerFailureEvidence>) {
  const saved = workflow.autoRun?.controllerRecovery
  if (!saved) return null
  return {
    ...evidence,
    attempt: saved.attempt,
    consecutive: saved.consecutive,
    fingerprint: saved.fingerprint,
    delayMs: Math.max(0, Date.parse(saved.retryAt) - Date.parse(saved.lastFailureAt)),
    retryAt: Date.parse(saved.retryAt),
    fused: saved.kind === 'fused',
  }
}

function recoveryState(
  attempt: ControllerFailureAttempt,
  kind: AutoRunControllerRecovery['kind'],
  retryAt = attempt.retryAt,
  failedAt = Date.now(),
): AutoRunControllerRecovery {
  return {
    kind,
    attempt: attempt.attempt,
    consecutive: attempt.consecutive,
    fingerprint: attempt.fingerprint,
    retryAt: new Date(retryAt).toISOString(),
    lastFailureAt: new Date(failedAt).toISOString(),
  }
}

async function persistRecovery(workflow: IssueWorkflow, recovery: AutoRunControllerRecovery): Promise<void> {
  if (!workflow.autoRun) return
  workflow.autoRun.controllerRecovery = recovery
  try {
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), { autoRun: workflow.autoRun }),
    )
  } catch (error) {
    logTaskDiagnostic('auto-run-recovery-persist-error', {
      workflowKey: workflow.key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

function safeOwnership(ctx: Context, workflow: IssueWorkflow): ReturnType<typeof observeWorkflowTask> {
  try {
    return observeWorkflowTask(ctx as unknown as TaskOwnershipContext, workflow)
  } catch {
    const taskId = workflow.stage === 'reviewing' ? workflow.reviewTaskId : workflow.devTaskId
    const kind = workflow.stage === 'reviewing' ? 'review' : 'dev'
    return taskId
      ? { state: 'unknown', startedAt: null, source: 'registry-error', kind, taskId }
      : { state: 'none', startedAt: null, source: 'not-in-flight' }
  }
}

function stopBudgetTask(ctx: Context, workflow: IssueWorkflow): void {
  const ownership = safeOwnership(ctx, workflow)
  if (ownership.state !== 'running') {
    logTaskDiagnostic('auto-run-budget-task-stop', {
      workflowKey: workflow.key,
      ownershipState: ownership.state,
      stopped: false,
    })
    return
  }
  const local = liveTasks.get(ownership.taskId)
  if (local && !local.closed) {
    local.process?.kill()
    logTaskDiagnostic('auto-run-budget-task-stop', {
      workflowKey: workflow.key,
      ownershipState: ownership.state,
      taskId: ownership.taskId,
      stopped: true,
      source: 'local-map',
    })
    return
  }
  const hostJobId = ownership.kind === 'dev' ? workflow.devHostJobId : workflow.reviewHostJobId
  const jobs = (ctx as unknown as { jobs?: { kill?: (id: string, caller?: unknown, reason?: string) => unknown } }).jobs
  const stopped = Boolean(hostJobId && jobs?.kill && jobs.kill(hostJobId, undefined, 'auto-run budget exhausted'))
  logTaskDiagnostic('auto-run-budget-task-stop', {
    workflowKey: workflow.key,
    ownershipState: ownership.state,
    taskId: ownership.taskId,
    hostJobId: hostJobId ?? null,
    stopped,
    source: 'host-registry',
  })
}

async function pauseOrRetry(
  ctx: Context,
  workflow: IssueWorkflow,
  reason: AutoRunPausedReason,
  wake: AutoRunWake,
  evidence?: PauseEvidence,
): Promise<boolean> {
  try {
    await pauseLoaded(workflow, reason, evidence, ctx)
    return true
  } catch (error) {
    logTaskDiagnostic('auto-run-pause-persist-error', {
      workflowKey: workflow.key,
      reason,
      error: error instanceof Error ? error.message : String(error),
    })
    scheduleAutoRunWakeAt(ctx, workflow.key, Date.now() + AUTO_RUN_BASE_RETRY_MS, wake)
    return false
  }
}

export async function handleAutoRunControllerFailure(
  ctx: Context,
  key: string,
  error: unknown,
  source: string,
  wake: AutoRunWake,
): Promise<void> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun || workflow.autoRun.status !== 'running') {
    if (!workflow) {
      logTaskDiagnostic('auto-run-state-unavailable', {
        workflowKey: key,
        source,
        retryInMs: AUTO_RUN_BASE_RETRY_MS,
      })
      scheduleAutoRunWakeAt(ctx, key, Date.now() + AUTO_RUN_BASE_RETRY_MS, wake)
    }
    return
  }
  const now = Date.now()
  if (now >= Date.parse(workflow.autoRun.deadline)) {
    await pauseOrRetry(ctx, workflow, 'budget-exhausted', wake)
    return
  }
  if (isGithubRateLimitError(error)) {
    const retryAt = error.resetAt + RATE_RETRY_BUFFER_MS
    const evidence = controllerFailureEvidence(error)
    const previous = failureAttempts.get(key) ?? persistedAttempt(workflow, evidence)
    const attempt = nextControllerFailure(previous, evidence, now, Math.random())
    failureAttempts.set(key, attempt)
    workflow.autoRun.controllerRecovery = recoveryState(attempt, 'rate-limit', retryAt, now)
    logTaskDiagnostic('auto-run-rate-deferred', {
      workflowKey: key,
      retryAt: new Date(retryAt).toISOString(),
      resetAt: new Date(error.resetAt).toISOString(),
      source,
      delayMs: Math.max(0, retryAt - now),
      kind: error.kind,
      attempt: attempt.attempt,
    })
    try {
      await appendEvent(
        workflow,
        {
          kind: 'auto-run',
          at: new Date(now).toISOString(),
          round: workflow.autoRun.rounds,
          step: workflow.autoRun.step,
          note: `自动跑到底遇 GitHub 限流(${source}),自动等待至 ${recoveryLabel(retryAt)} 重试(不暂停)`,
        },
        workflowRevision(workflow) ?? 0,
      )
    } catch (persistError) {
      logTaskDiagnostic('auto-run-recovery-persist-error', {
        workflowKey: key,
        source,
        error: persistError instanceof Error ? persistError.message : String(persistError),
      })
    }
    scheduleAutoRunWake(ctx, key, retryAt, workflow.autoRun.deadline, wake)
    return
  }

  const evidence = controllerFailureEvidence(error)
  const previous = failureAttempts.get(key) ?? persistedAttempt(workflow, evidence)
  const attempt = nextControllerFailure(previous, evidence, now, Math.random())
  const ownership = safeOwnership(ctx, workflow)
  failureAttempts.set(
    key,
    ownership.state === 'running' || ownership.state === 'unknown'
      ? { ...attempt, fingerprint: `ownership-barrier:${attempt.fingerprint}`, consecutive: 0, fused: false }
      : attempt,
  )
  const retryAt = attempt.fused && ownership.state === 'none' ? now + AUTO_RUN_WATCHDOG_COOLDOWN_MS : attempt.retryAt
  const diagnostic = {
    workflowKey: key,
    source,
    ownershipState: ownership.state,
    errorName: attempt.name,
    errorMessage: attempt.message,
    errorStack: attempt.stack,
    attempt: attempt.attempt,
    consecutive: attempt.consecutive,
    fingerprint: attempt.fingerprint,
    retryAt: new Date(retryAt).toISOString(),
  }
  if (ownership.state === 'interrupted') {
    await pauseOrRetry(ctx, workflow, 'session-interrupted', wake, { error: attempt.message })
    return
  }
  if (attempt.fused && ownership.state === 'none') {
    workflow.autoRun.controllerRecovery = recoveryState(attempt, 'fused', retryAt, now)
    logTaskDiagnostic('auto-run-controller-fuse', {
      ...diagnostic,
      basis: `same-stack fingerprint ${attempt.fingerprint} consecutive ${attempt.consecutive} >= 3`,
    })
    const paused = await pauseOrRetry(ctx, workflow, 'controller-error', wake, {
      error: attempt.message,
      note: `相同错误栈连续 ${attempt.consecutive} 次触发熔断;fingerprint=${attempt.fingerprint}`,
    })
    armAutoRunDeadline(ctx, key, workflow.autoRun.deadline, wake)
    scheduleAutoRunWake(ctx, key, paused ? retryAt : now + AUTO_RUN_BASE_RETRY_MS, workflow.autoRun.deadline, wake)
    return
  }

  logTaskDiagnostic('auto-run-controller-retry', diagnostic)
  if (ownership.state === 'none')
    await persistRecovery(workflow, recoveryState(attempt, 'transient', attempt.retryAt, now))
  scheduleAutoRunWake(ctx, key, attempt.retryAt, workflow.autoRun.deadline, wake)
}

export async function clearAutoRunControllerFailure(key: string): Promise<void> {
  failureAttempts.delete(key)
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun?.controllerRecovery || workflow.autoRun.status !== 'running') return
  delete workflow.autoRun.controllerRecovery
  try {
    await commitWorkflowMetadata(workflow, workflowRevision(workflow), { autoRun: workflow.autoRun })
  } catch (error) {
    logTaskDiagnostic('auto-run-recovery-clear-error', {
      workflowKey: key,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

export async function maintainPausedAutoRun(
  ctx: Context,
  key: string,
  wake: AutoRunWake,
): Promise<'handled' | 'reattached'> {
  const workflow = await loadWorkflow(key)
  if (!workflow?.autoRun) return 'handled'
  const ownership = safeOwnership(ctx, workflow)
  const decision = decideAutoRunWatchdog(workflow.autoRun, workflow.events, ownership.state, Date.now())
  if (decision.kind === 'none') return 'handled'
  if (decision.kind === 'budget-exhausted') {
    await pauseOrRetry(ctx, workflow, 'budget-exhausted', wake)
    return 'handled'
  }
  if (decision.kind === 'session-interrupted') {
    await pauseOrRetry(ctx, workflow, 'session-interrupted', wake)
    return 'handled'
  }
  if (decision.kind === 'wait') {
    logTaskDiagnostic('auto-run-watchdog-wait', {
      workflowKey: key,
      reason: decision.reason,
      ownershipState: ownership.state,
      retryAt: new Date(decision.retryAt).toISOString(),
    })
    armAutoRunDeadline(ctx, key, workflow.autoRun.deadline, wake)
    scheduleAutoRunWake(ctx, key, decision.retryAt, workflow.autoRun.deadline, wake)
    return 'handled'
  }
  workflow.autoRun.status = 'running'
  workflow.autoRun.pausedReason = null
  workflow.autoRun.lastObservedAt = new Date().toISOString()
  delete workflow.autoRun.controllerRecovery
  failureAttempts.delete(key)
  try {
    await appendEvent(
      workflow,
      {
        kind: 'auto-run',
        at: new Date().toISOString(),
        round: workflow.autoRun.rounds,
        step: workflow.autoRun.step,
        note: AUTO_RUN_WATCHDOG_NOTE,
      },
      workflowRevision(workflow) ?? 0,
    )
  } catch (error) {
    logTaskDiagnostic('auto-run-watchdog-persist-error', {
      workflowKey: key,
      error: error instanceof Error ? error.message : String(error),
    })
    scheduleAutoRunWakeAt(ctx, key, Date.now() + AUTO_RUN_BASE_RETRY_MS, wake)
    return 'handled'
  }
  logTaskDiagnostic('auto-run-watchdog-reattach', {
    workflowKey: key,
    ownershipState: ownership.state,
    deadline: workflow.autoRun.deadline,
  })
  armAutoRunDeadline(ctx, key, workflow.autoRun.deadline, wake)
  return 'reattached'
}
