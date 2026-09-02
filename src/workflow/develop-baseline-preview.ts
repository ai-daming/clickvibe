import { existsSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { fetchGithubIssueState } from '../github/facts.ts'
import { fetchOriginBranches } from '../infra/git.ts'
import { expandHome, loadConfig, parseUrl } from '../infra/runtime.ts'
import { issueKey, loadWorkflow } from '../infra/state.ts'
import { baselineDependencyIssue, baselinePreviewOptions, frozenRemoteBase, requestedRemoteBase } from './baseline.ts'

export interface DevelopBaselinePreview {
  baseline: string
  baselineOptions: string[]
  baselineFrozen: boolean
  baselineRef: string | null
  baselineDependencyIssue: number | null
  baselineWarning?: string
}

/** Build the server-authoritative baseline selector preview after fetching origin. */
export async function developBaselinePreview(
  ctx: Context,
  url: string,
  requested: unknown,
): Promise<DevelopBaselinePreview> {
  const parsed = parseUrl(url)
  if (!parsed || parsed.kind !== 'issue') throw new Error('开发基线预览只支持 GitHub Issue URL')
  const repoKey = `${parsed.owner}/${parsed.repo}`
  const workflow = await loadWorkflow(issueKey(repoKey, parsed.number))
  const frozen = frozenRemoteBase(workflow?.baseRef)
  if (frozen) {
    const selected = requested === undefined ? frozen : requestedRemoteBase(requested)
    if (selected !== frozen) throw new Error(`开发基线已定格为 ${frozen},拒绝改为 ${selected}`)
    return dependencyPreview(ctx, url, parsed.number, {
      baseline: frozen,
      baselineOptions: [frozen],
      baselineFrozen: true,
      baselineRef: workflow?.baseRef ?? null,
      baselineDependencyIssue: null,
    })
  }

  const selected = requestedRemoteBase(requested)
  const config = await loadConfig()
  const configuredPath = config.repos[repoKey]
  if (!configuredPath || !existsSync(resolve(expandHome(configuredPath)))) {
    if (selected !== 'origin/HEAD') throw new Error(`无法在未配置的本地仓库中验证开发基线: ${selected}`)
    return {
      baseline: selected,
      baselineOptions: ['origin/HEAD'],
      baselineFrozen: false,
      baselineRef: null,
      baselineDependencyIssue: null,
      baselineWarning: `本地仓库 ${repoKey} 未配置或不存在,仅能预览默认基线`,
    }
  }
  const repoPath = resolve(expandHome(configuredPath))
  let branches: Awaited<ReturnType<typeof fetchOriginBranches>>
  try {
    branches = await fetchOriginBranches(ctx, repoKey, repoPath)
  } catch (error) {
    if (selected !== 'origin/HEAD') throw error
    return {
      baseline: selected,
      baselineOptions: ['origin/HEAD'],
      baselineFrozen: false,
      baselineRef: null,
      baselineDependencyIssue: null,
      baselineWarning: `远端分支刷新失败:${String(error instanceof Error ? error.message : error)}`,
    }
  }
  const ownRemoteBase = `origin/${basename(repoPath)}-issue-${parsed.number}`
  if (selected === 'origin/HEAD' && branches.defaultRemoteBase === ownRemoteBase) {
    throw new Error(`origin/HEAD 默认分支指向当前 Issue 开发分支 ${ownRemoteBase},无法作为开发基线`)
  }
  if (selected === ownRemoteBase) throw new Error(`开发基线不能选择当前 Issue 开发分支 ${ownRemoteBase}`)
  const options = baselinePreviewOptions(branches.defaultRemoteBase, branches.refs).filter(
    (ref) => ref !== ownRemoteBase,
  )
  if (!options.includes(selected)) throw new Error(`开发基线不存在或未 fetch: ${selected}`)
  return dependencyPreview(ctx, url, parsed.number, {
    baseline: selected,
    baselineOptions: options,
    baselineFrozen: false,
    baselineRef: null,
    baselineDependencyIssue: null,
  })
}

async function dependencyPreview(
  ctx: Context,
  url: string,
  ownIssue: string,
  preview: DevelopBaselinePreview,
): Promise<DevelopBaselinePreview> {
  const dependency = baselineDependencyIssue(preview.baseline)
  if (dependency === null || String(dependency) === ownIssue) return preview
  const dependencyUrl = url.replace(/\/issues\/\d+(?:[/?#].*)?$/, `/issues/${dependency}`)
  try {
    const state = await fetchGithubIssueState(ctx, dependencyUrl)
    return state === 'OPEN' ? { ...preview, baselineDependencyIssue: dependency } : preview
  } catch (error) {
    return {
      ...preview,
      baselineWarning: `无法确认基线关联 Issue #${dependency} 的状态:${String(error instanceof Error ? error.message : error)}`,
    }
  }
}
