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

import { existsSync } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { fetchIssue, issueSnapshot } from '../github/issue.ts'
import { githubErrorMessage, githubRest, isGithubRateLimitError } from '../github/rest.ts'
import { handleApiPost } from './dispatch.ts'
import { type IssuePromptSnapshot, mergeGateLabel } from '../infra/develop-core.ts'
import { aggregateRepositoryFreshness, type RepositoryFreshness } from '../infra/repo-freshness.ts'
import {
  dependencyRefreshClock,
  ensureConfiguredRepoFresh,
  expandHome,
  fetchTtlMs,
  liveTasks,
  loadConfig,
  parseUrl,
  privilegedRequestError,
} from '../infra/runtime.ts'
import { issueKey, loadAllArchivedWorkflows, loadAllWorkflows, loadWorkflow } from '../infra/state.ts'
import {
  COMMAND_HELP_TEXT,
  type CommandAction,
  type CommandAuthorizationPreview,
  type CommandIssueItem,
  type CommandStatusWorkflow,
  formatConfirmationPreview,
  formatIssueList,
  formatMergeGateRejection,
  formatProjects,
  formatStatus,
  type ParsedCommand,
  parseCommand,
} from './command.ts'
import { authorizeAgent } from './merge.ts'
import { importDshProject } from './project-import.ts'
import { fetchRepositoryIssues } from './repository-issues.ts'
import { enrichWorkflowStates } from './repository-state.ts'
import { readConfiguredRepositoryAdvance } from './repository-sync.ts'

/** `/state` implementation, shared by the route and the `status` command (issue #13). */
export async function stateWorkflows(
  ctx: Context,
  filter: { url?: unknown; repoKey?: unknown; forceRefresh?: unknown } | undefined,
): Promise<{ status: number; body: unknown }> {
  const url = String(filter?.url ?? '')
  const repoKey = String(filter?.repoKey ?? '')
  const config = await loadConfig()
  const active = await loadAllWorkflows()
  const archived = url === '' ? [] : await loadAllArchivedWorkflows()
  const workflows = [...active, ...archived].filter(
    (workflow) => (url === '' || workflow.url === url) && (repoKey === '' || workflow.repoKey === repoKey),
  )
  const parsedRepo = parseUrl(url)
  const repoKeys = new Set(
    repoKey
      ? [repoKey]
      : parsedRepo
        ? [`${parsedRepo.owner}/${parsedRepo.repo}`]
        : workflows.map((workflow) => workflow.repoKey),
  )
  try {
    const circuitError = githubRest(ctx).rateLimitError()
    if (circuitError) throw circuitError
    const keyedFreshness = await Promise.all(
      [...repoKeys].map(async (key) => ({
        key,
        freshness: await ensureConfiguredRepoFresh(ctx, config, key, filter?.forceRefresh === true),
      })),
    )
    const freshnesses = keyedFreshness
      .map((item) => item.freshness)
      .filter((value): value is RepositoryFreshness => value !== null)
    const dependenciesRefreshDue = [...repoKeys]
      .map((key) => dependencyRefreshClock.take(key, fetchTtlMs(config), filter?.forceRefresh === true))
      .some(Boolean)
    const enriched = await enrichWorkflowStates(ctx, workflows, config)
    const freshness = aggregateRepositoryFreshness(freshnesses)
    const onlyRepo = keyedFreshness.length === 1 ? keyedFreshness[0] : null
    const repoAdvance = onlyRepo
      ? await readConfiguredRepositoryAdvance(ctx, config, onlyRepo.key, onlyRepo.freshness?.lastSuccessAt ?? null)
      : null
    return { status: 200, body: { ok: true, workflows: enriched, freshness, dependenciesRefreshDue, repoAdvance } }
  } catch (error) {
    const message = isGithubRateLimitError(error) ? error.message : `状态刷新失败: ${githubErrorMessage(error)}`
    return { status: isGithubRateLimitError(error) ? 429 : 400, body: { ok: false, error: message } }
  }
}

/** Resolve the implicit repoKey (single configured repo) or validate the explicit one. */
export async function resolveCommandRepoKey(explicit: string | null): Promise<{ repoKey: string } | { error: string }> {
  const config = await loadConfig()
  const keys = Object.keys(config.repos)
  if (explicit) {
    if (!(explicit in config.repos)) {
      return { error: `未配置项目 ${explicit}。可发送 projects 查看已配置的项目。` }
    }
    return { repoKey: explicit }
  }
  if (keys.length === 0) return { error: '尚未配置任何项目,请在 ~/.clickvibe/config.yaml 的 repos 中添加映射。' }
  if (keys.length === 1) return { repoKey: keys[0] }
  return { error: `配置了多个项目(${keys.join('、')}),请在命令中带上 repoKey,如:develop #8 ${keys[0]}` }
}

/** Resolve a command target to its GitHub URL; PR URLs (review) keep their kind. */
export async function resolveCommandTarget(command: ParsedCommand): Promise<{ url: string } | { error: string }> {
  if (command.url) return { url: command.url }
  const resolved = await resolveCommandRepoKey(command.repoKey)
  if ('error' in resolved) return resolved
  return { url: `https://github.com/${resolved.repoKey}/issues/${command.number}` }
}

/** Map a write command onto the same POST method the panel UI uses. */
export const WRITE_METHOD: Partial<Record<CommandAction, 'develop' | 'review' | 'resume' | 'stop' | 'sync' | 'merge'>> =
  {
    develop: 'develop',
    review: 'review',
    rework: 'resume',
    resume: 'resume',
    stop: 'stop',
    sync: 'sync',
    'restore-base': 'sync',
    merge: 'merge',
  }

/** Render one executed write result as conversation-readable text. */
export function formatWriteOutcome(
  action: CommandAction,
  result: { status: number; body: unknown },
): {
  status: number
  body: { ok: boolean; action: CommandAction; text: string; error?: string } & Record<string, unknown>
} {
  const body = (result.body ?? {}) as Record<string, unknown>
  if (!body.ok) {
    // merge 可能部分完成(PR 已合并、清理失败):不能说「未执行」
    const prefix = body.merged === true ? `${action} 部分完成,需重试:` : `${action} 未执行:`
    return {
      status: result.status,
      body: {
        ok: false,
        action,
        error: String(body.error ?? '执行失败'),
        text: `${prefix}${String(body.error ?? '原因未知')}`,
      },
    }
  }
  const followUp = '发送「status + 目标」可查看进度;「stop + 目标」可停止。'
  const text =
    action === 'develop'
      ? `已下单开发:任务 ${String(body.taskId ?? '')}(分支 ${String(body.branch ?? '')},worktree ${String(body.worktree ?? '')})。${followUp}`
      : action === 'review'
        ? `已启动 review:任务 ${String(body.taskId ?? '')}。${followUp}`
        : action === 'rework' || action === 'resume'
          ? `已恢复开发会话:任务 ${String(body.taskId ?? '')}。${followUp}`
          : action === 'merge'
            ? `PR #${String(body.prNumber ?? '')} 已合并,worktree/分支/Issue 清理与归档完成。`
            : action === 'restore-base'
              ? `已恢复远端基线 origin/${String(body.baseBranch ?? '')} @ ${String(body.baseHash ?? '')},可继续创建 PR。`
              : action === 'sync'
                ? `已同步 ${String(body.branch ?? '')} 到远端基线,HEAD ${String(body.head ?? '未知')}。`
                : `已请求停止任务 ${String(body.taskId ?? '')}${body.stopped === false ? '(任务此前已结束)' : ''}。`
  return { status: result.status, body: { ok: true, action, text, ...body } }
}

/**
 * `/clickvibe/api/command` (issue #13): one text-command entry for the whole
 * pipeline. Read commands answer directly; write commands follow the same
 * preview → user-confirm → one-use authorization protocol as the panel:
 * 1. without credentials the command returns a readable preview plus a
 *    one-time authorization (the server itself freezes the snapshot);
 * 2. with `authorizationId`/`authorizationDigest` the command forwards to the
 *    identical method handler the UI button uses.
 */
export async function handleCommand(
  ctx: Context,
  req: IncomingMessage,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  const text = String((payload as { command?: unknown } | undefined)?.command ?? '')
  const parsed = parseCommand(text)
  if (!parsed.ok) return { status: 400, body: { ok: false, error: parsed.error } }
  const command = parsed.command
  const confirm = (payload ?? {}) as {
    authorizationId?: unknown
    authorizationDigest?: unknown
    target?: unknown
    override?: unknown
  }
  const authorization = {
    ...(confirm.authorizationId !== undefined ? { authorizationId: String(confirm.authorizationId) } : {}),
    ...(confirm.authorizationDigest !== undefined ? { authorizationDigest: String(confirm.authorizationDigest) } : {}),
    ...(confirm.target !== undefined ? { target: confirm.target } : {}),
    ...(confirm.override !== undefined ? { override: confirm.override } : {}),
  }
  const execute = (method: string, body: Record<string, unknown>) =>
    handleApiPost(ctx, req, method, { ...body, ...authorization })

  if (command.action === 'help') {
    return { status: 200, body: { ok: true, action: 'help', text: COMMAND_HELP_TEXT } }
  }
  if (command.action === 'projects') {
    const importPath = (payload as { importPath?: unknown } | undefined)?.importPath
    if (importPath !== undefined) {
      const securityError = privilegedRequestError(req)
      if (securityError) return { status: 403, body: { ok: false, action: 'projects', error: securityError } }
      if (typeof importPath !== 'string' || importPath.trim() === '') {
        return { status: 400, body: { ok: false, action: 'projects', error: 'DSH 项目路径为空，无法导入' } }
      }
      const imported = await importDshProject(ctx, importPath)
      if (!imported.ok) {
        return { status: 400, body: { ok: false, action: 'projects', error: imported.error } }
      }
    }
    const result = await listProjects()
    return {
      status: 200,
      body: { ok: true, action: 'projects', text: formatProjects(result.projects), projects: result.projects },
    }
  }
  if (command.action === 'issues') {
    const resolved = await resolveCommandRepoKey(command.repoKey)
    if ('error' in resolved) return { status: 400, body: { ok: false, action: 'issues', error: resolved.error } }
    const result = await fetchRepositoryIssues(ctx, { repoKey: resolved.repoKey })
    if (!result.ok) return { status: 400, body: { ok: false, action: 'issues', error: result.error } }
    return {
      status: 200,
      body: {
        ok: true,
        action: 'issues',
        repoKey: resolved.repoKey,
        text: formatIssueList(resolved.repoKey, result.issues as CommandIssueItem[]),
        issues: result.issues,
      },
    }
  }
  if (command.action === 'status') {
    const target = await resolveCommandTarget(command)
    if ('error' in target) return { status: 400, body: { ok: false, action: 'status', error: target.error } }
    const state = await stateWorkflows(ctx, { url: target.url })
    if (state.status !== 200) {
      const error = String((state.body as { error?: string }).error ?? '状态刷新失败')
      return { status: state.status, body: { ok: false, action: 'status', error } }
    }
    const workflows = (state.body as { workflows: CommandStatusWorkflow[] }).workflows
    const workflow = workflows.find((item) => item.url === target.url) ?? null
    return {
      status: 200,
      body: {
        ok: true,
        action: 'status',
        url: target.url,
        text: formatStatus(workflow, command.number ?? ''),
        workflow,
      },
    }
  }

  const method = WRITE_METHOD[command.action]
  if (!method) return { status: 404, body: { ok: false, error: `命令 ${command.action} 不可写` } }

  // 安全门禁先行:未通过来源校验的请求连项目配置都不该看到
  const securityError = privilegedRequestError(req)
  if (securityError) return { status: 403, body: { ok: false, action: command.action, error: securityError } }
  const target = await resolveCommandTarget(command)
  if ('error' in target) return { status: 400, body: { ok: false, action: command.action, error: target.error } }
  const { url } = target

  // 直接执行类:sync/stop 不需要一次性授权;dryrun 只需回环校验(在 develop 分支内)
  if (command.action === 'sync') {
    return formatWriteOutcome(command.action, await execute('sync', { url }))
  }
  if (command.action === 'stop') {
    const key = parseUrl(url)
    if (!key) return { status: 400, body: { ok: false, action: 'stop', error: '目标 URL 无效' } }
    const workflow = await loadWorkflow(issueKey(`${key.owner}/${key.repo}`, key.number))
    const taskId = [workflow?.devTaskId, workflow?.reviewTaskId].find(
      (id) => id !== null && id !== undefined && liveTasks.has(id) && !liveTasks.get(id)!.closed,
    )
    if (!taskId) return { status: 400, body: { ok: false, action: 'stop', error: '该 issue 没有运行中的任务' } }
    return formatWriteOutcome(command.action, await execute('stop', { taskId }))
  }
  if (command.action === 'develop' && command.agent === 'dryrun') {
    return formatWriteOutcome(command.action, await execute('develop', { url, agent: 'dryrun' }))
  }

  // 两阶段写命令:预览签发(服务端自己冻结快照)→ 用户在对话中确认 → 携带授权重发
  const confirmed = authorization.authorizationId !== undefined
  if (confirmed) {
    const agent =
      command.action === 'develop' || command.action === 'review'
        ? (command.agent ?? 'codex')
        : command.action === 'rework' || command.action === 'resume'
          ? await resolveResumeAgent(url)
          : null
    return formatWriteOutcome(
      command.action,
      await execute(method, {
        url,
        ...(agent && agent !== 'dryrun' ? { agent } : {}),
        ...(command.context !== '' ? { context: command.context } : {}),
        ...(command.action === 'restore-base' ? { restoreBase: true } : {}),
      }),
    )
  }

  const authAction = command.action === 'rework' ? 'resume' : command.action
  const agent =
    command.action === 'develop' || command.action === 'review'
      ? (command.agent ?? 'codex')
      : command.action === 'rework' || command.action === 'resume'
        ? await resolveResumeAgent(url)
        : null
  let expectedSnapshot: IssuePromptSnapshot | undefined
  if (command.action === 'develop') {
    const fetched = await fetchIssue(ctx, { url, forceRefresh: true })
    if (!fetched.ok) return { status: 400, body: { ok: false, action: command.action, error: fetched.error } }
    expectedSnapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
  }
  const authorized = await authorizeAgent(ctx, {
    action: authAction,
    url,
    ...(agent && agent !== 'dryrun' ? { agent } : {}),
    ...(command.context !== '' ? { context: command.context } : {}),
    ...(expectedSnapshot ? { expectedSnapshot } : {}),
    ...(command.action === 'merge' && command.overrideReason !== ''
      ? { override: true, overrideReason: command.overrideReason }
      : {}),
  })
  if (!authorized.ok) {
    // 门禁拒绝(issue #49):把全部失败项与人工放行路径说清楚,对话里可直接决策
    if (authorized.gateFailures && authorized.gateFailures.length > 0) {
      return {
        status: 400,
        body: {
          ok: false,
          action: command.action,
          error: authorized.error,
          gateFailures: authorized.gateFailures,
          text: formatMergeGateRejection(url, authorized.gateFailures, mergeGateLabel),
        },
      }
    }
    return { status: 400, body: { ok: false, action: command.action, error: authorized.error } }
  }
  return {
    status: 200,
    body: {
      ok: true,
      action: command.action,
      needsConfirmation: true,
      text: formatConfirmationPreview(
        command.action,
        agent,
        authorized.preview as CommandAuthorizationPreview,
        authorized.authorizationDigest,
        authorized.expiresAt,
      ),
      authorization: {
        authorizationId: authorized.authorizationId,
        authorizationDigest: authorized.authorizationDigest,
        expiresAt: authorized.expiresAt,
        ...(authorized.target ? { target: authorized.target } : {}),
        ...(authorized.override ? { override: authorized.override } : {}),
      },
    },
  }
}

/** resume/rework 授权与执行必须用同一 agent 值(digest 覆盖它),以 workflow 记录为准。 */
export async function resolveResumeAgent(url: string): Promise<'codex' | 'claude' | null> {
  const parsed = parseUrl(url)
  if (!parsed) return 'codex'
  const workflow = await loadWorkflow(issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number))
  return workflow?.devAgent ?? 'codex'
}

export async function listProjects(): Promise<{
  ok: true
  projects: { repoKey: string; path: string; available: boolean }[]
}> {
  const config = await loadConfig()
  return {
    ok: true,
    projects: Object.entries(config.repos)
      .map(([repoKey, path]) => ({ repoKey, path: expandHome(path), available: existsSync(expandHome(path)) }))
      .sort((a, b) => a.repoKey.localeCompare(b.repoKey)),
  }
}
