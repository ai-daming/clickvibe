import { existsSync } from 'node:fs'
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
import { remoteFetch } from '../infra/remote-git.ts'
import { fetchIssueRestDetail } from '../github/reads.ts'
import { type MergeOverrideGate, shellQuote } from '../infra/develop-core.ts'
import { parseUrl, runCommand } from '../infra/runtime.ts'
import { type IssueContractSnapshot, type IssueWorkflow, issueBodyHash, type WorkflowEvent } from '../infra/state.ts'
import { workflowBaseBranch } from './state-view.ts'

export interface ReviewIssueContract {
  title: string
  body: string
  state: string
  contract: IssueContractSnapshot
}

/** Read the exact Issue contract that one review run evaluates. */
export async function fetchIssueContract(ctx: Context, url: string, force = false): Promise<ReviewIssueContract> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('review workflow 缺少有效 Issue URL')
  const item = await fetchIssueRestDetail(ctx, `${parsed.owner}/${parsed.repo}`, parsed.number, force, 5_000)
  const body = String(item.body ?? '')
  return {
    title: String(item.title ?? ''),
    body,
    state: String(item.state ?? '').toUpperCase(),
    contract: {
      bodyHash: issueBodyHash(body),
      updatedAt: String(item.updated_at ?? ''),
    },
  }
}

export function latestPassingReview(workflow: IssueWorkflow): WorkflowEvent | null {
  const latestReview = [...(workflow.events ?? [])].reverse().find((event) => event.kind === 'review') ?? null
  if (!latestReview?.verdict?.passed || !workflow.reviewResult?.passed) return null
  return latestReview
}

export function latestPassingReviewHash(workflow: IssueWorkflow): string | null {
  return latestPassingReview(workflow)?.hash?.trim() || null
}

export function sameCommitHash(reviewedHash: string, prHead: string): boolean {
  const reviewed = reviewedHash.trim().toLowerCase()
  const head = prHead.trim().toLowerCase()
  return (
    reviewed.length >= 7 &&
    head.length >= 7 &&
    (reviewed === head || head.startsWith(reviewed) || reviewed.startsWith(head))
  )
}

/** One failing ClickVibe merge gate; all items are eligible for manual override (issue #49). */
export interface MergeGateFailure {
  key: MergeOverrideGate
  message: string
}

/**
 * 判定实时 PR HEAD 是否为「R 与冻结远端基线的纯同步合并」(issue #48/#60):
 * H 必须是恰好两个父提交的 merge commit,其中一个父提交精确等于被审提交 R
 * (R 的任何后代 —— 分支侧新提交、叠加 merge —— 都不放行),另一个父提交位于
 * 当前 origin/<base> 的历史上,且 H 的树与 git merge-tree 对两父的自动合并结果
 * 完全一致 —— 任何手工冲突决断(哪怕一行)都会破坏该等价。
 * 任一 git 事实无法核实时按不满足处理(fail closed)。
 */
export async function isSyncEquivalentMerge(
  ctx: Context,
  repoKey: string,
  worktree: string,
  reviewedHash: string,
  prHead: string,
  baseBranch = 'main',
  baseHash?: string,
): Promise<boolean> {
  if (!existsSync(worktree)) return false
  const policy = { mode: 'danger-full-access' as const, workspaceRoot: worktree }
  const gitOk = async (args: string, timeoutMs = 30_000): Promise<boolean> => {
    try {
      await runCommand(ctx, `git ${args}`, { workdir: worktree, timeoutMs, sandboxPolicy: policy })
      return true
    } catch {
      return false
    }
  }
  const gitOut = async (args: string): Promise<string | null> => {
    try {
      const output = await runCommand(ctx, `git ${args}`, {
        workdir: worktree,
        timeoutMs: 30_000,
        sandboxPolicy: policy,
      })
      return output.trim() || null
    } catch {
      return null
    }
  }
  const remoteBase = `origin/${baseBranch}`
  // 先同步远端:被检的 H(远端分支 HEAD)与最新冻结基线对象必须在本地可解析
  if (
    !(await remoteFetch(ctx, { repoKey, workdir: worktree, timeoutMs: 60_000, sandboxPolicy: policy })
      .then(() => true)
      .catch(() => false))
  )
    return false
  const head = await gitOut(`rev-parse --verify ${shellQuote(`${prHead}^{commit}`)}`)
  const reviewed = await gitOut(`rev-parse --verify ${shellQuote(`${reviewedHash}^{commit}`)}`)
  if (!head || !reviewed || head === reviewed) return false
  const parentsLine = await gitOut(`rev-list --parents -n 1 ${head}`)
  if (!parentsLine) return false
  const [headOid, ...parents] = parentsLine.split(/\s+/)
  if (headOid !== head || parents.length !== 2) return false
  if (!parents.includes(reviewed)) return false
  const mainSide = parents[0] === reviewed ? parents[1] : parents[0]
  if (baseHash && !sameCommitHash(mainSide, baseHash)) return false
  // 另一父必须位于当前冻结基线历史上(同步来源只能是该 base)
  const mergeBase = await gitOut(`merge-base ${mainSide} ${shellQuote(remoteBase)}`)
  if (!mergeBase || mergeBase !== mainSide) return false
  // 树等价:H 的树必须与 R、main 侧的干净自动合并结果逐字节一致
  const autoTree = await gitOut(`merge-tree --write-tree ${reviewed} ${mainSide}`)
  const headTree = autoTree === null ? null : await gitOut(`rev-parse ${head}^{tree}`)
  return !!autoTree && !!headTree && headTree === autoTree.split(/\s+/)[0]
}

/**
 * 合并门禁的 HEAD 一致性校验(issue #48):R 与 H 哈希一致直接放行;不一致时
 * 唯一例外是 H 为 R 与最新冻结基线的纯同步合并,其余(含 H 比 R 旧、
 * 分叉、分支侧新提交)一律要求重新 Review。
 */
export async function assertReviewHeadMatchesPr(
  ctx: Context,
  repoKey: string,
  worktree: string,
  reviewedHash: string | null,
  prHead: string | null | undefined,
  baseBranch = 'main',
): Promise<void> {
  if (prHead && reviewedHash) {
    if (sameCommitHash(reviewedHash, prHead)) return
    if (await isSyncEquivalentMerge(ctx, repoKey, worktree, reviewedHash, prHead, baseBranch)) return
  }
  throw new Error('合并门禁拒绝:实时 PR HEAD 与最近一次通过的 review 结论哈希不一致,且不满足同步等价,需重新 Review')
}

/**
 * Collect every failing ClickVibe-side merge gate in the historical rejection
 * order (hash first, then contract). GitHub-side protections are not gates here
 * and can never be overridden. The hash gate reuses the issue #48 head check,
 * so a pure sync merge of the reviewed commit with its frozen base passes without
 * re-review; its message stays in sync with the assert-based wording.
 */
export async function collectMergeGateFailures(
  ctx: Context,
  workflow: IssueWorkflow,
  prHead: string,
  prBase?: { ref: string; sha: string },
): Promise<MergeGateFailure[]> {
  const failures: MergeGateFailure[] = []
  const review = latestPassingReview(workflow)
  const reviewedHash = review?.hash?.trim() || null
  const exactHead = !!reviewedHash && sameCommitHash(reviewedHash, prHead)
  const sameBaseRef = !!prBase && review?.reviewBase?.ref === prBase.ref
  const syncEquivalent =
    !exactHead &&
    !!reviewedHash &&
    (await isSyncEquivalentMerge(
      ctx,
      workflow.repoKey,
      workflow.worktree,
      reviewedHash,
      prHead,
      prBase?.ref ?? workflowBaseBranch(workflow.baseRef),
      sameBaseRef ? prBase?.sha : undefined,
    ))
  if (!exactHead && !syncEquivalent) {
    failures.push({
      key: 'review-hash',
      message: '实时 PR HEAD 与最近一次通过的 review 结论哈希不一致,且不满足同步等价,需重新 Review',
    })
  }
  if (prBase) {
    const reviewedBase = review?.reviewBase
    const exactBase = !!reviewedBase && reviewedBase.ref === prBase.ref && sameCommitHash(reviewedBase.sha, prBase.sha)
    if (!exactBase && !(sameBaseRef && syncEquivalent)) {
      failures.push({ key: 'review-base', message: '实时 PR base 与最近一次通过的 review 基线不一致,需重新 Review' })
    }
  }
  const reviewedContract = latestPassingReview(workflow)?.issueContract
  if (!reviewedContract) {
    failures.push({ key: 'review-contract-missing', message: '最近通过的 review 缺少验收契约快照,需重新 Review' })
  } else {
    let current: ReviewIssueContract
    try {
      current = await fetchIssueContract(ctx, workflow.url, true)
    } catch (error) {
      failures.push({
        key: 'contract-unreadable',
        message: `无法读取当前验收契约: ${String(error instanceof Error ? error.message : error)}`,
      })
      return failures
    }
    if (current.contract.bodyHash !== reviewedContract.bodyHash) {
      failures.push({ key: 'contract-changed', message: '验收契约已变更,需重新 Review' })
    }
  }
  return failures
}

/** First-failure rejection text; identical to the pre-override single-gate errors. */
export function mergeGateRejection(failures: MergeGateFailure[]): string {
  return `合并门禁拒绝:${failures[0]?.message ?? '未知原因'}`
}
