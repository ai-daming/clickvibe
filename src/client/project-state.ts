/** Project-list data loading, polling and detail-navigation state. */
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
  const workflowRefreshInFlight = React.useRef(false)

  const mergeWorkflowStates = React.useCallback((workflows: Workflow[]) => {
    const byUrl = new Map(workflows.map((item) => [item.url, item]))
    setIssues((previous) =>
      previous.map((issue) => {
        const current = byUrl.get(String(issue.url ?? ''))
        return current ? { ...issue, workflow: current } : issue
      }),
    )
    setWorkflow((previous) => (previous ? (byUrl.get(previous.url) ?? previous) : previous))
  }, [])

  const updateWorkflow = React.useCallback(
    (next: Workflow | null) => {
      setWorkflow(next)
      if (next) mergeWorkflowStates([next])
    },
    [mergeWorkflowStates],
  )

  const refreshWorkflowStates = React.useCallback(async () => {
    if (!repoKey || workflowRefreshInFlight.current) return
    workflowRefreshInFlight.current = true
    try {
      const response = await apiCall<WorkflowStateResponse>('state', { repoKey }, 8_000)
      if (response.ok) {
        setStateRefreshError(null)
        mergeWorkflowStates(response.workflows)
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
  }, [mergeWorkflowStates, repoKey, result])

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
    let cancelled = false
    void (async () => {
      try {
        const response = await apiCall<{ ok: true; projects: ProjectOption[] }>('projects', {})
        if (cancelled) return
        setProjects(response.projects)
        const first = response.projects[0]?.repoKey ?? ''
        setRepoKey(first)
        if (first) await loadRepo(first)
      } catch (reason) {
        if (!cancelled) setError(`项目配置加载失败: ${String(reason)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

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
    error,
    freshness,
    groupBy,
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
    setResult,
    setSelectedIssues,
    safeSyncRepository,
    stateRefreshError,
    updateWorkflow,
    workflow,
  }
}
