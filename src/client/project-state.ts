/** Project-list data loading, polling and detail-navigation state. */
import { applyWorkflowSnapshot } from './workflow-snapshot.ts'
import React from 'react'
import {
  type ProjectOption,
  type RepositoryAdvanceSignal,
  type RepositoryFreshness,
  type RepositoryIssue,
  type Workflow,
  type WorkflowStateResponse,
  apiCall,
  fetchIssue,
} from './domain.ts'
import { getClientContext } from './panel-state.ts'
import { mergeProjectSources, readDshWorkspaceSnapshot, resolveDshWorkspaceSource } from './project-sources.ts'
import type { Dependencies, GhIssue, TimelineEvent } from './views/issue-view.tsx'

export function useProjectPanel() {
  const [projects, setProjects] = React.useState<ProjectOption[]>([])
  const [repoKey, setRepoKey] = React.useState('')
  const [issues, setIssues] = React.useState<RepositoryIssue[]>([])
  const [dependencyFilter, setDependencyFilter] = React.useState<'all' | 'ready' | 'blocked'>('all')
  const [groupBy, setGroupBy] = React.useState<'milestone' | 'dependency'>('milestone')
  const [loading, setLoading] = React.useState(false)
  const [result, setResult] = React.useState<{
    kind: 'issue' | 'pr'
    item: GhIssue
    timeline?: TimelineEvent[]
    dependencies?: Dependencies
  } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [workflow, setWorkflow] = React.useState<Workflow | null>(null)
  const [autoAction, setAutoAction] = React.useState(false)
  const [freshness, setFreshness] = React.useState<RepositoryFreshness | null>(null)
  const [repoAdvance, setRepoAdvance] = React.useState<RepositoryAdvanceSignal | null>(null)
  const [repoSyncBusy, setRepoSyncBusy] = React.useState(false)
  const [repoSyncMessage, setRepoSyncMessage] = React.useState<string | null>(null)
  const [dependencyRefreshError, setDependencyRefreshError] = React.useState<string | null>(null)
  const [stateRefreshError, setStateRefreshError] = React.useState<string | null>(null)
  const [selectedIssues, setSelectedIssues] = React.useState<Set<number>>(new Set())
  const [batchAgent, setBatchAgent] = React.useState<'codex' | 'claude'>('codex')
  const [batchBusy, setBatchBusy] = React.useState(false)
  const [batchStatus, setBatchStatus] = React.useState<string | null>(null)
  const [importBusy, setImportBusy] = React.useState(false)
  const [dshWorkspaceError, setDshWorkspaceError] = React.useState<string | null>(null)
  const workflowRefreshInFlight = React.useRef(false)
  const configuredProjects = React.useRef<ProjectOption[]>([])
  const dshWorkspacePaths = React.useRef<string[]>([])

  const refreshProjects = React.useCallback(async (): Promise<ProjectOption[]> => {
    const response = await apiCall<{ ok: true; projects: ProjectOption[] }>('projects', {})
    configuredProjects.current = response.projects
    const merged = mergeProjectSources(response.projects, dshWorkspacePaths.current)
    setProjects(merged)
    return merged
  }, [])

  const mergeWorkflowStates = React.useCallback((workflows: Workflow[], pruneMissing = false) => {
    setIssues((previous) => applyWorkflowSnapshot(previous, workflows, pruneMissing) as typeof previous)
    setWorkflow((previous) => {
      if (!previous) return previous
      const merged = applyWorkflowSnapshot([{ url: previous.url, workflow: previous }], workflows, pruneMissing)
      return (merged[0]?.workflow as typeof previous | undefined) ?? previous
    })
  }, [])

  const updateWorkflow = React.useCallback(
    (next: Workflow | null) => {
      setWorkflow(next)
      if (next) mergeWorkflowStates([next])
    },
    [mergeWorkflowStates],
  )

  const refreshWorkflowStates = React.useCallback(async () => {
    if (!repoKey || projects.find((project) => project.repoKey === repoKey)?.configured === false) return
    if (workflowRefreshInFlight.current) return
    workflowRefreshInFlight.current = true
    try {
      const response = await apiCall<WorkflowStateResponse>('state', { repoKey }, 8_000)
      if (response.ok) {
        setStateRefreshError(null)
        // prune=true:本轮成功响应中消失的 workflow 已归档,终结显示而非冻结僵尸动作
        mergeWorkflowStates(response.workflows, true)
        setFreshness(response.freshness)
        setRepoAdvance(response.repoAdvance)
        if (response.dependenciesRefreshDue) {
          try {
            if (result) {
              const next = await fetchIssue(String(result.item.url ?? ''), 4_000)
              if (next.ok) {
                setResult({
                  ...(next.data as NonNullable<typeof result>),
                  dependencies: next.data.dependencies ?? result.dependencies,
                })
                setDependencyRefreshError(next.dependencyError ?? null)
              } else {
                setDependencyRefreshError(next.error)
              }
            } else {
              const next = await apiCall<
                | {
                    ok: true
                    issues: RepositoryIssue[]
                    freshness: RepositoryFreshness | null
                    repoAdvance: RepositoryAdvanceSignal | null
                  }
                | { ok: false; error: string }
              >('repo/issues', { repoKey }, 4_000)
              if (next.ok) {
                setIssues(next.issues)
                setFreshness(next.freshness)
                setRepoAdvance(next.repoAdvance)
                setDependencyRefreshError(null)
              } else {
                setDependencyRefreshError(next.error)
              }
            }
          } catch (reason) {
            setDependencyRefreshError(`GitHub 依赖刷新失败: ${String(reason)}`)
          }
        }
      } else {
        setStateRefreshError(response.error)
      }
    } catch (reason) {
      setStateRefreshError(`状态轮询失败: ${String(reason)}`)
    } finally {
      workflowRefreshInFlight.current = false
    }
  }, [mergeWorkflowStates, projects, repoKey, result])

  const loadRepo = async (selected: string, forceRefresh = false) => {
    if (!selected) return
    setLoading(true)
    setError(null)
    setResult(null)
    setIssues([])
    setFreshness(null)
    setRepoAdvance(null)
    setRepoSyncMessage(null)
    setStateRefreshError(null)
    setDependencyRefreshError(null)
    setSelectedIssues(new Set())
    setBatchStatus(null)
    try {
      const response = await apiCall<
        | {
            ok: true
            issues: RepositoryIssue[]
            freshness: RepositoryFreshness | null
            repoAdvance: RepositoryAdvanceSignal | null
          }
        | { ok: false; error: string }
      >('repo/issues', { repoKey: selected, forceRefresh }, 30_000)
      if (!response.ok) setError(response.error)
      else {
        setIssues(response.issues)
        setFreshness(response.freshness)
        setRepoAdvance(response.repoAdvance)
        setDependencyRefreshError(null)
      }
    } catch (reason) {
      setError(`项目加载失败: ${String(reason)}`)
    } finally {
      setLoading(false)
    }
  }

  React.useEffect(() => {
    const ctx = getClientContext()
    const source = ctx ? resolveDshWorkspaceSource(ctx) : null
    if (!source) {
      setDshWorkspaceError('DSH workspace 服务不可用，当前仅显示 config.yaml 项目')
      return
    }
    const sync = () => {
      const snapshot = readDshWorkspaceSnapshot(source)
      dshWorkspacePaths.current = snapshot.paths
      setDshWorkspaceError(snapshot.error)
      setProjects(mergeProjectSources(configuredProjects.current, snapshot.paths))
    }
    sync()
    return source.subscribe(sync)
  }, [])

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const nextProjects = await refreshProjects()
        if (cancelled) return
        const first =
          nextProjects.find((project) => project.configured !== false)?.repoKey ?? nextProjects[0]?.repoKey ?? ''
        setRepoKey(first)
        if (nextProjects.find((project) => project.repoKey === first)?.configured !== false && first)
          await loadRepo(first)
      } catch (reason) {
        if (!cancelled) setError(`项目配置加载失败: ${String(reason)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [refreshProjects])

  React.useEffect(() => {
    if (!repoKey) return
    const timer = window.setInterval(() => void refreshWorkflowStates(), 5000)
    return () => window.clearInterval(timer)
  }, [refreshWorkflowStates, repoKey])

  const openIssue = async (issue: RepositoryIssue, triggerAction = false) => {
    setLoading(true)
    setError(null)
    setAutoAction(false)
    try {
      const url = String(issue.url ?? '')
      const [response, stateResponse] = await Promise.all([
        fetchIssue(url),
        apiCall<WorkflowStateResponse>('state', { url }).catch(() => null),
      ])
      if (stateResponse?.ok) mergeWorkflowStates(stateResponse.workflows)
      if (stateResponse?.ok) {
        setFreshness(stateResponse.freshness)
        setRepoAdvance(stateResponse.repoAdvance)
        setStateRefreshError(null)
      } else if (stateResponse && !stateResponse.ok) {
        setStateRefreshError(stateResponse.error)
      }
      if (!response.ok) setError(response.error)
      else {
        setWorkflow(
          stateResponse?.ok
            ? (stateResponse.workflows.find((item) => item.url === url) ?? issue.workflow)
            : issue.workflow,
        )
        setResult(response.data as NonNullable<typeof result>)
        setDependencyRefreshError(response.dependencyError ?? null)
        setAutoAction(triggerAction)
      }
    } catch (reason) {
      setError(`Issue 加载失败: ${String(reason)}`)
    } finally {
      setLoading(false)
    }
  }

  const refreshDetail = async () => {
    if (!result) return
    const url = String(result.item.url ?? '')
    setLoading(true)
    setError(null)
    try {
      const [issueResponse, stateResponse] = await Promise.all([
        fetchIssue(url, undefined, true),
        apiCall<WorkflowStateResponse>('state', { url, forceRefresh: true }),
      ])
      if (!issueResponse.ok) setError(issueResponse.error)
      else {
        setResult({
          ...(issueResponse.data as NonNullable<typeof result>),
          dependencies: issueResponse.data.dependencies ?? result.dependencies,
        })
        setDependencyRefreshError(issueResponse.dependencyError ?? null)
      }
      if (stateResponse.ok) {
        mergeWorkflowStates(stateResponse.workflows)
        setWorkflow(stateResponse.workflows.find((item) => item.url === url) ?? workflow)
        setFreshness(stateResponse.freshness)
        setRepoAdvance(stateResponse.repoAdvance)
        setStateRefreshError(null)
      } else {
        setStateRefreshError(stateResponse.error)
      }
    } catch (reason) {
      setError(`Issue 刷新失败: ${String(reason)}`)
    } finally {
      setLoading(false)
    }
  }

  const importProject = async (project: ProjectOption) => {
    if (project.configured !== false || importBusy) return
    setImportBusy(true)
    setError(null)
    try {
      const response = await apiCall<
        { ok: true; action: 'projects'; projects: ProjectOption[] } | { ok: false; action?: 'projects'; error: string }
      >('command', { command: 'projects', importPath: project.path }, 20_000)
      if (!response.ok) {
        setError(`项目导入失败: ${response.error}`)
        return
      }
      const nextProjects = await refreshProjects()
      const imported = nextProjects.find(
        (candidate) => candidate.configured !== false && candidate.path === project.path,
      )
      if (!imported) throw new Error('配置已写入，但刷新后未找到对应项目')
      setRepoKey(imported.repoKey)
      await loadRepo(imported.repoKey, true)
    } catch (reason) {
      setError(`项目导入失败: ${String(reason instanceof Error ? reason.message : reason)}`)
    } finally {
      setImportBusy(false)
    }
  }

  const safeSyncRepository = async () => {
    if (!repoKey || repoSyncBusy) return
    setRepoSyncBusy(true)
    setRepoSyncMessage(null)
    try {
      const response = await apiCall<
        | {
            ok: true
            branchHead: { branch: string; head: string | null } | null
            mainRefForwarded: boolean
            conflict: { files: string[] } | null
            refused: string[]
          }
        | { ok: false; error: string }
      >('sync', { repoKey }, 90_000)
      if (!response.ok) {
        setRepoSyncMessage(response.error)
        return
      }
      await loadRepo(repoKey, true)
      if (response.conflict) {
        const files = response.conflict.files.length > 0 ? response.conflict.files.join('、') : '请用 git status 查看'
        setRepoSyncMessage(`合并冲突现场已保留 · ${files} · 附加说明:先同步最新代码并解决冲突`)
      } else if (response.refused.length > 0) {
        setRepoSyncMessage(response.refused.join('；'))
      } else {
        const updates = [
          response.branchHead ? `当前分支 HEAD ${response.branchHead.head ?? '未知'}` : '',
          response.mainRefForwarded ? '本地 main 已快进' : '',
        ].filter(Boolean)
        setRepoSyncMessage(updates.length > 0 ? `安全同步完成 · ${updates.join(' · ')}` : '仓库已是最新')
      }
    } catch (reason) {
      setRepoSyncMessage(`安全同步失败:${String(reason)}`)
    } finally {
      setRepoSyncBusy(false)
    }
  }

  return {
    autoAction,
    batchAgent,
    batchBusy,
    batchStatus,
    dependencyFilter,
    dependencyRefreshError,
    dshWorkspaceError,
    error,
    freshness,
    groupBy,
    importBusy,
    importProject,
    issues,
    loadRepo,
    loading,
    openIssue,
    projects,
    refreshDetail,
    refreshWorkflowStates,
    repoAdvance,
    repoKey,
    repoSyncBusy,
    repoSyncMessage,
    result,
    selectedIssues,
    setAutoAction,
    setBatchAgent,
    setBatchBusy,
    setBatchStatus,
    setDependencyFilter,
    setError,
    setGroupBy,
    setRepoKey,
    setRepoAdvance,
    setRepoSyncMessage,
    setResult,
    setSelectedIssues,
    safeSyncRepository,
    stateRefreshError,
    updateWorkflow,
    workflow,
  }
}
