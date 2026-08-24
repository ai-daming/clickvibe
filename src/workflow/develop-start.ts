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

import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { buildDevelopPrompt, type ResolvedPromptSnapshot, sameSnapshot } from '../agent/prompts.ts'
import {
  attachAgentProcess,
  createLiveTask,
  finishTask,
  pushTaskLine,
  reserveHostTask,
} from '../agent/task-supervisor.ts'
import { ensureWorktree } from '../agent/worktree.ts'
import { fetchGithubPrFact, readConfiguredBranchFacts } from '../github/facts.ts'
import { fetchIssue, issueSnapshot } from '../github/issue.ts'
import {
  buildFreshAgentCommand,
  type DevelopAgent,
  type IssuePromptSnapshot,
  parseAgent,
} from '../infra/develop-core.ts'
import {
  automaticDependencyValidationClock,
  expandHome,
  type LiveTask,
  liveTasks,
  loadConfig,
  parseUrl,
  readWorktreeHead,
  runCommand,
  taskId,
} from '../infra/runtime.ts'
import { type IssueWorkflow, issueKey, loadWorkflow, saveWorkflow } from '../infra/state.ts'
import { observeWorkflowTask, taskLaunchDecision, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { deriveAutoDevelopment } from './auto-development.ts'
import { deriveDevelopmentEventKind } from './delivery-audit.ts'
import { finalizeDevRun } from './dev-completion.ts'
import { deriveWorkflowState } from './derive.ts'
import { checkIssueContract } from './issue-contract.ts'
import { firstDevelopmentFor } from './repository-state.ts'
import { recordDevDelivery } from './review-flow.ts'
import { notifyAutoRunCompletion } from './auto-run-signal.ts'

export async function resolveAutomaticFirstDevelopment(
  ctx: Context,
  parsed: { owner: string; repo: string; number: string },
): Promise<{ ok: true; firstDevelopment: boolean } | { ok: false; error: string }> {
  const config = await loadConfig()
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return { ok: false, error: `未配置项目 ${repoKey}` }
  const project = basename(expandHome(configuredPath))
  const existing = await loadWorkflow(issueKey(repoKey, parsed.number))
  const branch = existing?.branch ?? `${project}-issue-${parsed.number}`
  const worktree = existing?.worktree ?? join(config.worktreeRoot, project, branch)
  const workflow: IssueWorkflow = existing ?? {
    key: issueKey(repoKey, parsed.number),
    url: `https://github.com/${repoKey}/issues/${parsed.number}`,
    repoKey,
    worktree,
    branch,
    stage: 'idle',
    devAgent: null,
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: null,
    updatedAt: 0,
    events: [],
  }
  const [branchFacts, prLookup] = await Promise.all([
    readConfiguredBranchFacts(ctx, config, workflow),
    fetchGithubPrFact(ctx, repoKey, branch, existing?.prNumber ?? null),
  ])
  if (!prLookup.known) return { ok: false, error: '无法确认开发分支是否已有 PR，自动开发已关门' }
  const derived = await deriveWorkflowState(ctx, workflow, {
    pr: prLookup.pr,
    prStatusKnown: true,
    ...branchFacts,
  })
  return { ok: true, firstDevelopment: firstDevelopmentFor(existing, derived) }
}

/** Start a development task: worktree + branch + background agent run. */
export async function startDevelop(
  ctx: Context,
  payload: unknown,
  authorizedSnapshot: IssuePromptSnapshot | null,
): Promise<
  { ok: true; taskId: string; worktree: string; branch: string } | { ok: false; error: string; controllerError?: true }
> {
  const body = (payload ?? {}) as { url?: unknown; agent?: unknown; context?: unknown; automatic?: unknown }
  const url = String(body.url ?? '').trim()
  let agent: DevelopAgent
  try {
    agent = parseAgent(body.agent)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  const extraContext = typeof body.context === 'string' ? body.context.trim() : ''
  const automatic = body.automatic === true
  const parsed = parseUrl(url)
  if (!parsed) {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  if (parsed.kind !== 'issue') {
    return { ok: false, error: '一键开发仅支持 issue 链接' }
  }

  let launchSnapshot: ResolvedPromptSnapshot | null = null
  let automaticSnapshot: Awaited<ReturnType<typeof fetchIssue>> | null = null
  const automaticDependencyRefresh = automatic
    ? automaticDependencyValidationClock.take(`${parsed.owner}/${parsed.repo}`, 30_000)
    : true
  if (agent === 'dryrun') {
    const fetched = await fetchIssue(ctx, {
      url,
      forceRefresh: true,
      forceDependencyRefresh: automaticDependencyRefresh,
    })
    if (!fetched.ok) return fetched
    automaticSnapshot = fetched
    const snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
    if (snapshot.state !== 'OPEN') return { ok: false, error: '只有 OPEN Issue 可以执行 dryrun' }
  } else if (!authorizedSnapshot || authorizedSnapshot.url !== url || authorizedSnapshot.state !== 'OPEN') {
    return { ok: false, error: '缺少与该 OPEN Issue 绑定的服务端确认快照' }
  } else {
    const fetched = await fetchIssue(ctx, {
      url,
      forceRefresh: true,
      forceDependencyRefresh: automaticDependencyRefresh,
    })
    if (fetched.ok) {
      automaticSnapshot = fetched
      const current = issueSnapshot(fetched.data.item as Record<string, unknown>)
      if (!sameSnapshot(current, authorizedSnapshot)) {
        return { ok: false, error: 'Issue 内容在确认后已变化,旧授权已失效;请刷新面板并按当前快照重新确认' }
      }
      launchSnapshot = { snapshot: current, freshness: 'current' }
    } else {
      launchSnapshot = {
        snapshot: authorizedSnapshot,
        freshness: 'persisted',
        fetchError: fetched.error.slice(0, 500),
      }
    }
  }

  if (automatic) {
    if (!automaticSnapshot?.ok) return { ok: false, error: '自动开发必须取得当前 GitHub 依赖快照' }
    const current = issueSnapshot(automaticSnapshot.data.item as Record<string, unknown>)
    const contract = checkIssueContract(current.body)
    const dependencies = automaticSnapshot.data.dependencies?.blockedBy
    if (!dependencies) return { ok: false, error: '依赖状态不可用，自动开发已关门' }
    const prerequisiteDecision = deriveAutoDevelopment({
      issueState: current.state,
      dependencyStates: dependencies.map((dependency) => dependency.state),
      contract,
      firstDevelopment: true,
    })
    if (!prerequisiteDecision.ready) {
      return { ok: false, error: `自动开发跳过: ${prerequisiteDecision.reason}` }
    }
    const firstDevelopment = await resolveAutomaticFirstDevelopment(ctx, parsed)
    if (!firstDevelopment.ok) return firstDevelopment
    const decision = deriveAutoDevelopment({
      issueState: current.state,
      dependencyStates: dependencies.map((dependency) => dependency.state),
      contract,
      firstDevelopment: firstDevelopment.firstDevelopment,
    })
    if (!decision.ready) return { ok: false, error: `自动开发跳过: ${decision.reason}` }
  }

  const ensured = await ensureWorktree(ctx, parsed)
  if (!ensured.ok) return ensured
  const { workflow } = ensured
  // issue 已校验为 OPEN(真实 agent 走授权快照,dryrun 走抓取校验)
  workflow.issueState = 'OPEN'
  if (launchSnapshot) workflow.issueSnapshot = launchSnapshot.snapshot
  // 首次开工 = 本地无任何开发/返工交付记录;带附加说明也不得误判为返工(issue #54)。
  const firstDevelopment = !workflow.events.some(
    (event) => event.kind === 'dev' || event.kind === 'rework' || event.kind === 'resume',
  )

  if (agent === 'dryrun') {
    // A safety probe is not a new durable development generation: never
    // rotate the previous real task's disk-backed history here.
    const taskIdValue = taskId('dryrun')
    let live: LiveTask
    try {
      live = createLiveTask(taskIdValue, workflow, 'dev', agent, null)
    } catch (error) {
      return { ok: false, error: String(error instanceof Error ? error.message : error) }
    }
    void (async () => {
      try {
        pushTaskLine(live, '[clickvibe] dry-run: 不会启动 Codex/Claude')
        const policy = { mode: 'read-only' as const, workspaceRoot: workflow.worktree }
        for (const command of ['pwd', 'git branch --show-current', 'git status --short --branch']) {
          pushTaskLine(live, `$ ${command}`)
          const output = await runCommand(ctx, command, {
            workdir: workflow.worktree,
            timeoutMs: 10_000,
            sandboxPolicy: policy,
          })
          for (const line of output.split('\n')) if (line !== '') pushTaskLine(live, line)
        }
        pushTaskLine(live, '[clickvibe] dry-run 完成')
        finishTask(live, 'done', 0)
      } catch (error) {
        pushTaskLine(live, `[clickvibe] dry-run 失败: ${String(error instanceof Error ? error.message : error)}`)
        finishTask(live, 'failed', 1)
      }
    })()
    return { ok: true, taskId: taskIdValue, worktree: workflow.worktree, branch: workflow.branch }
  }
  if (!authorizedSnapshot || !launchSnapshot) return { ok: false, error: '服务端确认快照丢失,请重新确认' }

  const ownershipGate = taskLaunchDecision(observeWorkflowTask(ctx as unknown as TaskOwnershipContext, workflow))
  if (!ownershipGate.allowed) {
    return ownershipGate.running && workflow.devTaskId
      ? { ok: true, taskId: workflow.devTaskId, worktree: workflow.worktree, branch: workflow.branch }
      : { ok: false, error: ownershipGate.error, controllerError: true }
  }

  // 已有开发任务在跑:复用
  if (workflow.devTaskId && liveTasks.has(workflow.devTaskId) && !liveTasks.get(workflow.devTaskId)!.closed) {
    return { ok: true, taskId: workflow.devTaskId, worktree: workflow.worktree, branch: workflow.branch }
  }

  const taskIdValue = taskId('dev')
  let live: LiveTask
  try {
    live = createLiveTask(taskIdValue, workflow, 'dev', agent, null)
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  let hostReservation: ReturnType<typeof reserveHostTask>
  try {
    hostReservation = reserveHostTask(ctx, live)
  } catch (error) {
    finishTask(live, 'failed', 1)
    return {
      ok: false,
      error: `宿主任务占位失败:${String(error instanceof Error ? error.message : error)}`,
      controllerError: true,
    }
  }
  if (!hostReservation.created) {
    finishTask(live, 'stopped', null)
    return {
      ok: true,
      taskId: hostReservation.taskId,
      worktree: workflow.worktree,
      branch: workflow.branch,
    }
  }
  // LiveTask creation opened a new immutable JSONL generation. Previous task
  // files remain queryable and are never truncated.
  workflow.devAgent = agent
  workflow.devTaskId = taskIdValue
  workflow.devHostJobId = hostReservation.hostJobId
  workflow.devInterrupted = false
  workflow.stage = 'developing'
  await saveWorkflow(workflow)

  void (async () => {
    try {
      pushTaskLine(
        live,
        `[clickvibe] 使用${launchSnapshot.freshness === 'current' ? '当前' : '持久化回退(可能过期)'} Issue 快照(${launchSnapshot.snapshot.updatedAt || '无更新时间'})`,
      )
      const prompt = buildDevelopPrompt(workflow, launchSnapshot, extraContext, firstDevelopment)

      pushTaskLine(live, `[clickvibe] 启动 ${agent} 开发…`)
      const agentCommand = buildFreshAgentCommand(agent)

      attachAgentProcess(ctx, live, agentCommand, workflow.worktree, prompt, async (exitCode, sessionId) => {
        const durationMs = Math.max(0, Date.now() - live.startedAt)
        pushTaskLine(live, `[clickvibe] ${agent} 结束,退出码 ${exitCode}`)
        const reloaded = await loadWorkflow(workflow.key)
        if (reloaded) {
          const fixedIssues = reloaded.reviewResult?.passed === false ? [...reloaded.reviewResult.issues] : []
          await finalizeDevRun(reloaded, live.status, exitCode, sessionId, agent, async () => {
            // 开发完成(含 rework):旧的 review 结论已归档到 events 历史,
            // 当前回到"待 review"——不能继续显示"Review 未通过"
            const head = await readWorktreeHead(ctx, workflow.worktree)
            await recordDevDelivery(
              ctx,
              reloaded,
              agent,
              head,
              fixedIssues,
              deriveDevelopmentEventKind(firstDevelopment, extraContext),
              extraContext,
              live.taskId,
              durationMs,
            )
          })
        }
        notifyAutoRunCompletion(ctx, workflow.key, live.status === 'running' ? 'failed' : live.status)
      })
    } catch (error) {
      pushTaskLine(live, `[clickvibe] 失败: ${String(error instanceof Error ? error.message : error)}`)
      const reloaded = await loadWorkflow(workflow.key)
      if (reloaded) {
        reloaded.stage = 'developing'
        reloaded.devInterrupted = true
        await saveWorkflow(reloaded)
      }
      notifyAutoRunCompletion(ctx, workflow.key, 'failed')
      finishTask(live, 'failed', 1)
    }
  })()

  return { ok: true, taskId: taskIdValue, worktree: workflow.worktree, branch: workflow.branch }
}
