/**
 * clickvibe host half — routes:
 * - `/clickvibe/api/fetch`          — fetch GitHub issue/PR data via gh
 * - `/clickvibe/api/command`        — text-command entry (issue #13): conversation
 *                                      triggers reuse the same action handlers below
 * - `/clickvibe/api/state`          — restore panel context (all workflows)
 * - `/clickvibe/api/develop`        — start dev: worktree+branch+agent
 * - `/clickvibe/api/develop/poll`   — incremental dev log/status (JSON)
 * - `/clickvibe/api/history`        — complete disk-backed task history
 * - `/clickvibe/api/stream`         — SSE live status stream for a task
 * - `/clickvibe/api/review`         — review the dev branch with codex/claude
 * - `/clickvibe/api/resume`         — resume an interrupted dev session
 * - `/clickvibe/api/sync`           — sync the worktree with the remote base (issue #5)
 *
 * Workflow per issue (persisted under ~/.clickvibe/state/):
 *   developing → review-ready → reviewing → passed
 *                      ↑                  │
 *                      └── rework ────────┘
 */
import type { Context } from '@deepseek-ai/cordis'
import type { JobOutcome } from '@deepseek-ai/dsh-jobs'
import { type DevelopAgent, LineLog, shouldFallbackFromExactResume } from '../infra/develop-core.ts'
import { LineBuffer } from '../infra/line-buffer.ts'
import { encodeLiveLogEvent, type LiveLogEvent } from '../infra/live-output.ts'
import {
  type LiveTask,
  liveTasks,
  liveWaiters,
  MAX_TASKS,
  notifyTask,
  readHostSpillFile,
  resumeTaskGate,
  reviewTaskGate,
  TASK_LOG_LINES,
  TASK_RETENTION_MS,
  TASK_TIMEOUT_MS,
} from '../infra/runtime.ts'
import { appendTaskLog, type IssueWorkflow, startTaskLog } from '../infra/state.ts'
import { logTaskDiagnostic, waitForTaskDiagnosticPersistence } from '../infra/task-diagnostics.ts'
import {
  type AgentKind,
  lossyAgentOutputNotice,
  parseAgentChunk,
  recoverSpillLines,
  spillRecoveryNotice,
} from './agent-stream.ts'

declare module '@deepseek-ai/dsh-jobs' {
  interface JobKindMap {
    clickvibe: 'clickvibe'
  }
}

interface HostTaskReservation {
  hostJobId: string
  settle(status: LiveTask['status']): void
}

const hostReservations = new WeakMap<LiveTask, HostTaskReservation>()
const taskPersistence = new WeakMap<LiveTask, Promise<void>>()

function persistTask(task: LiveTask, operation: () => Promise<void>): void {
  const previous = taskPersistence.get(task) ?? Promise.resolve()
  const current = previous.then(operation, operation)
  taskPersistence.set(task, current)
}

/** Await all best-effort log writes scheduled for one live task before releasing its storage. */
export async function waitForTaskPersistence(task: LiveTask): Promise<void> {
  await Promise.all([
    taskPersistence.get(task)?.catch(() => undefined),
    waitForTaskDiagnosticPersistence(task.workflowKey),
  ])
}

function hostJobOutcome(task: LiveTask, status: LiveTask['status']): JobOutcome {
  if (status === 'done') return { status: 'completed', detail: `task ${task.taskId} completed` }
  if (status === 'stopped' || status === 'timed_out') {
    return { status: 'killed', detail: `task ${task.taskId} ${status}` }
  }
  return { status: 'failed', detail: `task ${task.taskId} ${status}` }
}

/** Atomically reserve one host-owned task before any prompt/snapshot await. */
export function reserveHostTask(
  ctx: Context,
  task: LiveTask,
): { created: true; hostJobId: string } | { created: false; taskId: string } {
  if (!ctx.jobs) throw new Error('宿主任务 registry 不可用,拒绝启动无所有权任务')
  const prefix = `clickvibe:${task.workflowKey}:`
  const existing = ctx.jobs
    .list()
    .find(
      (job) =>
        job.kind === 'clickvibe' &&
        (job.status === 'running' || job.status === 'stopping') &&
        job.label.startsWith(prefix),
    )
  if (existing) return { created: false, taskId: existing.label.slice(existing.label.lastIndexOf(':') + 1) }

  let resolveDone!: (outcome: JobOutcome) => void
  let settled = false
  const done = new Promise<JobOutcome>((resolve) => {
    resolveDone = resolve
  })
  const settle = (status: LiveTask['status']): void => {
    if (settled) return
    settled = true
    resolveDone(hostJobOutcome(task, status))
  }
  const hostJobId = ctx.jobs.start({
    kind: 'clickvibe',
    label: `${prefix}${task.kind}:${task.taskId}`,
    run: () => ({
      cancel: () => {
        if (task.closed) return
        task.status = 'stopped'
        if (task.process) task.process.kill()
        else {
          finishTask(task, 'stopped', null)
          settle('stopped')
        }
      },
      done,
    }),
  })
  if (hostJobId === null || hostJobId === undefined || String(hostJobId).trim() === '') {
    settle('failed')
    throw new Error('宿主任务 registry 返回空 hostJobId')
  }
  const reservation = { hostJobId: String(hostJobId), settle }
  hostReservations.set(task, reservation)
  logTaskDiagnostic('host-job-register', {
    taskId: task.taskId,
    workflowKey: task.workflowKey,
    kind: task.kind,
    hostJobId: reservation.hostJobId,
  })
  return { created: true, hostJobId: reservation.hostJobId }
}

/** Start (or restart) a dev task in the live map with status parsing. */
export function createLiveTask(
  taskId: string,
  workflow: IssueWorkflow,
  kind: LiveTask['kind'],
  agent: DevelopAgent,
  sessionId: string | null,
): LiveTask {
  for (const [id, task] of liveTasks) {
    if (liveTasks.size < MAX_TASKS) break
    if (task.closed) {
      if (task.cleanup) clearTimeout(task.cleanup)
      liveTasks.delete(id)
      liveWaiters.delete(id)
      logTaskDiagnostic('live-task-delete', {
        taskId: id,
        workflowKey: task.workflowKey,
        kind: task.kind,
        status: task.status,
        closed: task.closed,
        trigger: 'capacity-eviction',
      })
    }
  }
  if (liveTasks.size >= MAX_TASKS) throw new Error('运行中任务过多,请先停止或等待现有任务完成')
  const task: LiveTask = {
    taskId,
    workflowKey: workflow.key,
    workflow,
    kind,
    agent,
    startedAt: Date.now(),
    log: new LineLog(TASK_LOG_LINES),
    rawLog: new LineBuffer(),
    closed: false,
    status: 'running',
    exitCode: null,
    sessionId,
    workflowLease: null,
  }
  liveTasks.set(taskId, task)
  logTaskDiagnostic('live-task-set', { taskId, workflowKey: workflow.key, kind, status: task.status, closed: false })
  persistTask(task, () => startTaskLog(workflow, kind, taskId))
  pushTaskLine(task, '[clickvibe] 任务开始')
  return task
}

export function pushTaskLine(
  task: LiveTask,
  value: string | LiveLogEvent,
  completion?: { status: Exclude<LiveTask['status'], 'running'>; exitCode: number | null },
): void {
  const event: LiveLogEvent =
    typeof value === 'string'
      ? value.startsWith('[clickvibe]')
        ? { source: 'system', kind: 'system', text: value }
        : { source: 'agent', kind: 'text', text: value }
      : value
  const line = encodeLiveLogEvent(event)
  const sequence = task.log.appendLine(line)
  persistTask(task, () => appendTaskLog(task.workflow, task.kind, task.taskId, sequence, line, completion))
  notifyTask(task.taskId)
}

export function scheduleTaskCleanup(task: LiveTask): void {
  task.cleanup = setTimeout(() => {
    liveTasks.delete(task.taskId)
    liveWaiters.delete(task.taskId)
    logTaskDiagnostic('live-task-delete', {
      taskId: task.taskId,
      workflowKey: task.workflowKey,
      kind: task.kind,
      status: task.status,
      closed: task.closed,
      trigger: 'retention-expired',
    })
  }, TASK_RETENTION_MS)
  task.cleanup.unref?.()
}

export function finishTask(
  task: LiveTask,
  status: Exclude<LiveTask['status'], 'running'>,
  exitCode: number | null,
): void {
  if (task.closed) return
  task.status = status
  task.exitCode = exitCode
  pushTaskLine(task, `[clickvibe] 任务结束:${status},退出码 ${exitCode ?? '未知'}`, { status, exitCode })
  task.closed = true
  hostReservations.get(task)?.settle(status)
  logTaskDiagnostic('live-task-close', {
    taskId: task.taskId,
    workflowKey: task.workflowKey,
    kind: task.kind,
    status,
    closed: true,
    exitCode,
  })
  if (task.kind === 'review') reviewTaskGate.release(task.workflowKey, task)
  else resumeTaskGate.release(task.workflowKey, task)
  if (task.timeout) clearTimeout(task.timeout)
  notifyTask(task.taskId)
  scheduleTaskCleanup(task)
}

/**
 * Fill the gap the host's bounded streaming buffer dropped (lossy read): read
 * the byte-complete spill file, re-parse only the lines the live delta stream
 * never delivered, and append them to the task log before a closing notice.
 * Runs inline in the awaited drain so session ids hidden in the gap are
 * captured before settle decides resume fallbacks. Per-path in-flight guard
 * prevents concurrent duplicate recovery; content dedupe is keyed on the
 * delivered-line set, so later lossy reads of the same (grown) spill recover
 * only the still-missing lines.
 */
async function recoverLossyOutput(
  task: LiveTask,
  read: { stdoutSpillPath?: string; stderrSpillPath?: string },
  deliveredLines: ReadonlySet<string>,
  recoveredInFlight: Set<string>,
  onSessionId: (sessionId: string) => void,
): Promise<void> {
  const streams = [
    ['stdout', read.stdoutSpillPath],
    ['stderr', read.stderrSpillPath],
  ] as const
  for (const [label, spillPath] of streams) {
    if (!spillPath || recoveredInFlight.has(spillPath)) continue
    recoveredInFlight.add(spillPath)
    try {
      const missing = recoverSpillLines(await readHostSpillFile(spillPath), deliveredLines)
      if (missing.length === 0) continue
      const parsed = parseAgentChunk(task.agent as AgentKind, missing.join('\n'))
      if (parsed.lines.length === 0) continue
      for (const line of parsed.lines) {
        pushTaskLine(task, {
          source: 'agent',
          agent: task.agent as AgentKind,
          kind: line.kind,
          text: line.text,
          ...(line.usage ? { usage: line.usage } : {}),
        })
      }
      if (parsed.sessionId) onSessionId(parsed.sessionId)
      const notice = spillRecoveryNotice([label + ' ' + spillPath], missing.length)
      if (notice) pushTaskLine(task, notice)
    } catch (error) {
      pushTaskLine(
        task,
        '[clickvibe] 无法读取宿主 spill 文件 ' +
          spillPath +
          ': ' +
          String(error instanceof Error ? error.message : error),
      )
    } finally {
      recoveredInFlight.delete(spillPath)
    }
  }
}

export function attachAgentProcess(
  ctx: Context,
  task: LiveTask,
  command: string,
  workdir: string,
  prompt: string,
  onExit: (exitCode: number | null, sessionId: string | null) => void | Promise<void>,
  resumeFallback?: {
    staleSessionId: string
    prepare: () => Promise<{ command: string; prompt: string }>
  },
): string | null {
  let reserved = hostReservations.get(task) ?? null
  if (!reserved && ctx.jobs) {
    const reservation = reserveHostTask(ctx, task)
    if (!reservation.created) throw new Error(`该 workflow 已有宿主任务 ${reservation.taskId}`)
    reserved = hostReservations.get(task) ?? null
  }
  const settleHostJob = (status: LiveTask['status']): void => {
    reserved?.settle(status)
  }
  task.timeout = setTimeout(() => {
    if (task.closed) return
    pushTaskLine(task, `[clickvibe] Agent 超过 ${TASK_TIMEOUT_MS / 3_600_000} 小时,已终止`)
    task.status = 'timed_out'
    task.process?.kill()
  }, TASK_TIMEOUT_MS)
  task.timeout.unref?.()

  const launch = (attemptCommand: string, attemptPrompt: string, fallback: typeof resumeFallback): void => {
    let process: ReturnType<Context['shell']['start']>
    try {
      const spec = ctx.shell.resolve({
        command: attemptCommand,
        workdir,
        stdin: attemptPrompt,
        timeoutMs: TASK_TIMEOUT_MS,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workdir },
      })
      process = ctx.shell.start(spec)
    } catch (error) {
      pushTaskLine(task, `[clickvibe] Agent 启动失败: ${String(error instanceof Error ? error.message : error)}`)
      task.status = 'failed'
      task.exitCode = 1
      void Promise.resolve()
        .then(() => onExit(1, task.sessionId))
        .catch((exitError: unknown) => pushTaskLine(task, `[clickvibe] 启动失败收尾异常: ${String(exitError)}`))
        .finally(() => {
          finishTask(task, 'failed', 1)
          settleHostJob('failed')
        })
      return
    }
    task.process = process
    const startedAt = Date.now()
    let sawSessionId = false
    // 已投递的原始行与正在恢复的 spill 路径:补缺失行时按内容去重、防并发重复恢复
    const deliveredLines = new Set<string>()
    const recoveredInFlight = new Set<string>()

    // 轮询读取 agent 输出,解析为状态行,写入内存缓冲 + 落盘日志
    const drain = async (flush = false) => {
      const read = process.readOutput()
      const rawLines = read.delta === '' ? [] : task.rawLog.appendChunk(read.delta)
      if (flush) rawLines.push(...task.rawLog.flush())
      for (const rawLine of rawLines) {
        if (rawLine !== '') deliveredLines.add(rawLine)
      }
      if (rawLines.length > 0) {
        const parsed = parseAgentChunk(task.agent as AgentKind, rawLines.join('\n'))
        for (const line of parsed.lines) {
          pushTaskLine(task, {
            source: 'agent',
            agent: task.agent as AgentKind,
            kind: line.kind,
            text: line.text,
            ...(line.usage ? { usage: line.usage } : {}),
          })
        }
        if (parsed.sessionId) {
          sawSessionId = true
          task.sessionId = parsed.sessionId
        }
      }
      const lossNotice = lossyAgentOutputNotice(read)
      if (lossNotice) {
        pushTaskLine(task, lossNotice)
        // spill 文件字节完整,把被宿主内存缓冲丢弃的头部事件补回面板与落盘日志
        await recoverLossyOutput(task, read, deliveredLines, recoveredInFlight, (sessionId) => {
          sawSessionId = true
          task.sessionId = sessionId
        })
      }
    }
    const pump = setInterval(() => {
      void drain()
    }, 250)

    const settle = async (processError?: unknown): Promise<void> => {
      clearInterval(pump)
      await drain(true)
      if (processError !== undefined) {
        pushTaskLine(
          task,
          `[clickvibe] Agent 进程异常: ${String(processError instanceof Error ? processError.message : processError)}`,
        )
      }
      const status =
        task.status === 'timed_out' || task.status === 'stopped'
          ? task.status
          : process.exitCode === 0
            ? 'done'
            : 'failed'
      if (
        processError === undefined &&
        fallback &&
        shouldFallbackFromExactResume({
          hadExactSessionId: fallback.staleSessionId !== '',
          status,
          exitCode: process.exitCode,
          elapsedMs: Date.now() - startedAt,
          sawSessionId,
        })
      ) {
        task.sessionId = null
        pushTaskLine(task, '[clickvibe] 精确会话已失效,清除 stale sessionId 并回退全新会话…')
        try {
          const next = await fallback.prepare()
          if (task.status === 'stopped' || task.status === 'timed_out') {
            await onExit(process.exitCode, null)
            finishTask(task, task.status, process.exitCode)
            return
          }
          task.exitCode = null
          launch(next.command, next.prompt, undefined)
          return
        } catch (error) {
          pushTaskLine(
            task,
            `[clickvibe] 全新会话回退准备失败: ${String(error instanceof Error ? error.message : error)}`,
          )
        }
      }
      task.status = status
      task.exitCode = process.exitCode
      try {
        await onExit(process.exitCode, task.sessionId)
      } finally {
        finishTask(task, status, process.exitCode)
        settleHostJob(status)
      }
    }

    void process.done
      .then(
        () => settle(),
        (error: unknown) => settle(error),
      )
      .catch((error: unknown) => {
        pushTaskLine(task, `[clickvibe] 任务收尾失败: ${String(error instanceof Error ? error.message : error)}`)
        if (!task.closed) {
          const status = task.status === 'running' ? 'failed' : task.status
          finishTask(task, status, task.exitCode)
          settleHostJob(status)
        }
      })
  }

  if (task.closed) return reserved?.hostJobId ?? null
  launch(command, prompt, resumeFallback)
  return reserved?.hostJobId ?? null
}
