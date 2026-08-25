/** Project issue-list presentation and navigation. */
import React from 'react'
import { useProjectPanel } from '../project-state.ts'
import { RunningDuration } from '../duration.ts'
import { type RepositoryIssue, apiCall, fetchIssue, stageLabel } from '../domain.ts'
import { MAX_BATCH_ISSUES, setPanelOpen } from '../panel-state.ts'
import { deriveProjectSelection } from '../project-sources.ts'
import { type Dependencies, type GhIssue, IssueView, type TimelineEvent, repoOf } from './issue-view.tsx'
import { ProjectSelector } from './project-selector.tsx'
import { RepositoryAdvanceBanner } from './repository-advance-banner.tsx'
import { AutoRunForm } from './auto-run-form.tsx'
import { IssueRowMeta } from './issue-row-meta.ts'

export function PanelContent() {
  const {
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
  } = useProjectPanel()
  const selectedProject = projects.find((project) => project.repoKey === repoKey) ?? null
  const projectConfigured = selectedProject?.configured !== false

  const filtered = issues.filter((issue) => {
    const blocked = issue.blockedBy.some((dependency) => dependency.state.toUpperCase() === 'OPEN')
    return dependencyFilter === 'all' || (dependencyFilter === 'blocked' ? blocked : !blocked)
  })
  const grouped = new Map<string, RepositoryIssue[]>()
  for (const issue of filtered) {
    const blocked = issue.blockedBy.some((dependency) => dependency.state.toUpperCase() === 'OPEN')
    const key = groupBy === 'milestone' ? (issue.milestone?.title ?? '无里程碑') : blocked ? '被依赖阻塞' : '依赖已就绪'
    grouped.set(key, [...(grouped.get(key) ?? []), issue])
  }

  const rowAction = (issue: RepositoryIssue) => {
    const action = issue.workflow.derived?.nextAction
    if (!action || action.kind === 'none') return
    void openIssue(issue, true)
  }

  const readyIssues = issues.filter((issue) => issue.autoDevelopment?.ready === true)
  const batchCandidates = readyIssues.slice(0, MAX_BATCH_ISSUES)
  const selectedReadyIssues = batchCandidates.filter((issue) => selectedIssues.has(Number(issue.number)))

  const toggleReadySelection = () => {
    setSelectedIssues(
      selectedReadyIssues.length === batchCandidates.length && batchCandidates.length > 0
        ? new Set()
        : new Set(batchCandidates.map((issue) => Number(issue.number))),
    )
  }

  const startBatchDevelopment = async () => {
    const chosen = batchCandidates.filter((issue) => selectedIssues.has(Number(issue.number)))
    if (chosen.length === 0) return
    setBatchBusy(true)
    setError(null)
    setBatchStatus(`正在刷新并冻结 ${chosen.length} 个 issue…`)
    try {
      const prepared: Array<{
        issue: RepositoryIssue
        snapshot: GhIssue
        authorizationId: string
        authorizationDigest: string
      }> = []
      for (const issue of chosen) {
        const url = String(issue.url ?? '')
        // The first item refreshes the shared repository dependency snapshot; later items reuse it.
        const fetched = await fetchIssue(url, 20_000, prepared.length === 0)
        if (!fetched.ok) throw new Error(`#${issue.number} 刷新失败: ${fetched.error}`)
        const snapshot = fetched.data.item as GhIssue
        const expectedSnapshot = {
          url,
          title: String(snapshot.title ?? ''),
          body: String(snapshot.body ?? ''),
          state: String(snapshot.state ?? '').toUpperCase(),
          updatedAt: String(snapshot.updatedAt ?? ''),
          comments: (snapshot.comments ?? []).map((comment) => ({
            author: String(comment.author?.login ?? 'unknown'),
            body: String(comment.body ?? ''),
          })),
        }
        const authorization = await apiCall<
          { ok: true; authorizationId: string; authorizationDigest: string } | { ok: false; error: string }
        >('authorize', { action: 'develop', url, agent: batchAgent, context: '', expectedSnapshot }, 20_000)
        if (!authorization.ok) throw new Error(`#${issue.number} 授权预览失败: ${authorization.error}`)
        prepared.push({ issue, snapshot, ...authorization })
      }
      const preview = prepared
        .map(
          ({ issue, snapshot, authorizationDigest }) =>
            `#${issue.number} ${snapshot.title ?? issue.title} · ${authorizationDigest.slice(0, 12)}`,
        )
        .join('\n')
      if (
        !window.confirm(
          `${batchAgent} 将批量开发以下 ${prepared.length} 个 ready issue:\n\n${preview}\n\n每项启动前仍会重验契约与依赖。确认启动?`,
        )
      ) {
        setBatchStatus('已取消批量开发，未启动任何任务')
        return
      }
      const failures: string[] = []
      let started = 0
      for (const item of prepared) {
        const response = await apiCall<
          { ok: true; taskId: string; worktree: string; branch: string } | { ok: false; error: string }
        >(
          'develop',
          {
            url: String(item.issue.url ?? ''),
            agent: batchAgent,
            automatic: true,
            authorizationId: item.authorizationId,
            authorizationDigest: item.authorizationDigest,
          },
          30_000,
        )
        if (response.ok) started++
        else failures.push(`#${item.issue.number}: ${response.error}`)
      }
      setSelectedIssues(new Set())
      const finalStatus =
        failures.length === 0
          ? `已启动 ${started}/${prepared.length} 个开发任务`
          : `已启动 ${started}/${prepared.length}；失败 ${failures.join('；')}`
      await loadRepo(repoKey, true)
      setBatchStatus(finalStatus)
    } catch (reason) {
      setError(`批量开发未启动: ${String(reason instanceof Error ? reason.message : reason)}`)
      setBatchStatus(null)
    } finally {
      setBatchBusy(false)
    }
  }

  return (
    <div className="cv-panel">
      <div className="cv-panel-header">
        <span>
          {result ? (
            <button
              className="cv-back"
              onClick={() => {
                setResult(null)
                setAutoAction(false)
                void refreshWorkflowStates()
              }}
            >
              ← 项目 Issues
            </button>
          ) : (
            'ClickVibe · 项目'
          )}
        </span>
        <span className="cv-panel-header-actions">
          {result ? (
            <button
              className="cv-refresh"
              onClick={() => void refreshDetail()}
              disabled={loading}
              title="强制同步远端并刷新详情"
              aria-label="强制同步远端并刷新详情"
            >
              ⟳
            </button>
          ) : null}
          <button className="cv-close" onClick={() => setPanelOpen(false)} aria-label="关闭 ClickVibe 面板">
            ✕
          </button>
        </span>
      </div>
      {freshness?.stale ? (
        <div className="cv-stale" title={freshness.error}>
          {freshness.refreshing
            ? '⚠ 状态可能过期 · 远端同步较慢，后台仍在刷新，当前使用本地 refs'
            : '⚠ 状态可能过期 · 远端同步失败，当前使用本地 refs'}
        </div>
      ) : null}
      {stateRefreshError ? (
        <div className="cv-stale" title={stateRefreshError}>
          {stateRefreshError.startsWith('GitHub 额度已用完,约 ')
            ? stateRefreshError
            : '⚠ 状态可能过期 · 自动刷新失败，当前保留上次结果'}
        </div>
      ) : null}
      {dependencyRefreshError ? (
        <div className="cv-stale" title={dependencyRefreshError}>
          {dependencyRefreshError.startsWith('GitHub 额度已用完,约 ')
            ? dependencyRefreshError
            : '⚠ 依赖状态可能过期 · GitHub 刷新失败，当前保留上次结果'}
        </div>
      ) : null}
      {dshWorkspaceError ? (
        <div className="cv-stale" title={dshWorkspaceError}>
          ⚠ {dshWorkspaceError}
        </div>
      ) : null}
      {!result ? (
        <RepositoryAdvanceBanner signal={repoAdvance} busy={repoSyncBusy} onSync={() => void safeSyncRepository()} />
      ) : null}
      {!result && repoSyncMessage ? <div className="cv-project-meta">{repoSyncMessage}</div> : null}
      {result ? (
        <IssueView
          issue={result.item}
          kind={result.kind}
          workflow={workflow}
          onWorkflow={updateWorkflow}
          timeline={result.timeline}
          dependencies={result.dependencies}
          project={
            result.kind === 'issue'
              ? (projects.find((p) => p.repoKey === repoOf(String(result.item.url ?? ''))) ?? null)
              : null
          }
          autoAction={autoAction}
          onAutoActionHandled={() => setAutoAction(false)}
          onDelivered={() => {
            setResult(null)
            updateWorkflow(null)
            setAutoAction(false)
            void loadRepo(repoKey)
          }}
        />
      ) : (
        <>
          <div className="cv-project-toolbar">
            <ProjectSelector
              projects={projects}
              selected={selectedProject}
              importBusy={importBusy}
              onSelect={(project) => {
                const selection = deriveProjectSelection(project)
                setRepoKey(project.repoKey)
                if (!selection.loadRepository) {
                  setResult(null)
                  updateWorkflow(null)
                  setSelectedIssues(new Set())
                  setBatchStatus(null)
                  setRepoAdvance(selection.repoAdvance)
                  setRepoSyncMessage(selection.repoSyncMessage)
                } else {
                  void loadRepo(project.repoKey)
                }
              }}
              onImport={(project) => void importProject(project)}
            />
            <div className="cv-project-selects">
              <select
                className="cv-select"
                value={dependencyFilter}
                onChange={(event) => setDependencyFilter(event.target.value as typeof dependencyFilter)}
              >
                <option value="all">全部依赖状态</option>
                <option value="ready">依赖已就绪</option>
                <option value="blocked">被依赖阻塞</option>
              </select>
              <select
                className="cv-select"
                value={groupBy}
                onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}
              >
                <option value="milestone">按里程碑分组</option>
                <option value="dependency">按依赖分组</option>
              </select>
              <button
                className="cv-refresh"
                onClick={() => void loadRepo(repoKey, true)}
                disabled={loading}
                title="刷新 GitHub 与 git 状态"
                aria-label="刷新 GitHub 与 git 状态"
              >
                ⟳
              </button>
            </div>
            <div className="cv-batch-bar">
              <button
                className="cv-batch-btn cv-batch-secondary"
                onClick={toggleReadySelection}
                disabled={!projectConfigured || batchBusy || readyIssues.length === 0}
              >
                {selectedReadyIssues.length === batchCandidates.length && batchCandidates.length > 0
                  ? '取消全选'
                  : `选择 ready (${batchCandidates.length}${readyIssues.length > MAX_BATCH_ISSUES ? `/${readyIssues.length}` : ''})`}
              </button>
              <span className="cv-batch-agent">
                <button
                  className={batchAgent === 'codex' ? 'on' : ''}
                  onClick={() => setBatchAgent('codex')}
                  disabled={!projectConfigured || batchBusy}
                >
                  Codex
                </button>
                <button
                  className={batchAgent === 'claude' ? 'on' : ''}
                  onClick={() => setBatchAgent('claude')}
                  disabled={!projectConfigured || batchBusy}
                >
                  Claude
                </button>
              </span>
              <button
                className="cv-batch-btn"
                onClick={() => void startBatchDevelopment()}
                disabled={!projectConfigured || batchBusy || selectedReadyIssues.length === 0}
              >
                {batchBusy ? '批量启动中…' : `批量下单 (${selectedReadyIssues.length})`}
              </button>
              {batchStatus ? <span className="cv-batch-status">{batchStatus}</span> : null}
            </div>
            {repoKey ? (
              <div className="cv-project-meta">
                {selectedProject?.configured === false
                  ? '未配置 · 只读展示，导入后才能加载 Issue 或开始开发'
                  : `${issues.length} 个 open issue · ${selectedProject?.available ? '本机 git + GitHub' : '远程配置 · GitHub'} 实时事实`}
              </div>
            ) : null}
          </div>
          {error ? <div className="cv-error">{error}</div> : null}
          {loading ? (
            <div className="cv-loading">正在读取项目 issues 与实时状态…</div>
          ) : projects.length === 0 ? (
            <div className="cv-hint">config.yaml 与 DSH 中都没有可显示的项目</div>
          ) : selectedProject?.configured === false ? (
            <div className="cv-hint">该 DSH 项目尚未配置。点击“导入”后才能读取 GitHub Issue 和执行开发动作。</div>
          ) : (
            <div className="cv-project-list">
              {[...grouped.entries()]
                .sort(([a], [b]) => a.localeCompare(b))
                .map(([group, rows]) => (
                  <React.Fragment key={group}>
                    <div className="cv-group-title">
                      {group} · {rows.length}
                    </div>
                    {[...rows]
                      .sort((a, b) => {
                        // 就绪优先:就绪(未开发+依赖OK) → 开发中 → 阻塞 → 已交付;同档按编号。
                        const levelOf = (issue: RepositoryIssue): number => {
                          if (issue.blockedBy.some((dependency) => dependency.state.toUpperCase() === 'OPEN')) return 2
                          const status = issue.workflow.derived?.status ?? issue.workflow.stage
                          if (status === 'passed') return 3
                          if (status === 'idle') return 0
                          return 1 // developing / reviewing / review-ready
                        }
                        return levelOf(a) - levelOf(b) || (a.number ?? 0) - (b.number ?? 0)
                      })
                      .map((issue) => {
                        const derived = issue.workflow.derived
                        const status = derived?.status ?? issue.workflow.stage
                        const baseAction = derived?.nextAction ?? {
                          kind: 'develop' as const,
                          label: '开始开发',
                          hint: '',
                        }
                        // blockedBy 门槛:有 OPEN 依赖时,阻止"开始/恢复开发"(未开发先等依赖完成);
                        // review/返工/合并等已开发流程不受影响(不能因依赖未完成卡死已做的工作)。
                        const blockedByOpen = issue.blockedBy.filter(
                          (dependency) => dependency.state.toUpperCase() === 'OPEN',
                        )
                        const action =
                          (baseAction.kind === 'develop' || baseAction.kind === 'resume') && blockedByOpen.length > 0
                            ? {
                                kind: 'none' as const,
                                label: `被 #${blockedByOpen.map((dependency) => dependency.number).join('#')} 阻塞`,
                                hint: '依赖未完成,先完成被阻塞的依赖',
                              }
                            : baseAction
                        // 契约门槛:缺 目标/验收标准/依赖 的 issue 标记『不满足契约』并提示补齐,
                        // 不硬选(不拦人工开发,按钮保留、hint 提示补全);自动选取(#9)按 contract.ok 排除。
                        const contract = issue.contract
                        const shownAction =
                          contract && !contract.ok && (action.kind === 'develop' || action.kind === 'resume')
                            ? {
                                ...action,
                                hint: `该 issue 缺:${contract.missing.join('、')},建议先在 GitHub 补齐契约(目标/验收标准/依赖);人工仍可开发`,
                              }
                            : action
                        return (
                          <div className="cv-issue-row" key={issue.number}>
                            <input
                              className="cv-row-select"
                              type="checkbox"
                              aria-label={`选择 issue #${issue.number}`}
                              checked={selectedIssues.has(Number(issue.number))}
                              disabled={!batchCandidates.includes(issue) || batchBusy}
                              title={
                                issue.autoDevelopment?.ready && !batchCandidates.includes(issue)
                                  ? `每批最多 ${MAX_BATCH_ISSUES} 个，请先启动当前批次`
                                  : (issue.autoDevelopment?.reason ?? '自动选择状态不可用')
                              }
                              onChange={(event) =>
                                setSelectedIssues((previous) => {
                                  const next = new Set(previous)
                                  if (event.target.checked) next.add(Number(issue.number))
                                  else next.delete(Number(issue.number))
                                  return next
                                })
                              }
                            />
                            <span className={`cv-stage cv-stage-${status}`}>{stageLabel(status, issue.workflow)}</span>
                            <div className="cv-issue-row-main">
                              <span
                                className="cv-issue-row-title"
                                title={`#${issue.number} ${issue.title}`}
                                onClick={() => void openIssue(issue)}
                              >
                                #{issue.number} {issue.title}
                              </span>
                              {(status === 'developing' || status === 'reviewing') &&
                              issue.workflow.runStartedAt !== null &&
                              issue.workflow.runStartedAt !== undefined ? (
                                <RunningDuration startedAt={issue.workflow.runStartedAt} />
                              ) : null}
                              <IssueRowMeta
                                branch={issue.workflow.branch}
                                milestone={issue.milestone?.title ?? null}
                                blockedBy={issue.blockedBy}
                                behindBase={derived?.behindBase ?? 0}
                                contract={contract}
                                autoDevelopmentReady={issue.autoDevelopment?.ready === true}
                                dependencyLedger={issue.dependencyLedger}
                              />
                            </div>
                            <div className="cv-row-actions">
                              <AutoRunForm
                                compact
                                url={String(issue.url ?? '')}
                                issue={issue}
                                workflow={issue.workflow}
                                onStarted={() => loadRepo(repoKey, true)}
                              />
                              <button
                                className={`cv-row-action${shownAction.kind === 'none' ? (shownAction.label === '任务进行中' ? ' cv-row-running' : ' cv-row-none') : ''}`}
                                disabled={shownAction.kind === 'none'}
                                title={shownAction.hint}
                                onClick={() => rowAction(issue)}
                              >
                                {shownAction.kind === 'none'
                                  ? status === 'passed'
                                    ? '已交付'
                                    : shownAction.label
                                  : shownAction.label}
                              </button>
                            </div>
                          </div>
                        )
                      })}
                  </React.Fragment>
                ))}
              {filtered.length === 0 ? <div className="cv-hint">当前筛选下没有 open issue</div> : null}
            </div>
          )}
        </>
      )}
    </div>
  )
}
