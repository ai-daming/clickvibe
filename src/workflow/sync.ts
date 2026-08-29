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
import type { Context } from '@deepseek-ai/cordis'
import { remoteFetch, remotePush } from '../infra/remote-git.ts'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { updateBaseTip } from '../agent/baseline.ts'
import { shellQuote } from '../infra/develop-core.ts'
import { conflictFileSuffix, hasMergeConflict, listConflictFiles } from '../infra/git.ts'
import { parseUrl, readWorktreeHead, runCommand } from '../infra/runtime.ts'
import {
  appendEvent,
  appendLog,
  commitWorkflowMetadata,
  issueKey,
  loadWorkflow,
  workflowRevision,
} from '../infra/state.ts'
import { observeWorkflowTask, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { withWorkflowLock } from '../infra/workflow-lock.ts'
import { workflowBaseBranch } from './state-view.ts'

type SyncResult =
  | { ok: true; worktree: string; branch: string; head: string | null }
  | { ok: false; error: string; conflict?: boolean; files?: string[] }

/** Sync a workflow's worktree with the remote base, then push the PR branch.
 *  Keeps the worktree on the latest base so dev/review never target stale code
 *  (issue #5). The merge result is recorded as a timeline event.
 *  合并冲突时不回滚:现场(MERGE_HEAD + 冲突标记)原样保留,转交返工 agent
 *  解决(issue #26),避免「同步失败 → 门禁不放行 rework」的死锁。 */
export async function syncWorktree(ctx: Context, payload: unknown): Promise<SyncResult> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') {
    return { ok: false, error: '请输入形如 https://github.com/owner/repo/issues/123 的链接' }
  }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  return await withWorkflowLock(key, async () => syncWorktreeLocked(ctx, key))
}

async function syncWorktreeLocked(ctx: Context, key: string): Promise<SyncResult> {
  const workflow = await loadWorkflow(key)
  if (!workflow || !existsSync(workflow.worktree)) {
    return { ok: false, error: '该 issue 尚无 worktree,无法同步' }
  }
  const ownership = observeWorkflowTask(ctx as unknown as TaskOwnershipContext, workflow)
  if (ownership.state === 'running' || ownership.state === 'unknown') {
    return { ok: false, error: 'Agent 任务仍运行或状态未知,拒绝并发修改 worktree;请先确认任务终态' }
  }
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: workflow.worktree }
  const remoteBase = `origin/${workflowBaseBranch(workflow.baseRef)}`
  try {
    // Do not rely on git merge to reject a dirty tree:Git permits unrelated
    // local changes, which would otherwise let the merge commit be pushed.
    // An existing conflicted merge keeps following the conflict-preservation
    // path below so callers still receive conflict:true and the file list.
    if (!(await hasMergeConflict(ctx, workflow.worktree))) {
      const changes = await runCommand(ctx, 'git status --porcelain', {
        workdir: workflow.worktree,
        timeoutMs: 10_000,
        sandboxPolicy: { mode: 'read-only', workspaceRoot: workflow.worktree },
      })
      if (changes) throw new Error('worktree 有未提交改动,请先提交或清理后再同步')
    }
    await appendLog(workflow.key, 'dev', '[clickvibe] 同步:git fetch origin…')
    await remoteFetch(ctx, {
      workdir: workflow.worktree,
      timeoutMs: 60_000,
      sandboxPolicy: policy,
    })
    const baseTip = await runCommand(ctx, `git rev-parse --verify ${shellQuote(`${remoteBase}^{commit}`)}`, {
      workdir: workflow.worktree,
      timeoutMs: 10_000,
      sandboxPolicy: policy,
    }).catch(() => {
      throw new Error(`基线分支已不存在: ${remoteBase}`)
    })
    const beforeMerge = await runCommand(ctx, 'git rev-parse --verify HEAD', {
      workdir: workflow.worktree,
      timeoutMs: 10_000,
      sandboxPolicy: policy,
    })
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步:合并 ${remoteBase}…`)
    try {
      await runCommand(ctx, `git merge --no-edit ${shellQuote(baseTip)}`, {
        workdir: workflow.worktree,
        timeoutMs: 60_000,
        sandboxPolicy: policy,
      })
    } catch (error) {
      // issue #26:合并冲突不再 abort 回滚丢弃现场。冲突状态(MERGE_HEAD +
      // 冲突标记)原样保留,转交返工 agent 解决;非冲突失败(如本地脏改动
      // 导致 git 自行中止)没有可保留的现场,照旧透传错误。
      if (await hasMergeConflict(ctx, workflow.worktree)) {
        const message = String(error instanceof Error ? error.message : error)
        // 冲突详情透传(issue #26):文件清单记日志、进时间线、随错误返回面板
        const files = await listConflictFiles(ctx, workflow.worktree)
        const suffix = conflictFileSuffix(files)
        const note = `合并 ${remoteBase} 冲突,现场已保留(未回滚),转交返工 agent 处理${suffix}`
        await appendLog(workflow.key, 'dev', `[clickvibe] ${note}`)
        const reloaded = await loadWorkflow(workflow.key)
        if (reloaded) {
          await appendEvent(
            reloaded,
            {
              kind: 'note',
              at: new Date().toISOString(),
              note,
            },
            workflowRevision(reloaded) ?? 0,
          )
        }
        notifyLocalGitMutation(
          { repoKey: workflow.repoKey, worktreePath: workflow.worktree },
          'worktree-sync-conflict',
          'syncWorktree',
        )
        return {
          ok: false,
          conflict: true,
          files,
          error: `合并 ${remoteBase} 冲突,现场已保留:${message}${suffix}。可直接「按意见返工」,agent 会先解决冲突再修意见`,
        }
      }
      throw error
    }
    try {
      const current = await loadWorkflow(workflow.key)
      if (!current) throw new Error('同步期间 workflow 已不存在')
      Object.assign(
        current,
        await commitWorkflowMetadata(current, workflowRevision(current), {
          baseRef: updateBaseTip(current.baseRef, remoteBase, baseTip),
        }),
      )
    } catch (persistError) {
      try {
        await runCommand(ctx, `git reset --hard ${shellQuote(beforeMerge)}`, {
          workdir: workflow.worktree,
          timeoutMs: 30_000,
          sandboxPolicy: policy,
        })
      } catch (rollbackError) {
        throw new Error(
          `基线 tip 持久化失败且无法回滚同步提交:${String(
            persistError instanceof Error ? persistError.message : persistError,
          )};回滚失败:${String(rollbackError instanceof Error ? rollbackError.message : rollbackError)}`,
        )
      }
      throw new Error(
        `基线 tip 持久化失败,已回滚同步提交:${String(
          persistError instanceof Error ? persistError.message : persistError,
        )}`,
      )
    }
    const head = await readWorktreeHead(ctx, workflow.worktree)
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步:推送 ${workflow.branch} 到 origin…`)
    await remotePush(ctx, {
      workdir: workflow.worktree,
      timeoutMs: 60_000,
      sandboxPolicy: policy,
      refspec: shellQuote(workflow.branch),
    })
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步并推送完成,HEAD ${head ?? '未知'}`)
    // 记录同步事件到权威时间线(不改变开发/审查语义)
    const reloaded = await loadWorkflow(workflow.key)
    if (reloaded) {
      await appendEvent(
        reloaded,
        {
          kind: 'note',
          at: new Date().toISOString(),
          hash: head ?? undefined,
          note: `worktree 已同步到 ${remoteBase}`,
        },
        workflowRevision(reloaded) ?? 0,
      )
    }
    notifyLocalGitMutation(
      { repoKey: workflow.repoKey, worktreePath: workflow.worktree },
      'worktree-sync',
      'syncWorktree',
    )
    return { ok: true, worktree: workflow.worktree, branch: workflow.branch, head }
  } catch (error) {
    const message = String(error instanceof Error ? error.message : error)
    notifyLocalGitMutation(
      { repoKey: workflow.repoKey, worktreePath: workflow.worktree },
      'worktree-sync-failed',
      'syncWorktree',
    )
    await appendLog(workflow.key, 'dev', `[clickvibe] 同步失败: ${message}`)
    return { ok: false, error: `同步失败: ${message}` }
  }
}
