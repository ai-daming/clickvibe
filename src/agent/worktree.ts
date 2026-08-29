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
import { basename, dirname, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { buildWorktreeAddCommand, decideWorktreeRecovery, shellQuote } from '../infra/develop-core.ts'
import { expandHome, loadConfig, runCommand } from '../infra/runtime.ts'
import {
  appendLog,
  commitWorkflowMetadata,
  type IssueWorkflow,
  issueKey,
  loadWorkflow,
  WorkflowConflictError,
  workflowRevision,
} from '../infra/state.ts'
import { resolveSelectedRemoteBase } from './baseline.ts'

/** Create (or reuse) the workflow record and the worktree+branch. */
export async function ensureWorktree(
  ctx: Context,
  parsed: { owner: string; repo: string; number: string },
  requestedBaseline?: unknown,
): Promise<{ ok: true; workflow: IssueWorkflow; worktree: string; branch: string } | { ok: false; error: string }> {
  const config = await loadConfig()
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const repoPath = config.repos[repoKey]
  if (!repoPath) {
    return { ok: false, error: `本地未配置仓库 ${repoKey},请在 ~/.clickvibe/config.yaml 的 repos 中添加映射` }
  }
  const expandedRepo = expandHome(repoPath)
  if (!existsSync(expandedRepo)) {
    return { ok: false, error: `仓库路径不存在: ${expandedRepo}` }
  }

  const key = issueKey(repoKey, parsed.number)
  let workflow = await loadWorkflow(key)
  const project = basename(expandedRepo)
  const branch = `${project}-issue-${parsed.number}`
  const worktree = join(config.worktreeRoot, project, branch)

  if (!workflow) {
    workflow = {
      key,
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
      updatedAt: Date.now(),
      events: [],
    }
  }
  // 旧状态文件兜底:裸 session id 不猜 agent 归属,后续 resume 会按无效处理。
  if (!Array.isArray(workflow.events)) workflow.events = []
  if (workflow.reviewSessionId === undefined) workflow.reviewSessionId = null
  if (workflow.devSessionAgent === undefined) workflow.devSessionAgent = null
  if (workflow.reviewSessionAgent === undefined) workflow.reviewSessionAgent = null
  if (workflow.prNumber === undefined) workflow.prNumber = null
  if (workflow.issueState === undefined) workflow.issueState = 'OPEN'
  if (workflow.baseRef === undefined) workflow.baseRef = null
  // 校正路径字段(配置可能变化)
  workflow.worktree = worktree
  workflow.branch = branch

  // 新分支只能从 fetch 后的远端默认分支创建,不能继承配置仓库碰巧停留的 HEAD。
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: expandedRepo }
  await runCommand(ctx, 'git fetch origin --prune', {
    workdir: expandedRepo,
    sandboxPolicy: policy,
    timeoutMs: 60_000,
  })
  notifyLocalGitMutation({ repoKey, worktreePath: worktree }, 'remote-fetch', 'ensureWorktree')
  let defaultRemoteBase = await runCommand(ctx, 'git symbolic-ref --quiet --short refs/remotes/origin/HEAD', {
    workdir: expandedRepo,
    sandboxPolicy: policy,
    timeoutMs: 10_000,
  }).catch(() => '')
  if (!defaultRemoteBase) {
    const hasMain = await runCommand(
      ctx,
      `git show-ref --verify --quiet ${shellQuote('refs/remotes/origin/main')}; echo $?`,
      { workdir: expandedRepo, sandboxPolicy: policy, timeoutMs: 10_000 },
    )
    if (hasMain.trim() !== '0') return { ok: false, error: '无法确定 origin 默认分支,请设置 origin/HEAD' }
    defaultRemoteBase = 'origin/main'
  }
  let remoteBase: string
  try {
    remoteBase = resolveSelectedRemoteBase({
      requested: requestedBaseline,
      frozen: workflow.baseRef,
      defaultRemoteBase,
    })
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
  const firstBaseSelection = !workflow.baseRef
  const explicitCustomBase =
    firstBaseSelection &&
    requestedBaseline !== undefined &&
    requestedBaseline !== null &&
    remoteBase !== defaultRemoteBase
  if (firstBaseSelection && remoteBase === `origin/${branch}`) {
    return { ok: false, error: `开发基线不能选择当前 Issue 开发分支 ${remoteBase}` }
  }
  const remoteBaseExists =
    (
      await runCommand(ctx, `git show-ref --verify --quiet ${shellQuote(`refs/remotes/${remoteBase}`)}; echo $?`, {
        workdir: expandedRepo,
        sandboxPolicy: policy,
        timeoutMs: 10_000,
      })
    ).trim() === '0'
  if (firstBaseSelection && !remoteBaseExists) {
    return { ok: false, error: `开发基线不存在或未 fetch: ${remoteBase}` }
  }
  const remoteBaseHash = firstBaseSelection
    ? await runCommand(ctx, `git rev-parse --short ${shellQuote(remoteBase)}`, {
        workdir: expandedRepo,
        sandboxPolicy: policy,
        timeoutMs: 10_000,
      })
    : null

  if (firstBaseSelection) {
    if (!remoteBaseHash) return { ok: false, error: `无法读取开发基线提交: ${remoteBase}` }
  }

  // 幂等建 worktree:用完整恢复决策(处理 reuse/attach/conflict/重建),
  // 而不是简单判断目录是否存在。git 操作需要无沙箱(写主仓库 .git/refs)。
  const listOut = await runCommand(ctx, 'git worktree list --porcelain', {
    workdir: expandedRepo,
    sandboxPolicy: policy,
    timeoutMs: 15000,
  })
  const records = parseWorktreeList(listOut)
  const normalizedTarget = resolve(worktree)
  const atPath = records.find((r) => r.path === normalizedTarget)
  const atBranch = records.find((r) => r.branch === branch)
  const pathExists = existsSync(normalizedTarget)
  let pathEmpty = false
  if (pathExists) {
    const { readdir } = await import('node:fs/promises')
    pathEmpty = (await readdir(normalizedTarget)).length === 0
  }
  const branchOut = await runCommand(
    ctx,
    `git show-ref --verify --quiet ${shellQuote(`refs/heads/${branch}`)}; echo $?`,
    { workdir: expandedRepo, sandboxPolicy: policy, timeoutMs: 15000 },
  )
  const branchExists = branchOut.trim() === '0'
  const recovery = decideWorktreeRecovery({
    targetBranch: branch,
    pathExists,
    pathEmpty,
    registeredBranch: atPath?.branch ?? null,
    branchExists,
    branchWorktree: atBranch?.path ?? null,
  })
  const detachedHead =
    recovery.kind === 'attach-detached' || recovery.kind === 'attach-existing'
      ? await runCommand(ctx, 'git rev-parse HEAD', {
          workdir: normalizedTarget,
          timeoutMs: 10_000,
          sandboxPolicy: policy,
        })
      : null

  if (recovery.kind === 'conflict') {
    await appendLog(workflow.key, 'dev', `[clickvibe] worktree 冲突: ${recovery.reason}`)
    return { ok: false, error: `worktree 冲突: ${recovery.reason}` }
  }

  if (firstBaseSelection && (branchExists || recovery.kind === 'attach-detached')) {
    if (explicitCustomBase) {
      return {
        ok: false,
        error: `既有开发分支 ${branch} 缺少冻结基线记录,无法证明从所选基线 ${remoteBase} 创建;拒绝定格或暗改 worktree`,
      }
    }
    const candidate = branchExists ? `refs/heads/${branch}` : 'HEAD'
    const candidateWorkdir = branchExists ? expandedRepo : normalizedTarget
    const compatible = await runCommand(
      ctx,
      `git merge-base --is-ancestor ${shellQuote(remoteBaseHash ?? remoteBase)} ${shellQuote(candidate)}`,
      { workdir: candidateWorkdir, timeoutMs: 10_000, sandboxPolicy: policy },
    )
      .then(() => true)
      .catch(() => false)
    if (!compatible) {
      return { ok: false, error: `既有开发分支 ${branch} 不包含所选基线 ${remoteBase},拒绝定格或暗改 worktree` }
    }
  }

  if (recovery.kind === 'reuse') {
    await appendLog(workflow.key, 'dev', `[clickvibe] worktree 已存在,复用`)
  } else if (recovery.kind === 'attach-detached') {
    await runCommand(ctx, `git switch -c ${shellQuote(branch)}`, {
      workdir: normalizedTarget,
      timeoutMs: 60000,
      sandboxPolicy: policy,
    })
    notifyLocalGitMutation({ repoKey, worktreePath: worktree }, 'worktree-mutation', 'ensureWorktree')
    await appendLog(workflow.key, 'dev', `[clickvibe] 已为 detached worktree 创建目标分支`)
  } else if (recovery.kind === 'attach-existing') {
    await runCommand(ctx, `git switch ${shellQuote(branch)}`, {
      workdir: normalizedTarget,
      timeoutMs: 60000,
      sandboxPolicy: policy,
    })
    notifyLocalGitMutation({ repoKey, worktreePath: worktree }, 'worktree-mutation', 'ensureWorktree')
    await appendLog(workflow.key, 'dev', `[clickvibe] 已将 detached worktree 切换到现有目标分支`)
  } else if (recovery.kind === 'repair') {
    if (!remoteBaseExists && !branchExists) return { ok: false, error: `基线分支已不存在: ${remoteBase}` }
    // stale 注册:先清理 git 注册记录(路径为空时可顺带删空目录),再重建
    await appendLog(workflow.key, 'dev', `[clickvibe] 修复 stale 注册: ${recovery.reason}`)
    if (pathExists && pathEmpty) {
      const { rmdir } = await import('node:fs/promises')
      await rmdir(normalizedTarget).catch(() => {
        /* 非空时忽略,交给 git */
      })
    }
    await runCommand(ctx, `git worktree remove --force ${shellQuote(normalizedTarget)}`, {
      workdir: expandedRepo,
      timeoutMs: 60000,
      sandboxPolicy: policy,
    }).catch(() => {
      /* 记录已不在也忽略 */
    })
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirname(normalizedTarget), { recursive: true })
    const command = buildWorktreeAddCommand({
      path: normalizedTarget,
      branch,
      branchExists,
      remoteBase: remoteBaseHash ?? remoteBase,
    })
    await runCommand(ctx, command, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy })
    notifyLocalGitMutation({ repoKey, worktreePath: worktree }, 'worktree-mutation', 'ensureWorktree')
    await appendLog(workflow.key, 'dev', `[clickvibe] stale worktree 已重建`)
  } else {
    // add-new-branch / add-existing-branch:确保父目录存在后创建/复用
    const { mkdir } = await import('node:fs/promises')
    await mkdir(dirname(normalizedTarget), { recursive: true })
    if (!remoteBaseExists && recovery.kind === 'add-new-branch') {
      return { ok: false, error: `基线分支已不存在: ${remoteBase}` }
    }
    const command = buildWorktreeAddCommand({
      path: normalizedTarget,
      branch,
      branchExists: recovery.kind !== 'add-new-branch',
      remoteBase: remoteBaseHash ?? remoteBase,
    })
    await runCommand(ctx, command, { workdir: expandedRepo, timeoutMs: 60000, sandboxPolicy: policy })
    notifyLocalGitMutation({ repoKey, worktreePath: worktree }, 'worktree-mutation', 'ensureWorktree')
    await appendLog(
      workflow.key,
      'dev',
      recovery.kind === 'add-new-branch'
        ? `[clickvibe] worktree 与分支创建完成`
        : `[clickvibe] 已从现有分支恢复 worktree`,
    )
  }

  // startDevelop holds the workflow lock across worktree preparation and task
  // reservation. Freeze the baseline only after preparation succeeds. The
  // revision-bound metadata commit is the sole persistence point, so another
  // controller cannot silently replace the selected base or lifecycle facts.
  if (firstBaseSelection) workflow.baseRef = `${remoteBase} @ ${remoteBaseHash}`
  try {
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
        worktree: workflow.worktree,
        branch: workflow.branch,
        baseRef: workflow.baseRef,
      }),
    )
  } catch (error) {
    if (firstBaseSelection) {
      const rollbackErrors: string[] = []
      const rollback = async (command: string, workdir: string) => {
        try {
          await runCommand(ctx, command, { workdir, timeoutMs: 60_000, sandboxPolicy: policy })
        } catch (rollbackError) {
          rollbackErrors.push(String(rollbackError instanceof Error ? rollbackError.message : rollbackError))
        }
      }
      const createdBranch =
        recovery.kind === 'add-new-branch' ||
        recovery.kind === 'attach-detached' ||
        (recovery.kind === 'repair' && !branchExists)
      if (recovery.kind === 'add-new-branch') {
        await rollback(`git worktree remove --force ${shellQuote(normalizedTarget)}`, expandedRepo)
      } else if (recovery.kind === 'add-existing-branch' || recovery.kind === 'repair') {
        await rollback(`git worktree remove --force ${shellQuote(normalizedTarget)}`, expandedRepo)
      } else if (recovery.kind === 'attach-detached' || recovery.kind === 'attach-existing') {
        if (detachedHead) await rollback(`git switch --detach ${shellQuote(detachedHead)}`, normalizedTarget)
      }
      if (createdBranch) await rollback(`git branch -D ${shellQuote(branch)}`, expandedRepo)
      notifyLocalGitMutation({ repoKey, worktreePath: worktree }, 'worktree-rollback', 'ensureWorktree')
      const detail = String(error instanceof Error ? error.message : error)
      const rollbackDetail = rollbackErrors.length > 0 ? `; worktree 回滚失败: ${rollbackErrors.join('; ')}` : ''
      return { ok: false, error: `无法定格开发基线: ${detail}${rollbackDetail}` }
    }
    return {
      ok: false,
      error:
        error instanceof WorkflowConflictError
          ? 'Workflow 已由另一控制器推进,请刷新后重试'
          : `Workflow 持久化失败:${String(error instanceof Error ? error.message : error)}`,
    }
  }
  return { ok: true, workflow, worktree, branch }
}

/** Parse `git worktree list --porcelain` output into { path, branch } records. */
export function parseWorktreeList(output: string): { path: string; branch: string | null }[] {
  const records: { path: string; branch: string | null }[] = []
  let current: { path: string; branch: string | null } | null = null
  for (const line of output.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') {
      if (current) {
        records.push(current)
        current = null
      }
      continue
    }
    if (trimmed.startsWith('worktree ')) {
      current = { path: trimmed.slice('worktree '.length), branch: null }
    } else if (trimmed.startsWith('branch ') && current) {
      current.branch = trimmed.slice('branch refs/heads/'.length)
    } else if (trimmed.startsWith('detached') && current) {
      current.branch = 'HEAD'
    }
  }
  if (current) records.push(current)
  return records
}
