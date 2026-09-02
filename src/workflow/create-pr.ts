import type { Context } from '@deepseek-ai/cordis'
import { ensurePullRequest } from '../github/pr.ts'
import { githubWriteOutcomeError, githubWriteRecoverOperation } from '../github/writes.ts'
import { notifyLocalGitMutation } from '../infra/local-git-snapshot.ts'
import { remotePush } from '../infra/remote-git.ts'
import { shellQuote } from '../infra/develop-core.ts'
import { parseUrl, runCommand } from '../infra/runtime.ts'
import { appendLog, issueKey, loadWorkflow, commitWorkflowMetadata, workflowRevision } from '../infra/state.ts'
import { observeWorkflowTask, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { withWorkflowLock } from '../infra/workflow-lock.ts'
import { persistRemoteGitAttempt, recoverWorkflowRemotePush } from './remote-git-attempt.ts'
import { workflowBaseBranch } from './state-view.ts'

export async function createPullRequest(
  ctx: Context,
  payload: unknown,
): Promise<{ ok: true; prNumber: string; created: boolean } | { ok: false; error: string }> {
  const url = String((payload as { url?: unknown } | undefined)?.url ?? '').trim()
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') return { ok: false, error: '创建 PR 的目标必须是 GitHub Issue URL' }
  const key = issueKey(`${parsed.owner}/${parsed.repo}`, parsed.number)
  return withWorkflowLock(key, () => createPullRequestLocked(ctx, key, parsed.number))
}

async function createPullRequestLocked(
  ctx: Context,
  key: string,
  issueNumber: string,
): Promise<{ ok: true; prNumber: string; created: boolean } | { ok: false; error: string }> {
  const workflow = await loadWorkflow(key)
  if (!workflow) return { ok: false, error: '未找到该 issue 的 workflow' }
  if (workflow.issueState === 'CLOSED') return { ok: false, error: 'Issue 已关闭,拒绝创建 PR' }
  const createInput = {
    repoKey: workflow.repoKey,
    worktree: workflow.worktree,
    branch: workflow.branch,
    base: workflowBaseBranch(workflow.baseRef),
    issueNumber,
    title: workflow.issueSnapshot?.title || `Deliver issue #${issueNumber}`,
  }
  try {
    // Slice B restart recovery: a surviving pending marker means an earlier
    // attempt may have dispatched — readback ONLY, never a second create.
    if (workflow.prCreate?.status === 'pending') {
      const recovered = await githubWriteRecoverOperation(ctx, {
        operation: 'pr-create',
        input: {
          repoKey: createInput.repoKey,
          branch: createInput.branch,
          base: createInput.base,
          title: createInput.title,
          body: `Closes #${createInput.issueNumber}`,
        },
      })
      if (recovered.outcome !== 'confirmed') {
        return {
          ok: false,
          error: `上次 PR 创建结果未确认(${githubWriteOutcomeError(recovered)}),请稍后重试`,
        }
      }
      // Confirmed: the PR exists — fall through and adopt it via the reuse path.
    }
    const result = await ensurePullRequest(ctx, createInput, {
      beforeCreate: async () => {
        const policy = { mode: 'danger-full-access' as const, workspaceRoot: workflow.worktree }
        const recovered = await recoverWorkflowRemotePush(ctx, workflow, 'pr-push', workflow.worktree, policy)
        const branch = await runCommand(ctx, 'git branch --show-current', {
          workdir: workflow.worktree,
          timeoutMs: 10_000,
          sandboxPolicy: policy,
        })
        const dirty = await runCommand(ctx, 'git status --porcelain', {
          workdir: workflow.worktree,
          timeoutMs: 10_000,
          sandboxPolicy: policy,
        })
        const expectedOid = await runCommand(ctx, 'git rev-parse --verify HEAD^{commit}', {
          workdir: workflow.worktree,
          timeoutMs: 10_000,
          sandboxPolicy: policy,
        })
        if (branch !== workflow.branch) throw new Error('worktree 当前分支与 workflow 不一致,拒绝创建 PR')
        if (dirty !== '') throw new Error('worktree 有未提交改动,拒绝创建 PR')
        const destinationRef = `refs/heads/${workflow.branch}`
        const confirmedAttempt = recovered?.status === 'confirmed' ? recovered : workflow.remoteGitAttempts?.['pr-push']
        const alreadyConfirmed =
          confirmedAttempt?.status === 'confirmed' &&
          confirmedAttempt.expectedOid === expectedOid &&
          confirmedAttempt.destinationRef === destinationRef
        if (!alreadyConfirmed) {
          await remotePush(ctx, {
            repoKey: workflow.repoKey,
            workdir: workflow.worktree,
            timeoutMs: 120_000,
            sandboxPolicy: policy,
            prepare: async () => {
              const current = await loadWorkflow(workflow.key)
              if (!current || workflowRevision(current) !== workflowRevision(workflow)) {
                throw new Error('PR push 凭证已过期: workflow revision 已变化')
              }
              if (current.issueState === 'CLOSED' || current.prNumber) {
                throw new Error('PR push 凭证已过期: Issue 已关闭或 PR 已存在')
              }
              const ownership = observeWorkflowTask(ctx as unknown as TaskOwnershipContext, current)
              if (ownership.state === 'running' || ownership.state === 'unknown') {
                throw new Error('PR push 凭证已过期: Agent 任务运行中或状态未知')
              }
              const currentBranch = await runCommand(ctx, 'git branch --show-current', {
                workdir: current.worktree,
                timeoutMs: 10_000,
                sandboxPolicy: policy,
              })
              const currentDirty = await runCommand(ctx, 'git status --porcelain', {
                workdir: current.worktree,
                timeoutMs: 10_000,
                sandboxPolicy: policy,
              })
              const currentOid = await runCommand(ctx, 'git rev-parse --verify HEAD^{commit}', {
                workdir: current.worktree,
                timeoutMs: 10_000,
                sandboxPolicy: policy,
              })
              if (currentBranch !== current.branch || currentDirty !== '' || currentOid !== expectedOid) {
                throw new Error('PR push 凭证已过期: branch/HEAD/工作区已变化')
              }
              return {
                operationKind: 'push-set-upstream' as const,
                destinationRef,
                expectedOid,
                expectedRemoteOid: null,
              }
            },
            persistAttempt: async (attempt) => {
              await persistRemoteGitAttempt(workflow, 'pr-push', attempt)
            },
            settleAttempt: async (attempt) => {
              await persistRemoteGitAttempt(workflow, 'pr-push', attempt)
            },
          })
        }
        await runCommand(ctx, `git config ${shellQuote(`branch.${workflow.branch}.remote`)} origin`, {
          workdir: workflow.worktree,
          timeoutMs: 10_000,
          sandboxPolicy: policy,
        })
        await runCommand(
          ctx,
          `git config ${shellQuote(`branch.${workflow.branch}.merge`)} ${shellQuote(`refs/heads/${workflow.branch}`)}`,
          {
            workdir: workflow.worktree,
            timeoutMs: 10_000,
            sandboxPolicy: policy,
          },
        )
        notifyLocalGitMutation(
          { repoKey: workflow.repoKey, worktreePath: workflow.worktree },
          'pr-create-upstream-config',
          'createPullRequest',
        )
      },
      persistMarker: async () => {
        // The workflow file is the create-pr action's durable state: the
        // marker must be on disk before the POST dispatches.
        Object.assign(
          workflow,
          await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
            prCreate: { status: 'pending', at: new Date().toISOString() },
          }),
        )
      },
    })
    workflow.prNumber = result.number
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
        prNumber: workflow.prNumber,
        prCreate: undefined,
      }),
    )
    await appendLog(workflow.key, 'dev', `[clickvibe] ${result.created ? '已创建' : '已复用'} PR #${result.number}`)
    return { ok: true, prNumber: result.number, created: result.created }
  } catch (error) {
    return { ok: false, error: String(error instanceof Error ? error.message : error) }
  }
}
