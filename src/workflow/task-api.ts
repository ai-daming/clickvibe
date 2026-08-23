import type { IncomingMessage, ServerResponse } from 'node:http'
import { finishTask, pushTaskLine } from '../agent/task-supervisor.ts'
import { decodeLiveLogLine, type LiveLogEvent } from '../infra/live-output.ts'
import { type LiveTask, liveTasks, liveWaiters } from '../infra/runtime.ts'
import {
  findTaskHistory,
  findWorkflowByIssue,
  type IssueWorkflow,
  loadWorkflow,
  readTaskLog,
  saveWorkflow,
} from '../infra/state.ts'
import type { TaskMetrics } from '../infra/task-log-store.ts'

/** Consume incremental dev log/status for one task. */
export async function pollDevelop(payload: unknown): Promise<
  | {
      ok: true
      taskId: string
      status: string
      exitCode: number | null
      cursor: number
      delta: string[]
      truncated: boolean
      done: boolean
    }
  | { ok: false; error: string }
> {
  const taskId = String((payload as { taskId?: unknown } | undefined)?.taskId ?? '')
  const cursor = Number((payload as { cursor?: unknown } | undefined)?.cursor ?? 0)
  const live = liveTasks.get(taskId)
  if (!live) {
    return { ok: false, error: `未知任务 ${taskId}` }
  }
  const read = live.log.read(cursor)
  const decoded = read.lines.map(decodeLiveLogLine)
  return {
    ok: true,
    taskId,
    status: live.status,
    exitCode: live.exitCode,
    cursor: read.cursor,
    delta: decoded.map((event) => event.text),
    truncated: read.truncated,
    done: live.closed,
  }
}

export type HistoryKind = 'dev' | 'review'

export async function resolveHistoryTarget(
  taskIdValue: string,
  requestedKey: string,
  requestedKind: string,
): Promise<{
  taskId: string | null
  key: string
  kind: HistoryKind
  live: LiveTask | null
  workflow: IssueWorkflow
} | null> {
  if (taskIdValue !== '') {
    const live = liveTasks.get(taskIdValue) ?? null
    if (live) return { taskId: taskIdValue, key: live.workflowKey, kind: live.kind, live, workflow: live.workflow }
    const stored = await findTaskHistory(taskIdValue)
    if (!stored) return null
    return { taskId: taskIdValue, key: stored.workflow.key, kind: stored.kind, live: null, workflow: stored.workflow }
  }
  if (!/^[A-Za-z0-9_.-]+$/.test(requestedKey)) return null
  if (requestedKind !== 'dev' && requestedKind !== 'review') return null
  const workflow = await loadWorkflow(requestedKey)
  if (!workflow) return null
  const storedTaskId = requestedKind === 'dev' ? workflow.devTaskId : workflow.reviewTaskId
  const live = storedTaskId ? (liveTasks.get(storedTaskId) ?? null) : null
  return { taskId: storedTaskId, key: requestedKey, kind: requestedKind, live, workflow }
}

/** Complete disk history plus the exact cursor where SSE increments begin. */
export async function getTaskHistory(req: IncomingMessage): Promise<
  | {
      ok: true
      taskId: string | null
      key: string
      kind: HistoryKind
      lines: string[]
      events: LiveLogEvent[]
      cursor: number
      active: boolean
      metrics: TaskMetrics
    }
  | { ok: false; error: string }
> {
  const url = new URL(req.url ?? '/', 'http://clickvibe.internal')
  const taskIdValue = url.searchParams.get('taskId')?.trim() ?? url.searchParams.get('round')?.trim() ?? ''
  let requestedKey = url.searchParams.get('key')?.trim() ?? ''
  const owner = url.searchParams.get('owner')?.trim() ?? ''
  const repo = url.searchParams.get('repo')?.trim() ?? ''
  const issue = url.searchParams.get('issue')?.trim() ?? ''
  if (requestedKey === '' && taskIdValue === '') {
    const workflow = await findWorkflowByIssue(`${owner}/${repo}`, issue)
    if (workflow) requestedKey = workflow.key
  }
  const target = await resolveHistoryTarget(taskIdValue, requestedKey, url.searchParams.get('kind')?.trim() ?? '')
  if (!target) return { ok: false, error: '找不到对应任务历史' }
  if (owner !== '' || repo !== '' || issue !== '') {
    const targetIssue = target.workflow.url.match(/\/(?:issues|pull)\/(\d+)(?:[/?#]|$)/)?.[1]
    if (`${owner}/${repo}` !== target.workflow.repoKey || issue !== targetIssue) {
      return { ok: false, error: '找不到对应任务历史' }
    }
  }

  // Capture the live sequence before enqueueing the ordered disk read. No
  // await may occur between these operations: that is the history/SSE fence.
  const cursor = target.live?.log.read(Number.MAX_SAFE_INTEGER).cursor ?? 0
  const history = target.taskId
    ? await readTaskLog(target.workflow, target.kind, target.taskId)
    : {
        encodedLines: [],
        events: [],
        lines: [],
        metrics: { startedAt: null, endedAt: null, durationMs: null, status: null, exitCode: null },
      }
  const events = history.events
  return {
    ok: true,
    taskId: target.taskId,
    key: target.key,
    kind: target.kind,
    lines: history.lines,
    events,
    cursor,
    active: target.live !== null && !target.live.closed,
    metrics: history.metrics,
  }
}

/** SSE live stream: pushes parsed status lines for a task as they arrive. */
export function handleStream(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://clickvibe.internal')
  const taskId = url.searchParams.get('taskId') ?? ''
  const live = liveTasks.get(taskId)
  if (!live) {
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: `未知任务 ${taskId}` }))
    return
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'x-accel-buffering': 'no',
    connection: 'keep-alive',
  })

  const lastEventId = Array.isArray(req.headers['last-event-id'])
    ? req.headers['last-event-id'][0]
    : req.headers['last-event-id']
  const parseCursor = (value: string | undefined | null): number => {
    const parsed = Number(value ?? 0)
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0
  }
  let cursor = Math.max(parseCursor(url.searchParams.get('cursor')), parseCursor(lastEventId))
  let closed = false
  let heartbeat: ReturnType<typeof setInterval> | undefined

  const close = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    res.end()
  }

  const flush = () => {
    if (closed) return
    const read = live.log.readDetailed(cursor)
    if (read.truncated) {
      res.write(`data: ${JSON.stringify({ __historyRequired: true })}\n\n`)
      close()
      return
    }
    cursor = read.cursor
    for (const entry of read.entries) {
      const event = decodeLiveLogLine(entry.line)
      res.write(
        `id: ${entry.sequence}\ndata: ${JSON.stringify({ line: event.text, event, cursor: entry.sequence })}\n\n`,
      )
    }
    if (live.closed) {
      res.write(`data: ${JSON.stringify({ __done: true })}\n\n`)
      close()
    }
  }

  flush()
  if (!closed) {
    const wake = () => flush()
    const waiters = liveWaiters.get(taskId) ?? new Set<() => void>()
    waiters.add(wake)
    liveWaiters.set(taskId, waiters)
    heartbeat = setInterval(() => {
      if (!closed) res.write(': keep-alive\n\n')
    }, 15_000)
    heartbeat.unref?.()
    req.on('close', () => {
      waiters.delete(wake)
      if (waiters.size === 0) liveWaiters.delete(taskId)
      if (heartbeat) clearInterval(heartbeat)
      closed = true
    })
  }
}

export function stopTask(
  payload: unknown,
): { ok: true; taskId: string; stopped: boolean } | { ok: false; error: string } {
  const taskId = String((payload as { taskId?: unknown } | undefined)?.taskId ?? '')
  const task = liveTasks.get(taskId)
  if (!task) return { ok: false, error: `未知任务 ${taskId}` }
  if (task.closed) return { ok: true, taskId, stopped: false }
  pushTaskLine(task, '[clickvibe] 用户请求停止任务')
  task.status = 'stopped'
  const stopped = task.process?.kill() ?? false
  if (!task.process) finishTask(task, 'stopped', null)
  void (async () => {
    const workflow = await loadWorkflow(task.workflowKey)
    if (!workflow) return
    if (task.kind === 'dev') {
      workflow.stage = 'developing'
      workflow.devInterrupted = true
    } else {
      workflow.stage = 'review-ready'
    }
    await saveWorkflow(workflow)
  })()
  return { ok: true, taskId, stopped }
}
