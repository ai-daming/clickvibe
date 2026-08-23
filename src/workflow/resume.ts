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
import { buildResumePrompt, resolvePromptSnapshot } from '../agent/prompts.ts'
import { attachAgentProcess, createLiveTask, finishTask, pushTaskLine } from '../agent/task-supervisor.ts'
import { buildFreshAgentCommand, buildResumeAgentCommand } from '../infra/develop-core.ts'
import { buildMergePreface } from '../infra/git.ts'
import {
  type LiveTask,
  liveTasks,
  parseUrl,
  readWorktreeHead,
  resumeTaskGate,
  runCommand,
  taskId,
} from '../infra/runtime.ts'
import {
  applyDevRunOutcome,
  clearStaleSessionId,
  type IssueWorkflow,
  issueKey,
  loadWorkflow,
  resolveSessionForAgent,
  saveWorkflow,
} from '../infra/state.ts'
import { mutateWorkflowStrict } from '../infra/workflow-mutation.ts'
import { withWorkflowLock } from '../infra/workflow-lock.ts'
import { recordDevDelivery } from './review-flow.ts'
import { deriveFreshSessionAvailability, selectSessionLaunch } from './fresh-session.ts'
import { workflowBaseBranch } from './state-view.ts'
import { notifyAutoRunCompletion } from './auto-run-signal.ts'

/** Resume (or continue) a dev session with an exact session id; `context`
 *  carries extra instructions (e.g. review issues for a rework).
 *  Exported for integration tests; the /resume route calls it. */
export async function resumeDevelop(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; taskId: string } | { ok: false; error: string }> {
  const body = (payload ?? {}) as { url?: unknown; context?: unknown; freshSession?: unknown }
  const url = String(body.url ?? '').trim()
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const freshSession = body.freshSession === true
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  const loadedWorkflow = await loadWorkflow(key)
  if (!loadedWorkflow || !loadedWorkflow.devTaskId) {
    return { ok: false, error: '该 issue 尚无开发记录,无法续会话' }
  }
  let workflow: IssueWorkflow = loadedWorkflow
  const previousTaskId = loadedWorkflow.devTaskId

  const availability = deriveFreshSessionAvailability(
    workflow.events,
    workflow.devSessionId !== null && workflow.devSessionAgent === workflow.devAgent,
    workflow.reviewSessionId !== null && workflow.reviewSessionAgent === workflow.reviewAgent,
  )
  if (freshSession && !availability.develop) {
    return { ok: false, error: '当前轮次未超过阈值,或没有可放弃的开发会话' }
  }

  const oldLive = liveTasks.get(previousTaskId)
  if (oldLive && !oldLive.closed) {
    return { ok: true, taskId: oldLive.taskId }
  }

  const agent = workflow.devAgent ?? 'codex'
  const ownedDevSession = freshSession
    ? { sessionId: null, invalid: false }
    : resolveSessionForAgent(workflow, 'dev', agent)
  const launch = selectSessionLaunch(freshSession, ownedDevSession)
  let sessionId = launch.sessionId
  let invalidSession = ownedDevSession.invalid
  if (freshSession) {
    workflow.devSessionId = null
    workflow.devSessionAgent = null
  }
  // Reserve synchronously before the snapshot's GitHub awaits. This is the
  // per-workflow invariant preventing double-clicked resume requests from
  // launching multiple agents against the same git worktree.
  let reservation: { task: LiveTask; created: boolean }
  try {
    reservation = resumeTaskGate.reserve(workflow.key, () => {
      const id = taskId('dev')
      return createLiveTask(id, workflow, 'dev', agent, sessionId)
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  if (!reservation.created) return { ok: true, taskId: reservation.task.taskId }
  const live = reservation.task
  const resolvedSnapshot = await resolvePromptSnapshot(ctx, workflow)
  if ('error' in resolvedSnapshot) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: resolvedSnapshot.error }
  }
  try {
    workflow = await mutateWorkflowStrict(workflow.key, (current) => {
      if (freshSession) {
        current.devSessionId = null
        current.devSessionAgent = null
        sessionId = null
        invalidSession = false
      } else {
        const owned = resolveSessionForAgent(current, 'dev', agent)
        sessionId = owned.sessionId
        invalidSession = owned.invalid
      }
      current.devTaskId = live.taskId
      current.devInterrupted = false
      current.stage = 'developing'
    })
  } catch (error) {
    finishTask(live, 'failed', 1)
    return { ok: false, error: `无法持久化恢复任务:${String(error instanceof Error ? error.message : error)}` }
  }
  if (invalidSession) {
    pushTaskLine(live, '[clickvibe] dev sessionId 归属缺失或与当前 agent 不一致,已清除并启动全新会话')
  }
  const exactSessionId = sessionId

  // 用精确会话 id 续会话(不能用 --last/--continue:worktree 里可能有多个
  // agent 会话,--last 续的是"最近那个",不一定是我们这个)。
  // sessionId 缺失时回退 --last/--continue(尽力而为)。
  const command =
    freshSession || invalidSession ? buildFreshAgentCommand(agent) : buildResumeAgentCommand(agent, exactSessionId)
  // 续会话前也同步远端(并行开发时 base 会变化)
  try {
    await runCommand(ctx, 'git fetch origin', {
      workdir: workflow.worktree,
      timeoutMs: 30000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
    })
    pushTaskLine(live, `[clickvibe] 已同步远端(origin)`)
  } catch (e) {
    pushTaskLine(live, `[clickvibe] git fetch 失败(继续): ${String(e instanceof Error ? e.message : e)}`)
  }

  // issue #26:worktree 落后基线或处于冲突合并中时,把「合并 main、解决冲突」
  // 作为前置指令交给 agent(danger-full-access 有能力处理),review 意见不再
  // 被同步门禁挡住送不进来。
  const mergePreface = await buildMergePreface(ctx, workflow.worktree, workflowBaseBranch(workflow.baseRef))

  const prompt = await buildResumePrompt(ctx, workflow, resolvedSnapshot, extraContext, mergePreface, exactSessionId)

  pushTaskLine(
    live,
    freshSession
      ? `[clickvibe] 新开 ${agent} 开发会话,保留当前 worktree/分支/commit…`
      : `[clickvibe] 恢复 ${agent} 会话${exactSessionId ? `(${exactSessionId})` : ''}…`,
  )
  attachAgentProcess(
    ctx,
    live,
    command,
    workflow.worktree,
    prompt,
    async (exitCode, newSessionId) => {
      const durationMs = Math.max(0, Date.now() - live.startedAt)
      pushTaskLine(live, `[clickvibe] ${agent} 恢复结束,退出码 ${exitCode}`)
      await withWorkflowLock(workflow.key, async () => {
        const reloaded = await loadWorkflow(workflow.key)
        if (!reloaded) return
        const fixedIssues = reloaded.reviewResult?.passed === false ? [...reloaded.reviewResult.issues] : []
        if (applyDevRunOutcome(reloaded, live.status, exitCode, newSessionId, agent)) {
          // rework 完成:旧的 review 结论已归档到 events,回到"待 review",
          // 不能继续显示"Review 未通过"让用户无限重复点
          const head = await readWorktreeHead(ctx, workflow.worktree)
          await recordDevDelivery(
            ctx,
            reloaded,
            agent,
            head,
            fixedIssues,
            'resume',
            extraContext,
            live.taskId,
            durationMs,
          )
        }
        await saveWorkflow(reloaded)
      })
      notifyAutoRunCompletion(ctx, workflow.key, live.status === 'running' ? 'failed' : live.status)
    },
    exactSessionId
      ? {
          staleSessionId: exactSessionId,
          prepare: async () => {
            await mutateWorkflowStrict(workflow.key, (reloaded) => {
              clearStaleSessionId(reloaded, 'dev', exactSessionId)
            }).catch(() => undefined)
            return {
              command: buildFreshAgentCommand(agent),
              prompt: await buildResumePrompt(ctx, workflow, resolvedSnapshot, extraContext, mergePreface, null),
            }
          },
        }
      : undefined,
  )

  return { ok: true, taskId: live.taskId }
}
