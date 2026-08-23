/** GitHub issue/PR detail presentation. */
import React from 'react'
import { openDshConversationDraft, resolveDshConversationDeps } from '../dsh-conversation.ts'
import { type ProjectOption, type Workflow } from '../domain.ts'
import { fmtDate, renderMarkdown } from '../format.tsx'
import { getClientContext } from '../panel-state.ts'
import { CollapsibleSection, sectionStorageKey } from './collapsible-section.ts'
import { DevSection } from './dev-section.tsx'

export interface GhComment {
  author?: { login?: string } | null
  createdAt?: string
  body?: string
}

export interface GhIssue {
  number?: number
  title?: string
  state?: string
  author?: { login?: string } | null
  createdAt?: string
  updatedAt?: string
  closedAt?: string
  mergedAt?: string
  body?: string
  url?: string
  labels?: { name: string }[]
  assignees?: { login: string }[]
  milestone?: { title: string } | null
  comments?: GhComment[]
  additions?: number
  deletions?: number
  changedFiles?: number
  commits?: { messageHeadline?: string }[]
  mergeStateStatus?: string
  baseRefName?: string
  headRefName?: string
}

export interface TimelineEvent {
  event: string
  created_at?: string
  actor?: string
  commit_id?: string | null
  source?: {
    number?: number
    title?: string
    html_url?: string
    state?: string
    is_pr?: boolean
    pr_merged?: boolean
  } | null
}

/** Derived display state of a linked item: PRs get open/merged/closed, issues open/closed. */
export function linkedState(source: NonNullable<TimelineEvent['source']>): 'open' | 'closed' | 'merged' {
  if (source.is_pr) {
    if (source.pr_merged) return 'merged'
    return source.state === 'closed' ? 'closed' : 'open'
  }
  return source.state === 'closed' ? 'closed' : 'open'
}

export const OCTICON_PR =
  'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z'

export const OCTICON_MERGE =
  'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-8.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z'

/** GitHub-style PR state icon (open: pull-request, merged: git-merge, closed: pull-request). */
export function PrStateIcon({ state }: { state: 'open' | 'closed' | 'merged' }) {
  return (
    <svg
      className={`cv-pr-icon cv-pr-${state}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={state === 'merged' ? OCTICON_MERGE : OCTICON_PR} />
    </svg>
  )
}

export const OCTICON_ISSUE_OPEN =
  'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z'

export const OCTICON_ISSUE_CLOSED =
  'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.97 1.78a.75.75 0 0 1 1.06 0l1.22 1.22 2.28-2.28a.75.75 0 1 1 1.06 1.06l-2.81 2.81a.75.75 0 0 1-1.06 0l-1.75-1.75a.75.75 0 0 1 0-1.06Z'

/** GitHub-style issue state icon (open: ring, closed: ring + check). */
export function IssueStateIcon({ state }: { state: 'open' | 'closed' }) {
  return (
    <svg
      className={`cv-pr-icon cv-issue-${state}`}
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d={state === 'closed' ? OCTICON_ISSUE_CLOSED : OCTICON_ISSUE_OPEN} />
    </svg>
  )
}

/** Label of a linked item's state (GitHub wording). */
export function linkedStateLabel(source: NonNullable<TimelineEvent['source']>): string {
  const state = linkedState(source)
  if (source.is_pr) {
    return state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : '打开'
  }
  return state === 'closed' ? '已关闭' : '打开'
}

/** One resolved dependency: number + title + GitHub state. */
export interface Dependency {
  number: number
  title: string
  state: string
}

/** Dependency graph of the viewed issue: who it waits on, who waits on it. */
export interface Dependencies {
  blockedBy: Dependency[]
  blocking: Dependency[]
}

/** Derive the owner/repo part of a GitHub URL for building dependency links. */
export function repoOf(url: string | undefined): string {
  const match = String(url ?? '').match(/github\.com\/([^/]+\/[^/]+)\//)
  return match ? match[1] : ''
}

/**
 * 「在 DSH 对话中打开」按钮(issue #53):在仓库本地路径对应的 DSH
 * workspace 新开空白对话并预填 issue 链接草稿,回车前不发送。
 * 远程配置(无本机路径)或 DSH 服务缺失时禁用并给出原因,不静默失败。
 */
export function DshOpenButton({ project, issueUrl }: { project: ProjectOption | null; issueUrl: string }) {
  const [busy, setBusy] = React.useState(false)
  const [status, setStatus] = React.useState<string | null>(null)
  const disabledReason = !project
    ? '该仓库未在 ~/.clickvibe/config.yaml 配置,无法定位本地路径'
    : !project.available
      ? '该仓库为远程配置(无本机路径),无法打开 DSH 对话'
      : null

  const onClick = async () => {
    const activeClientCtx = getClientContext()
    if (!project?.available || !activeClientCtx || busy) return
    setBusy(true)
    setStatus(null)
    try {
      const deps = resolveDshConversationDeps(activeClientCtx)
      if ('missing' in deps) {
        setStatus(`DSH 服务不可用(缺 ${deps.missing.join('、')}),无法打开对话`)
        return
      }
      const result = await openDshConversationDraft(deps, project.path, issueUrl)
      setStatus(result.ok ? (result.warning ?? null) : result.error)
    } catch (reason) {
      setStatus(`DSH 对话打开失败: ${reason instanceof Error ? reason.message : String(reason)}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="cv-dsh-open-row">
      <button
        className="cv-dsh-open-btn"
        onClick={() => {
          void onClick()
        }}
        disabled={disabledReason !== null || busy}
        title={disabledReason ?? '在该仓库对应的 DSH 项目新开空白对话,并预填此 issue 链接(回车前不会发送)'}
      >
        {busy ? 'DSH 打开中…' : '💬 在 DSH 对话中打开'}
      </button>
      {status ? (
        <span className="cv-dsh-open-status" role="status">
          {status}
        </span>
      ) : null}
    </div>
  )
}

export function IssueView({
  issue,
  kind,
  workflow,
  onWorkflow,
  timeline,
  dependencies,
  autoAction,
  onAutoActionHandled,
  onDelivered,
  project,
}: {
  issue: GhIssue
  kind: 'issue' | 'pr'
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
  timeline?: TimelineEvent[]
  dependencies?: Dependencies
  autoAction?: boolean
  onAutoActionHandled?: () => void
  onDelivered?: () => void
  /** 当前 issue 所属仓库的本地配置;PR 详情不传,「在 DSH 对话中打开」随之不渲染。 */
  project?: ProjectOption | null
}) {
  const isPR = kind === 'pr'
  const state = String(issue.state || '').toUpperCase()
  const stateBadge =
    isPR && state === 'MERGED' ? (
      <span className="cv-badge cv-badge-merged">✅ Merged</span>
    ) : state === 'OPEN' ? (
      <span className="cv-badge cv-badge-open">🟢 Open</span>
    ) : (
      <span className="cv-badge cv-badge-closed">🔴 Closed</span>
    )
  const labels = (issue.labels ?? []).map((l) => `#${l.name}`).join(' ')
  const assignees = (issue.assignees ?? []).map((a) => `@${a.login}`).join(' ')

  const metaRows: [string, string][] = []
  metaRows.push(['作者', `@${issue.author?.login ?? 'unknown'}`])
  metaRows.push(['创建', fmtDate(issue.createdAt)])
  if (issue.updatedAt) metaRows.push(['更新', fmtDate(issue.updatedAt)])
  if (issue.closedAt) metaRows.push(['关闭', fmtDate(issue.closedAt)])
  if (isPR && issue.mergedAt) metaRows.push(['合并', fmtDate(issue.mergedAt)])
  if (issue.milestone) metaRows.push(['里程碑', issue.milestone.title])
  if (isPR) {
    metaRows.push(['分支', `${issue.baseRefName} ← ${issue.headRefName}`])
    metaRows.push(['变更', `+${issue.additions} / -${issue.deletions} · ${issue.changedFiles} 文件`])
    metaRows.push(['提交', String((issue.commits ?? []).length)])
    if (issue.mergeStateStatus && issue.mergeStateStatus !== 'UNKNOWN') {
      metaRows.push(['合并状态', issue.mergeStateStatus])
    }
  }

  return (
    <div className="cv-issue">
      <div className="cv-issue-head">
        {stateBadge}
        <span className="cv-badge cv-badge-kind">{isPR ? `PR #${issue.number}` : `Issue #${issue.number}`}</span>
      </div>
      <a className="cv-issue-title" href={issue.url} target="_blank" rel="noreferrer">
        {issue.title}
      </a>
      {!isPR && issue.url ? <DshOpenButton project={project ?? null} issueUrl={String(issue.url)} /> : null}
      {labels ? (
        <div className="cv-issue-labels">
          {labels.split(' ').map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </div>
      ) : null}
      {assignees ? <div className="cv-issue-assignees">👤 {assignees}</div> : null}
      <table className="cv-meta">
        <tbody>
          {metaRows.map((row, i) => (
            <tr key={i}>
              <td className="cv-meta-k">{row[0]}</td>
              <td className="cv-meta-v">{row[1]}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {/* 开发上下文:worktree + 基线 —— 只要进入开发流程就显示,不依赖 PR */}
      {workflow ? (
        <div className="cv-links">
          <div className="cv-link-row">
            📁 worktree
            <code className="cv-tl-hash">{workflow.worktree}</code>
          </div>
          {workflow.baseRef ? (
            <div className="cv-link-row">
              📍 基线
              <code className="cv-tl-hash">{workflow.baseRef}</code>
            </div>
          ) : null}
        </div>
      ) : null}
      {/* 依赖图:blockedBy(依赖谁)/ blocking(谁依赖我)——与 GitHub「关联」明确区分 */}
      {dependencies && (dependencies.blockedBy.length > 0 || dependencies.blocking.length > 0) ? (
        <CollapsibleSection
          key={sectionStorageKey(issue.url, 'dependencies')}
          storageKey={sectionStorageKey(issue.url, 'dependencies')}
          title="依赖图"
          defaultExpanded={true}
        >
          <div className="cv-links">
            {dependencies.blockedBy.length > 0 ? (
              <div className="cv-dep-block">
                <div className="cv-dep-label">🔒 blockedBy(依赖,需先完成)</div>
                {dependencies.blockedBy.map((dep, i) => {
                  const dependencyState = dep.state.toLowerCase()
                  return (
                    <div key={i} className="cv-link-row">
                      <a
                        className="cv-link"
                        href={`https://github.com/${repoOf(issue.url)}/issues/${dep.number}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{dep.number}
                        {dep.title ? ` ${dep.title}` : ''}
                      </a>
                      {dependencyState === 'closed' ? (
                        <span className="cv-link-state cv-link-state-closed">已关闭(依赖完成)</span>
                      ) : dependencyState === 'open' ? (
                        <span className="cv-link-state cv-link-state-open">打开(未完成)</span>
                      ) : null}
                    </div>
                  )
                })}
              </div>
            ) : null}
            {dependencies.blocking.length > 0 ? (
              <div className="cv-dep-block">
                <div className="cv-dep-label">🔓 blocking(被依赖,等我完成)</div>
                {dependencies.blocking.map((dep, i) => {
                  const dependencyState = dep.state.toLowerCase()
                  return (
                    <div key={i} className="cv-link-row">
                      <a
                        className="cv-link"
                        href={`https://github.com/${repoOf(issue.url)}/issues/${dep.number}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        #{dep.number}
                        {dep.title ? ` ${dep.title}` : ''}
                      </a>
                      <span className={`cv-link-state cv-link-state-${dependencyState}`}>
                        {dependencyState === 'closed' ? '已关闭' : dependencyState === 'open' ? '打开' : dep.state}
                      </span>
                    </div>
                  )
                })}
              </div>
            ) : null}
          </div>
        </CollapsibleSection>
      ) : null}
      {timeline && timeline.length > 0 ? (
        <CollapsibleSection
          key={sectionStorageKey(issue.url, 'github-timeline')}
          storageKey={sectionStorageKey(issue.url, 'github-timeline')}
          title="时间线"
          defaultExpanded={false}
        >
          <div className="cv-links">
            {timeline.map((ev, i) => {
              if (ev.event === 'cross-referenced' && ev.source) {
                const linkedStateValue = linkedState(ev.source)
                return (
                  <div key={i} className="cv-link-row">
                    {ev.source.is_pr ? (
                      <PrStateIcon state={linkedStateValue} />
                    ) : (
                      <IssueStateIcon state={linkedStateValue === 'closed' ? 'closed' : 'open'} />
                    )}
                    <span className="cv-link-kind">{ev.source.is_pr ? 'PR' : 'Issue'}</span>
                    <a className="cv-link" href={ev.source.html_url} target="_blank" rel="noreferrer">
                      #{ev.source.number} {ev.source.title ?? ''}
                    </a>
                    <span
                      className={
                        ev.source.is_pr
                          ? `cv-link-state cv-link-state-${linkedStateValue}`
                          : `cv-link-state ${linkedStateValue === 'closed' ? 'cv-link-state-issue-closed' : 'cv-link-state-open'}`
                      }
                    >
                      {linkedStateLabel(ev.source)}
                    </span>
                  </div>
                )
              }
              if (ev.event === 'referenced' && ev.commit_id) {
                return (
                  <div key={i} className="cv-link-row">
                    🔗 引用提交 <code className="cv-md-code">{ev.commit_id.slice(0, 7)}</code>
                  </div>
                )
              }
              return null
            })}
          </div>
        </CollapsibleSection>
      ) : null}
      <div className="cv-issue-body">
        <div className="cv-md">{renderMarkdown(issue.body ?? '')}</div>
      </div>
      {issue.url && kind === 'issue' && (state === 'OPEN' || workflow?.derived?.nextAction.kind === 'cleanup') ? (
        <DevSection
          key={issue.url}
          url={issue.url}
          issue={issue}
          workflow={workflow}
          onWorkflow={onWorkflow}
          autoAction={autoAction}
          onAutoActionHandled={onAutoActionHandled}
          onDelivered={onDelivered}
        />
      ) : null}
      <CommentsSection comments={issue.comments ?? []} />
    </div>
  )
}

export function CommentsSection({ comments }: { comments: GhComment[] }) {
  const [open, setOpen] = React.useState(true)
  const count = comments.length
  if (count === 0) {
    return <div className="cv-comments-empty">💬 暂无评论</div>
  }
  return (
    <div className="cv-comments">
      <button className="cv-comments-toggle" onClick={() => setOpen(!open)}>
        💬 {count} 条评论 {open ? '▾' : '▸'}
      </button>
      {open
        ? comments.map((c, i) => (
            <div key={i} className="cv-comment">
              <div className="cv-comment-head">
                <span className="cv-comment-author">@{c.author?.login ?? 'unknown'}</span>
                <span className="cv-comment-date">{fmtDate(c.createdAt)}</span>
              </div>
              <div className="cv-md cv-comment-body">{renderMarkdown(c.body ?? '')}</div>
            </div>
          ))
        : null}
    </div>
  )
}
