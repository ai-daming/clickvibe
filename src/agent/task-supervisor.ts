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
import { type DevelopAgent, LineLog, shouldFallbackFromExactResume } from '../infra/develop-core.ts'
import { encodeLiveLogEvent, type LiveLogEvent } from '../infra/live-output.ts'
import {
  type LiveTask,
  liveTasks,
  liveWaiters,
  MAX_TASKS,
  notifyTask,
  resumeTaskGate,
  reviewTaskGate,
  TASK_LOG_LINES,
  TASK_RETENTION_MS,
  TASK_TIMEOUT_MS,
} from '../infra/runtime.ts'
import { appendTaskLog, startTaskLog, type IssueWorkflow } from '../infra/state.ts'
import { type AgentKind, parseAgentChunk } from './agent-stream.ts'

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
    }
  }
  if (liveTasks.size >= MAX_TASKS) throw new Error('运行中任务过多,请先停止或等待现有任务完成')
  const task: LiveTask = {
    taskId,
    workflowKey: workflow.key,
    workflow,
    kind,
    agent,
    log: new LineLog(TASK_LOG_LINES),
    rawLog: new LineLog(TASK_LOG_LINES),
    rawCursor: 0,
    closed: false,
    status: 'running',
    exitCode: null,
    sessionId,
  }
  liveTasks.set(taskId, task)
  void startTaskLog(workflow, kind, taskId)
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
  void appendTaskLog(task.workflow, task.kind, task.taskId, sequence, line, completion)
  notifyTask(task.taskId)
}

export function scheduleTaskCleanup(task: LiveTask): void {
  task.cleanup = setTimeout(() => {
    liveTasks.delete(task.taskId)
    liveWaiters.delete(task.taskId)
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
  if (task.kind === 'review') reviewTaskGate.release(task.workflowKey, task)
  else resumeTaskGate.release(task.workflowKey, task)
  if (task.timeout) clearTimeout(task.timeout)
  notifyTask(task.taskId)
  scheduleTaskCleanup(task)
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
): void {
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
        .finally(() => finishTask(task, 'failed', 1))
      return
    }
    task.process = process
    const startedAt = Date.now()
    let sawSessionId = false

    // 轮询读取 agent 输出,解析为状态行,写入内存缓冲 + 落盘日志
    const drain = (flush = false) => {
      const read = process.readOutput()
      if (read.delta !== '') task.rawLog.appendChunk(read.delta)
      if (flush) task.rawLog.flush()
      const raw = task.rawLog.read(task.rawCursor)
      task.rawCursor = raw.cursor
      if (raw.lines.length > 0) {
        const parsed = parseAgentChunk(task.agent as AgentKind, raw.lines.join('\n'))
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
      if (raw.truncated || read.lossy) {
        pushTaskLine(task, '[clickvibe] Agent 原始输出被截断(日志过长)')
      }
    }
    const pump = setInterval(() => drain(), 250)

    const settle = async (processError?: unknown): Promise<void> => {
      clearInterval(pump)
      drain(true)
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
      }
    }

    void process.done
      .then(
        () => settle(),
        (error: unknown) => settle(error),
      )
      .catch((error: unknown) => {
        pushTaskLine(task, `[clickvibe] 任务收尾失败: ${String(error instanceof Error ? error.message : error)}`)
        if (!task.closed) finishTask(task, task.status === 'running' ? 'failed' : task.status, task.exitCode)
      })
  }

  launch(command, prompt, resumeFallback)
}
