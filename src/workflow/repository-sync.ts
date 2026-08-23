/** Repository-level advance signal and safe-sync workflow. */
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { hasMergeConflict, listConflictFiles } from '../infra/git.ts'
import {
  forwardLocalMain,
  mergeRepositoryCheckout,
  readRepositoryGitFacts,
  readRepositorySyncGitFacts,
} from '../infra/repository-git.ts'
import { type ClickVibeConfig, expandHome, loadConfig, readWorktreeHead, runCommand } from '../infra/runtime.ts'
import { decideRepositorySync, deriveRepositoryAdvance, type RepositoryAdvance } from './repository-sync-policy.ts'

export interface RepositoryAdvanceSignal extends RepositoryAdvance {
  fetchedAt: number | null
}

type TargetStatus =
  | 'unchanged'
  | 'fast-forwarded'
  | 'merged'
  | 'conflict'
  | 'refused'
  | 'diverged'
  | 'checked-out'
  | 'unavailable'
  | 'failed'

interface TargetReport {
  status: TargetStatus
  reason?: string
  head?: string | null
  files?: string[]
}

export interface RepositorySyncResult {
  ok: true
  branchHead: { branch: string; head: string | null } | null
  mainRefForwarded: boolean
  conflict: { files: string[] } | null
  refused: string[]
  targets: {
    checkout: TargetReport & { branch: string | null }
    main: TargetReport
  }
}

function errorText(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
}

function configuredRepoPath(config: ClickVibeConfig, repoKey: string): string | null {
  const configured = config.repos[repoKey]
  if (!configured) return null
  const repoPath = resolve(expandHome(configured))
  return existsSync(repoPath) ? repoPath : null
}

export async function readConfiguredRepositoryAdvance(
  ctx: Context,
  config: ClickVibeConfig,
  repoKey: string,
  fetchedAt: number | null,
): Promise<RepositoryAdvanceSignal | null> {
  const repoPath = configuredRepoPath(config, repoKey)
  if (!repoPath) return null
  const facts = await readRepositoryGitFacts(ctx, repoPath)
  return { ...deriveRepositoryAdvance(facts), fetchedAt }
}

export async function syncConfiguredRepository(
  ctx: Context,
  payload: unknown,
): Promise<RepositorySyncResult | { ok: false; error: string }> {
  const repoKey = String((payload as { repoKey?: unknown } | undefined)?.repoKey ?? '').trim()
  const config = await loadConfig()
  const repoPath = configuredRepoPath(config, repoKey)
  if (!repoKey || !repoPath) return { ok: false, error: `未配置或无法访问项目 ${repoKey || '(空)'}` }

  try {
    await runCommand(ctx, 'git fetch origin --prune', {
      workdir: repoPath,
      timeoutMs: 60_000,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
    })
  } catch (error) {
    return { ok: false, error: `同步失败:无法 fetch origin:${errorText(error)}` }
  }

  const facts = await readRepositorySyncGitFacts(ctx, repoPath)
  const decision = decideRepositorySync(facts)
  const remoteRef = `origin/${facts.defaultBranch}`
  const refused: string[] = []
  let branchHead: RepositorySyncResult['branchHead'] = null
  let conflict: RepositorySyncResult['conflict'] = null
  let checkout: RepositorySyncResult['targets']['checkout'] = {
    branch: facts.checkoutBranch,
    status: 'unchanged',
  }

  if (decision.checkout === 'detached') {
    const reason = '当前 checkout 不在任何分支上(detached HEAD),无法安全同步'
    refused.push(reason)
    checkout = { branch: null, status: 'refused', reason }
  } else if (decision.checkout === 'dirty') {
    const reason = '当前 checkout 有未提交改动,请先提交或清理后再同步;不会自动 stash 或覆盖改动'
    refused.push(reason)
    checkout = { branch: facts.checkoutBranch, status: 'refused', reason }
  } else if (decision.checkout === 'unavailable') {
    const reason = '无法读取当前 checkout 状态或与远端默认分支比较,未执行同步'
    refused.push(reason)
    checkout = { branch: facts.checkoutBranch, status: 'unavailable', reason }
  } else if (decision.checkout === 'fast-forward' || decision.checkout === 'merge') {
    try {
      await mergeRepositoryCheckout(ctx, repoPath, remoteRef, decision.checkout === 'fast-forward')
      const head = await readWorktreeHead(ctx, repoPath)
      branchHead = { branch: facts.checkoutBranch as string, head }
      checkout = {
        branch: facts.checkoutBranch,
        status: decision.checkout === 'fast-forward' ? 'fast-forwarded' : 'merged',
        head,
      }
    } catch (error) {
      if (decision.checkout === 'merge' && (await hasMergeConflict(ctx, repoPath))) {
        const files = await listConflictFiles(ctx, repoPath)
        const reason =
          '合并冲突现场已保留;请在主仓库 workspace 让 agent 处理(附加说明:先同步最新代码并解决冲突),或手动解决后继续'
        conflict = { files }
        checkout = { branch: facts.checkoutBranch, status: 'conflict', files, reason }
      } else {
        const reason = `当前 checkout 同步失败:${errorText(error)}`
        refused.push(reason)
        checkout = { branch: facts.checkoutBranch, status: 'failed', reason }
      }
    }
  }

  let main: RepositorySyncResult['targets']['main']
  let mainRefForwarded = false
  if (decision.main === 'checked-out') {
    main = { status: 'checked-out', reason: '本地 main 正由当前 checkout 目标处理' }
  } else if (decision.main === 'unavailable') {
    main = { status: 'unavailable', reason: '本地 main 或远端默认分支不可比较,未移动 ref' }
  } else if (decision.main === 'diverged') {
    const reason = `本地 main 与 ${remoteRef} 已分叉,拒绝移动 ref`
    refused.push(reason)
    main = { status: 'diverged', reason }
  } else if (decision.main === 'fast-forward') {
    try {
      await forwardLocalMain(ctx, repoPath, remoteRef)
      mainRefForwarded = true
      main = { status: 'fast-forwarded' }
    } catch (error) {
      const reason = `本地 main 快进失败:${errorText(error)}`
      refused.push(reason)
      main = { status: 'failed', reason }
    }
  } else {
    main = { status: 'unchanged' }
  }

  return { ok: true, branchHead, mainRefForwarded, conflict, refused, targets: { checkout, main } }
}
