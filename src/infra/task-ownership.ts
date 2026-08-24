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
  list?(): HostJobSnapshot[]
}

export interface TaskOwnershipContext {
  jobs?: HostJobsReader
}

export type TaskOwnership =
  | { state: 'none'; startedAt: null; source: 'not-in-flight' }
  | {
      state: 'running'
      startedAt: number
      source: 'local-map' | 'host-registry'
      kind: 'dev' | 'review'
      taskId: string
    }
  | {
      state: 'unknown'
      startedAt: null
      source: 'no-proof' | 'registry-error'
      kind: 'dev' | 'review'
      taskId: string
    }
  | {
      state: 'interrupted'
      startedAt: number | null
      source: 'explicit-outcome' | 'host-terminal'
      kind: 'dev' | 'review'
      taskId: string
    }

export type TaskLaunchDecision = { allowed: true } | { allowed: false; running: boolean; error: string }

type OwnershipFields = Pick<
  IssueWorkflow,
  'key' | 'stage' | 'devTaskId' | 'reviewTaskId' | 'devHostJobId' | 'reviewHostJobId'
> & { devInterrupted?: boolean }

interface TaskRef {
  kind: 'dev' | 'review'
  taskId: string
  hostJobId: string | null | undefined
}

function taskRefs(workflow: OwnershipFields): TaskRef[] {
  return [
    ...(workflow.devTaskId
      ? [{ kind: 'dev' as const, taskId: workflow.devTaskId, hostJobId: workflow.devHostJobId }]
      : []),
    ...(workflow.reviewTaskId
      ? [{ kind: 'review' as const, taskId: workflow.reviewTaskId, hostJobId: workflow.reviewHostJobId }]
      : []),
  ]
}

function expectedTask(workflow: OwnershipFields): TaskRef | null {
  const kind = workflow.stage === 'developing' ? 'dev' : workflow.stage === 'reviewing' ? 'review' : null
  return kind === null ? null : (taskRefs(workflow).find((task) => task.kind === kind) ?? null)
}

function taskSequence(taskId: string): number {
  const value = Number(taskId.match(/^[a-z]+-(\d+)-/)?.[1])
  return Number.isSafeInteger(value) ? value : 0
}

/** Selects which persisted task reference is current; its timestamp is never treated as liveness proof. */
function currentTask(workflow: OwnershipFields, tasks: TaskRef[]): TaskRef | null {
  const expected = expectedTask(workflow)
  if (expected) return expected
  return tasks.reduce<TaskRef | null>((latest, task) => {
    if (!latest) return task
    return taskSequence(task.taskId) >= taskSequence(latest.taskId) ? task : latest
  }, null)
}

function expectedLabel(workflow: OwnershipFields, task: TaskRef): string {
  return `clickvibe:${workflow.key}:${task.kind}:${task.taskId}`
}

function isActive(snapshot: HostJobSnapshot): boolean {
  return snapshot.status === 'running' || snapshot.status === 'stopping'
}

/** Observe ownership independently of the workflow stage, which may advance before task settlement. */
export function observeTaskOwnership(
  ctx: TaskOwnershipContext,
  workflow: OwnershipFields,
  localTaskRunning: (taskId: string) => boolean,
  localStartedAt?: (taskId: string) => number | null,
): TaskOwnership {
  const tasks = taskRefs(workflow)
  const current = currentTask(workflow, tasks)
  const orderedTasks = current ? [current, ...tasks.filter((task) => task.taskId !== current.taskId)] : tasks
  for (const task of orderedTasks) {
    if (localTaskRunning(task.taskId)) {
      return {
        state: 'running',
        startedAt: localStartedAt?.(task.taskId) ?? Date.now(),
        source: 'local-map',
        kind: task.kind,
        taskId: task.taskId,
      }
    }
  }

  const snapshots = new Map<string, HostJobSnapshot>()
  let registryFailed = false
  if (ctx.jobs) {
    let listed: HostJobSnapshot[] | null = null
    if (ctx.jobs.list) {
      try {
        listed = ctx.jobs.list()
      } catch {
        registryFailed = true
      }
    }
    for (const task of orderedTasks) {
      let snapshot = listed?.find((job) => job.label === expectedLabel(workflow, task)) ?? null
      if (!snapshot && task.hostJobId) {
        try {
          snapshot = ctx.jobs.get(task.hostJobId)
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (!/unknown|not found|不存在/i.test(message)) registryFailed = true
        }
      }
      if (snapshot && snapshot.label === expectedLabel(workflow, task)) {
        snapshots.set(task.taskId, snapshot)
        if (isActive(snapshot)) {
          return {
            state: 'running',
            startedAt: snapshot.startedAt,
            source: 'host-registry',
            kind: task.kind,
            taskId: task.taskId,
          }
        }
      }
    }
  }

  if (registryFailed && current) {
    return {
      state: 'unknown',
      startedAt: null,
      source: 'registry-error',
      kind: current.kind,
      taskId: current.taskId,
    }
  }
  const expected = expectedTask(workflow)
  if (workflow.stage === 'developing' && workflow.devInterrupted && expected) {
    return {
      state: 'interrupted',
      startedAt: null,
      source: 'explicit-outcome',
      kind: expected.kind,
      taskId: expected.taskId,
    }
  }
  if (!expected) return { state: 'none', startedAt: null, source: 'not-in-flight' }
  if (!ctx.jobs) {
    return {
      state: 'unknown',
      startedAt: null,
      source: 'no-proof',
      kind: expected.kind,
      taskId: expected.taskId,
    }
  }

  const snapshot = snapshots.get(expected.taskId)
  if (snapshot) {
    return {
      state: 'interrupted',
      startedAt: snapshot.startedAt,
      source: 'host-terminal',
      kind: expected.kind,
      taskId: expected.taskId,
    }
  }
  return {
    state: 'unknown',
    startedAt: null,
    source: 'no-proof',
    kind: expected.kind,
    taskId: expected.taskId,
  }
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
