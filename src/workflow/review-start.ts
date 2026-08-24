import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { fetchGithubPrFact, readConfiguredBranchFacts } from '../github/facts.ts'
import { expandHome, loadConfig } from '../infra/runtime.ts'
import { type IssueWorkflow, issueKey, saveWorkflow, workflowRevision } from '../infra/state.ts'
import { observeWorkflowTask, taskLaunchDecision, type TaskOwnershipContext } from '../infra/task-ownership.ts'
import { deriveWorkflowState } from './derive.ts'
import { deriveReviewStartDecision, type ReviewStartDecision, type WorkflowFacts } from './state-view.ts'

export type ReviewWorkflowResolution = { ok: true; workflow: IssueWorkflow } | { ok: false; error: string }

type ParsedGithubUrl = { kind: 'issue' | 'pr'; owner: string; repo: string; number: string }

function cachedReviewFacts(workflow: IssueWorkflow): WorkflowFacts {
  return {
    issueOpen: workflow.issueState !== 'CLOSED',
    prMerged: workflow.delivery !== undefined,
    prNumber: workflow.prNumber,
    stage: workflow.stage,
    devInterrupted: workflow.devInterrupted,
    taskRunning: false,
    head: null,
    reviewedHash: null,
    reviewPassed: workflow.reviewResult?.passed ?? null,
    issueContractStatus: 'unknown',
    issueContractUnknownReason: 'current-contract-unavailable',
    hasNewCommits: false,
    needsSync: false,
    workflowCachePresent: true,
    deliveryHash: null,
  }
}

export function reviewStartError(decision: Exclude<ReviewStartDecision, { allowed: true }>): string {
  switch (decision.reason) {
    case 'task-running':
      return '有进行中任务,请等待当前开发任务完成后再 Review'
    case 'task-unknown':
      return '当前控制器无法确认旧任务生死,为避免双开已禁止启动 Review'
    case 'development-in-progress':
      return '开发仍在进行,尚无可 Review 的完成事实'
    case 'workflow-cache-missing':
      return '本地 workflow 缓存缺失,且尚无完成事实,无法 Review'
    case 'no-completion-facts':
      return '尚无完成事实,无法 Review'
  }
}

function transientWorkflow(parsed: ParsedGithubUrl, repoPath: string, worktreeRoot: string): IssueWorkflow {
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const project = basename(repoPath)
  const branch = `${project}-issue-${parsed.number}`
  return {
    key: issueKey(repoKey, parsed.number),
    url: `https://github.com/${repoKey}/issues/${parsed.number}`,
    repoKey,
    worktree: join(worktreeRoot, project, branch),
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
}

/** Resolve review startup from cached state first, then authoritative git/GitHub facts. */
export async function resolveReviewStartWorkflow(
  ctx: Context,
  parsed: ParsedGithubUrl,
  existing: IssueWorkflow | null,
): Promise<ReviewWorkflowResolution> {
  // The caller consumes this same ownership answer after resolution and returns
  // its exact task ref; this resolver must not guess a task from stage fields.
  if (existing && !taskLaunchDecision(observeWorkflowTask(ctx as unknown as TaskOwnershipContext, existing)).allowed) {
    return { ok: true, workflow: existing }
  }

  if (existing) {
    const cachedDecision = deriveReviewStartDecision(cachedReviewFacts(existing))
    if (cachedDecision.allowed) return { ok: true, workflow: existing }
    if (cachedDecision.reason === 'task-running' || cachedDecision.reason === 'task-unknown') {
      return { ok: false, error: reviewStartError(cachedDecision) }
    }
  }

  if (parsed.kind !== 'issue') {
    return { ok: false, error: '本地 workflow 缓存缺失,无法从 PR 链接恢复对应 Issue 的 Review 上下文' }
  }
  const config = await loadConfig()
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const configuredPath = config.repos[repoKey]
  if (!configuredPath) return { ok: false, error: `本地未配置仓库 ${repoKey}` }
  const repoPath = expandHome(configuredPath)
  if (!existsSync(repoPath)) return { ok: false, error: `仓库路径不存在: ${repoPath}` }

  const workflow = existing ?? transientWorkflow(parsed, repoPath, config.worktreeRoot)
  const [branchFacts, prLookup] = await Promise.all([
    readConfiguredBranchFacts(ctx, config, workflow),
    fetchGithubPrFact(ctx, repoKey, workflow.branch, workflow.prNumber, false),
  ])
  const derived = await deriveWorkflowState(ctx, workflow, {
    pr: prLookup.pr,
    prStatusKnown: prLookup.known && prLookup.pr !== null,
    workflowCachePresent: existing !== null,
    ...branchFacts,
  })
  if (!derived.derived.reviewStart.allowed) {
    return { ok: false, error: reviewStartError(derived.derived.reviewStart) }
  }

  workflow.prNumber = prLookup.pr?.number ?? workflow.prNumber
  if (!workflow.baseRef && prLookup.pr?.baseRefName) workflow.baseRef = `origin/${prLookup.pr.baseRefName}`
  workflow.stage = 'review-ready'
  await saveWorkflow(workflow, workflowRevision(workflow))
  return { ok: true, workflow }
}
