import type { IssueWorkflow } from './state.ts'
import { liveTasks } from './runtime.ts'

export interface HostJobSnapshot {
  id: string
  kind: string
  label: string
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed'
  startedAt: number
}

export interface HostJobsReader {
  get(id: string): HostJobSnapshot
}

export interface TaskOwnershipContext {
  jobs?: HostJobsReader
}

export type TaskOwnership =
  | { state: 'none'; startedAt: null; source: 'not-in-flight' }
  | { state: 'running'; startedAt: number; source: 'local-map' | 'host-registry' }
  | { state: 'unknown'; startedAt: null; source: 'no-proof' | 'registry-error' }
  | { state: 'interrupted'; startedAt: number | null; source: 'host-terminal' | 'registry-restarted' }

export type TaskLaunchDecision = { allowed: true } | { allowed: false; running: boolean; error: string }

type OwnershipFields = Pick<
  IssueWorkflow,
  'key' | 'stage' | 'devTaskId' | 'reviewTaskId' | 'devHostJobId' | 'reviewHostJobId'
>

function activeTask(workflow: OwnershipFields): { taskId: string | null; hostJobId: string | null | undefined } | null {
  if (workflow.stage === 'developing') {
    return { taskId: workflow.devTaskId, hostJobId: workflow.devHostJobId }
  }
  if (workflow.stage === 'reviewing') {
    return { taskId: workflow.reviewTaskId, hostJobId: workflow.reviewHostJobId }
  }
  return null
}

function expectedLabel(workflow: OwnershipFields, taskId: string): string {
  return `clickvibe:${workflow.key}:${workflow.stage === 'reviewing' ? 'review' : 'dev'}:${taskId}`
}

/** Observe task ownership without treating controller-local absence as death. */
export function observeTaskOwnership(
  ctx: TaskOwnershipContext,
  workflow: OwnershipFields,
  localTaskRunning: (taskId: string) => boolean,
  localStartedAt?: (taskId: string) => number | null,
): TaskOwnership {
  const active = activeTask(workflow)
  if (!active) return { state: 'none', startedAt: null, source: 'not-in-flight' }
  if (active.taskId && localTaskRunning(active.taskId)) {
    return { state: 'running', startedAt: localStartedAt?.(active.taskId) ?? Date.now(), source: 'local-map' }
  }
  if (!active.taskId || !active.hostJobId || !ctx.jobs) {
    return { state: 'unknown', startedAt: null, source: 'no-proof' }
  }
  let snapshot: HostJobSnapshot
  try {
    snapshot = ctx.jobs.get(active.hostJobId)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return /unknown|not found|不存在/i.test(message)
      ? { state: 'interrupted', startedAt: null, source: 'registry-restarted' }
      : { state: 'unknown', startedAt: null, source: 'registry-error' }
  }
  if (snapshot.label !== expectedLabel(workflow, active.taskId)) {
    return { state: 'interrupted', startedAt: snapshot.startedAt, source: 'registry-restarted' }
  }
  if (snapshot.status === 'running' || snapshot.status === 'stopping') {
    return { state: 'running', startedAt: snapshot.startedAt, source: 'host-registry' }
  }
  return { state: 'interrupted', startedAt: snapshot.startedAt, source: 'host-terminal' }
}

export function taskLaunchDecision(ownership: TaskOwnership): TaskLaunchDecision {
  if (ownership.state === 'running') {
    return { allowed: false, running: true, error: '该 issue 当前有任务运行,请等待或停止后再试' }
  }
  if (ownership.state === 'unknown') {
    return {
      allowed: false,
      running: false,
      error: '当前控制器无法确认旧任务生死,为避免双开已禁止启动;请先停止宿主任务或等待状态恢复',
    }
  }
  return { allowed: true }
}

export function observeWorkflowTask(ctx: TaskOwnershipContext, workflow: IssueWorkflow): TaskOwnership {
  return observeTaskOwnership(
    ctx,
    workflow,
    (taskId) => {
      const task = liveTasks.get(taskId)
      return task !== undefined && !task.closed
    },
    (taskId) => liveTasks.get(taskId)?.startedAt ?? null,
  )
}
