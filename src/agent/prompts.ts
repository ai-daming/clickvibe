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
import { fetchIssue, issueSnapshot } from '../github/issue.ts'
import { fetchPrRestDetail, type GithubCommentRest } from '../github/reads.ts'
import { githubRest, isGithubRateLimitError } from '../github/rest.ts'
import { REVIEW_RESULT_RELATIVE_PATH } from '../infra/review-result.ts'
import { readWorktreeHead, runCommand } from '../infra/runtime.ts'
import {
  commitWorkflowMetadata,
  type IssueWorkflow,
  issueBodyHash,
  WorkflowConflictError,
  workflowRevision,
} from '../infra/state.ts'
import { frozenBaseHash, frozenRemoteBase } from './baseline.ts'
import { shellQuote } from './develop.ts'
import {
  buildStagePrompt,
  type PromptSnapshot,
  type SnapshotFreshness,
  selectReviewFeedback,
  snapshotWithoutReviewFeedback,
} from './prompt.ts'

export interface ResolvedPromptSnapshot {
  snapshot: PromptSnapshot
  freshness: SnapshotFreshness
  fetchError?: string
}

export async function fetchPrPromptComments(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<{ author: string; body: string }[] | null> {
  if (!workflow.prNumber) return []
  try {
    const rest = githubRest(ctx)
    const key = `${workflow.repoKey}/pulls/${workflow.prNumber}`
    const comments = await rest.cachedResource(`${key}/comments`, rest.resourceVersion(key), () =>
      rest.paginate<GithubCommentRest>(`repos/${workflow.repoKey}/issues/${workflow.prNumber}/comments`),
    )
    return comments.map((comment) => ({
      author: String(comment.user?.login ?? 'unknown'),
      body: String(comment.body ?? ''),
    }))
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}

/** Refresh at stage start; only a complete persisted snapshot may cover an outage. */
export async function resolvePromptSnapshot(
  ctx: Context,
  workflow: IssueWorkflow,
): Promise<ResolvedPromptSnapshot | { error: string }> {
  // A privileged stage start must revalidate the frozen authorization snapshot;
  // this security boundary intentionally bypasses the display cache.
  const fetched = await fetchIssue(ctx, { url: workflow.url, forceRefresh: true })
  if (fetched.ok) {
    const snapshot = issueSnapshot(fetched.data.item as Record<string, unknown>)
    const prComments = await fetchPrPromptComments(ctx, workflow)
    if (prComments) snapshot.comments.push(...prComments)
    workflow.issueSnapshot = snapshot
    if (snapshot.state === 'OPEN' || snapshot.state === 'CLOSED') workflow.issueState = snapshot.state
    const persistenceError = await persistPromptWorkflow(workflow)
    if (persistenceError) return { error: persistenceError }
    return { snapshot, freshness: 'current' }
  }
  const snapshot = workflow.issueSnapshot
  if (!snapshot) {
    return { error: `无法刷新 Issue,且没有可回退的持久化需求快照: ${fetched.error}` }
  }
  workflow.issueSnapshot = snapshot
  const persistenceError = await persistPromptWorkflow(workflow)
  if (persistenceError) return { error: persistenceError }
  return { snapshot, freshness: 'persisted', fetchError: fetched.error.slice(0, 500) }
}

async function persistPromptWorkflow(workflow: IssueWorkflow): Promise<string | null> {
  try {
    Object.assign(
      workflow,
      await commitWorkflowMetadata(workflow, workflowRevision(workflow), {
        issueSnapshot: workflow.issueSnapshot,
        issueState: workflow.issueState,
      }),
    )
    return null
  } catch (error) {
    return error instanceof WorkflowConflictError
      ? 'Workflow 已由另一控制器推进,本次启动已取消;请刷新后重试'
      : `需求快照持久化失败:${String(error instanceof Error ? error.message : error)}`
  }
}

export function sameSnapshot(left: PromptSnapshot, right: PromptSnapshot): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

const COMMON_DEVELOPMENT_REQUIREMENTS = [
  '先理解当前需求快照;如有歧义可自行判断或提问。',
  '实现代码改动,并保留现有 worktree 中尚未提交的有效工作。',
  '运行相关测试。',
  '完成后 git commit 并推送当前分支。',
]

function developmentRequirements(baseRef: string | null): string[] {
  const remoteBase = frozenRemoteBase(baseRef) ?? 'origin/main'
  const baseBranch = remoteBase.replace(/^origin\//, '')
  return [
    `先执行 git fetch origin 同步远端,并检查开发基线(${remoteBase})是否有更新;若已有更新,先合并或变基到最新再继续。`,
    ...COMMON_DEVELOPMENT_REQUIREMENTS,
    `用 gh 创建或更新 PR(若适用);首次创建必须显式执行 gh pr create --base ${baseBranch},不得依赖仓库默认分支。`,
  ]
}

export function buildDevelopPrompt(
  workflow: IssueWorkflow,
  resolved: ResolvedPromptSnapshot,
  extraContext: string,
  firstDevelopment: boolean,
): string {
  // 附加说明只把「非首次开发」升级为返工;首次开工带说明仍是开发(issue #54)。
  const rework = extraContext !== '' && !firstDevelopment
  return buildStagePrompt({
    stage: rework ? 'rework' : 'develop',
    ...resolved,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `开发基线: ${workflow.baseRef ?? '未知'}`,
      ...(extraContext ? ['附加上下文:', extraContext] : []),
    ],
    requirements: developmentRequirements(workflow.baseRef),
  })
}

export interface ReviewBaseTarget {
  ref: string
  sha: string
}

function exactCommitHash(value: string): string {
  const hash = value.trim()
  return /^[0-9a-f]{4,64}$/i.test(hash) ? hash : ''
}

export async function resolveReviewBaseTarget(ctx: Context, workflow: IssueWorkflow): Promise<ReviewBaseTarget> {
  let ref = (frozenRemoteBase(workflow.baseRef) ?? 'origin/main').replace(/^origin\//, '')
  let sha = frozenBaseHash(workflow.baseRef) ?? ''
  let prSha = ''
  if (workflow.prNumber) {
    const target = await fetchPrBaseTarget(ctx, workflow.repoKey, workflow.prNumber)
    if (!target) throw new Error(`无法读取 PR #${workflow.prNumber} 的基线身份,拒绝启动可能审错范围的 review`)
    ref = target.ref
    prSha = exactCommitHash(target.sha ?? '')
    if (target.sha && !prSha) throw new Error(`PR #${workflow.prNumber} 返回了无效的基线 commit,拒绝启动 review`)
  }
  const remote = `origin/${ref}`
  if (prSha) return { ref, sha: prSha }
  if (!workflow.baseRef && !workflow.prNumber) return { ref, sha: '' }
  const localSha = await runCommand(ctx, `git rev-parse --verify ${shellQuote(`${remote}^{commit}`)}`, {
    workdir: workflow.worktree,
    timeoutMs: 10_000,
    sandboxPolicy: { mode: 'read-only', workspaceRoot: workflow.worktree },
  }).catch(() => '')
  sha = exactCommitHash(localSha) || exactCommitHash(sha)
  return { ref, sha }
}

/** Build the review prompt against one exact base SHA; the ref is display identity only. */
export async function buildReviewPrompt(
  ctx: Context,
  workflow: IssueWorkflow,
  resolved: ResolvedPromptSnapshot,
  reviewedHead: string,
  sessionId: string | null = null,
  extraContext = '',
  frozenReviewBase?: ReviewBaseTarget,
  freshSession = false,
): Promise<string> {
  const reviewBase = frozenReviewBase ?? (await resolveReviewBaseTarget(ctx, workflow))
  // The persisted review identity and the executed diff share this exact SHA.
  // Keeping a second caller-provided diff field would permit recording B while reviewing A.
  const base = reviewBase.sha || `origin/${reviewBase.ref}`
  const prUrl = workflow.prNumber ? `https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}` : '未关联'
  const contractHash = issueBodyHash(resolved.snapshot.body)
  const promptSnapshot = freshSession ? snapshotWithoutReviewFeedback(resolved.snapshot) : resolved.snapshot
  return buildStagePrompt({
    stage: 'review',
    ...resolved,
    snapshot: promptSnapshot,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `PR: ${prUrl}`,
      `被审 commit: ${reviewedHead}`,
      `对比 base: ${base}`,
      `PR 基线身份: ${reviewBase.ref} @ ${reviewBase.sha || '未知'}`,
      `契约正文 SHA-256: ${contractHash}`,
      `会话模式: ${sessionId ? `续接 review 会话 ${sessionId};保留既有审查记忆` : '全新 review 会话'}`,
      ...(extraContext ? ['附加上下文:', extraContext] : []),
    ],
    requirements: [
      '先执行 git fetch origin 同步远端最新状态(并行开发时 base 可能已变化)。',
      `执行 git diff ${base}...HEAD 查看完整改动。`,
      ...(sessionId ? ['先复核之前发现的问题是否已解决,再审查全部新改动。'] : []),
      '严格按当前需求快照中的验收标准逐条审查,同时检查 bug、安全隐患和测试覆盖。',
      '验证结果必须区分:命令已执行但断言/检查失败的问题以「[验证不通过]」开头;因权限、环境或外部依赖导致命令无法执行的问题以「[无法验证]」开头,不得混淆。',
      `除 ${REVIEW_RESULT_RELATIVE_PATH} 外不要修改任何文件,只做只读 review。`,
      `必须使用写文件工具把最终结论写入 ${REVIEW_RESULT_RELATIVE_PATH},格式:{"passed":true|false,"issues":["问题1(含文件/位置/原因)",...]};passed=true 表示无问题,有任意问题则 false 并列全。`,
      '最后一行再输出同一个 JSON 对象(单独一行,不要代码块),仅作为兼容兜底。',
    ],
  })
}

export async function buildResumePrompt(
  ctx: Context,
  workflow: IssueWorkflow,
  resolved: ResolvedPromptSnapshot,
  extraContext: string,
  mergePreface: string,
  sessionId: string | null,
): Promise<string> {
  const localIssues = workflow.reviewResult?.passed === false ? workflow.reviewResult.issues : []
  const selected = selectReviewFeedback({
    unresolvedReview: workflow.reviewResult?.passed === false,
    snapshot: resolved.snapshot,
    freshness: resolved.freshness,
    localEvents: workflow.events,
    localIssues,
  })
  let reviewFeedback: { source: string; text: string } | null = selected
  if (extraContext !== '' && !selected?.text.includes(extraContext)) {
    reviewFeedback = {
      source: selected ? `${selected.source}+request-context` : 'request-context',
      text: selected ? `${selected.text}\n\n${extraContext}` : extraContext,
    }
  }
  const rework = reviewFeedback !== null || localIssues.length > 0
  const head = await readWorktreeHead(ctx, workflow.worktree)
  return buildStagePrompt({
    stage: rework ? 'rework' : 'resume',
    ...resolved,
    worktree: workflow.worktree,
    status: [
      `分支: ${workflow.branch}`,
      `当前 commit: ${head ?? '未知'}`,
      `开发基线: ${workflow.baseRef ?? '未知'}`,
      `会话模式: ${sessionId ? `续接精确开发会话 ${sessionId};会话记忆优先用于理解既有工作` : '全新会话;从当前快照与 worktree 重新建立上下文'}`,
    ],
    reviewFeedback,
    requirements: [
      ...(mergePreface ? [mergePreface] : []),
      ...(sessionId
        ? ['优先利用当前会话记忆继续工作,但记忆与当前需求快照冲突时以快照为准。']
        : ['先读取 git diff 和未提交改动,再按当前需求快照继续;不要依赖已失效会话的旧记忆。']),
      ...(rework ? ['逐条处理“当前状态”中的 Review 意见,完成后重新验证。'] : []),
      ...developmentRequirements(workflow.baseRef),
    ],
  })
}

/** Fetch a PR's base ref name via gh. */
export async function fetchPrBase(ctx: Context, repoKey: string, prNumber: string): Promise<string | null> {
  return (await fetchPrBaseTarget(ctx, repoKey, prNumber))?.ref ?? null
}

async function fetchPrBaseTarget(
  ctx: Context,
  repoKey: string,
  prNumber: string,
): Promise<{ ref: string; sha: string | null } | null> {
  try {
    const pr = await fetchPrRestDetail(ctx, repoKey, prNumber, true)
    const ref = String(pr.base?.ref ?? '').trim()
    const sha = String(pr.base?.sha ?? '').trim()
    return ref === '' ? null : { ref, sha: sha === '' ? null : sha }
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}

/** Fetch a PR's head branch name via gh (to locate its worktree). */
export async function fetchPrHeadBranch(
  ctx: Context,
  owner: string,
  repo: string,
  prNumber: string,
): Promise<string | null> {
  try {
    const pr = await fetchPrRestDetail(ctx, `${owner}/${repo}`, prNumber)
    const name = String(pr.head?.ref ?? '').trim()
    return name === '' ? null : name
  } catch (error) {
    if (isGithubRateLimitError(error)) throw error
    return null
  }
}
