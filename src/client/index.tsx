/**
 * clickvibe client half: the right-side issue/PR panel.
 *
 * Registers:
 * - `shell.overlay` (id `clickvibe`) — the right-side floating panel,
 * - `sidebar.footer.action` (id `clickvibe`) — the toggle button.
 *
 * Fetching goes through the plugin's own `/clickvibe/api/fetch` route
 * (no harness RPC — this is a formal bundle plugin, not a dynamic one).
 */
import React from 'react'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type references that load the SlotMap augmentations for the slots this
// bundle registers into (shell.overlay, sidebar.footer.action). Importing
// a named type from each package's /client face forces TS to load its
// client d.ts, whose `declare module '@deepseek-ai/dsh-client-ui-slots'`
// merges the slot names.
import type { LayoutController } from '@deepseek-ai/dsh-client-ui-layout/client'
import type { SidebarFooterActionOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _SlotLoaders = [typeof LayoutController, SidebarFooterActionOwnerProps]

const PANEL_ID = 'clickvibe'

/** Panel open state shared between the footer toggle and the overlay. */
const panelState = { open: false, listeners: new Set<(v: boolean) => void>() }

function setPanelOpen(value: boolean): void {
  panelState.open = value
  for (const fn of panelState.listeners) fn(value)
}

function usePanelOpen(): boolean {
  const [open, setOpen] = React.useState(panelState.open)
  React.useEffect(() => {
    const listener = (v: boolean) => setOpen(v)
    panelState.listeners.add(listener)
    return () => { panelState.listeners.delete(listener) }
  }, [])
  return open
}

// ---- plugin-owned styles (injected once at activation) ----

const PANEL_CSS = `
.cv-panel { width: 420px; max-width: 90vw; height: 100%; display: flex; flex-direction: column; background: #ffffff; border-left: 1px solid #d0d7de; box-shadow: -8px 0 24px rgba(0,0,0,0.18); font-size: 13px; color: #1f2328; }
.cv-panel-header { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; font-weight: 600; color: #1f2328; border-bottom: 1px solid #d0d7de; flex-shrink: 0; }
.cv-close { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #57606a; }
.cv-close:hover { color: #1f2328; }
.cv-input-row { display: flex; gap: 6px; padding: 4px 14px; flex-shrink: 0; }
.cv-input-row:last-of-type { padding-bottom: 10px; }
.cv-input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #1f2328; font-size: 12px; }
.cv-input::placeholder { color: #8c959f; }
.cv-fetch { padding: 6px 12px; border: none; border-radius: 6px; background: #0969da; color: #ffffff; cursor: pointer; font-size: 12px; }
.cv-fetch:disabled { opacity: 0.6; }
.cv-error { margin: 0 14px 10px; padding: 8px 10px; border-radius: 6px; background: #ffebe9; color: #cf222e; border: 1px solid #ff8182; flex-shrink: 0; }
.cv-hint { padding: 20px 14px; color: #8c959f; text-align: center; }
.cv-loading { padding: 20px 14px; color: #57606a; text-align: center; }
.cv-issue { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; flex: 1; overflow-y: auto; }
.cv-issue-head { display: flex; gap: 6px; align-items: center; }
.cv-badge { display: inline-block; padding: 2px 8px; border-radius: 12px; font-size: 11px; font-weight: 600; }
.cv-badge-open { background: #dafbe1; color: #1a7f37; }
.cv-badge-closed { background: #ffebe9; color: #cf222e; }
.cv-badge-merged { background: #d8f5ff; color: #8250df; }
.cv-badge-kind { background: #f6f8fa; color: #57606a; }
.cv-issue-title { font-size: 15px; font-weight: 700; color: #0969da; text-decoration: none; }
.cv-issue-title:hover { text-decoration: underline; }
.cv-issue-labels { display: flex; flex-wrap: wrap; gap: 4px; font-size: 11px; }
.cv-issue-labels span { padding: 1px 6px; border-radius: 10px; background: #ddf4ff; color: #0969da; }
.cv-issue-assignees { font-size: 12px; color: #57606a; }
.cv-meta { width: 100%; border-collapse: collapse; font-size: 12px; }
.cv-meta tr { border-bottom: 1px solid #f0f2f4; }
.cv-meta tr:last-child { border-bottom: none; }
.cv-meta-k { width: 52px; padding: 3px 0; color: #8c959f; vertical-align: top; }
.cv-meta-v { padding: 3px 0; color: #1f2328; word-break: break-all; }
.cv-issue-body { border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; font-size: 12.5px; }
.cv-comments { display: flex; flex-direction: column; gap: 6px; }
.cv-comments-empty { font-size: 12px; color: #8c959f; padding: 4px 0; }
.cv-comments-toggle { border: none; background: transparent; cursor: pointer; font-size: 12.5px; font-weight: 600; color: #0969da; padding: 2px 0; text-align: left; }
.cv-comment { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; }
.cv-comment-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 11.5px; }
.cv-comment-author { font-weight: 600; color: #0969da; }
.cv-comment-date { color: #8c959f; }
.cv-toggle { border: 1px solid #d0d7de; background: #ffffff; border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; color: #1f2328; }
.cv-toggle:hover { background: #f6f8fa; }
.cv-md { font-size: 13px; line-height: 1.6; color: #1f2328; word-break: break-word; }
.cv-md-p { margin: 0 0 8px; }
.cv-md-h { margin: 10px 0 6px; font-weight: 600; }
.cv-md-h1 { font-size: 18px; }
.cv-md-h2 { font-size: 16px; }
.cv-md-h3 { font-size: 14.5px; }
.cv-md-h4, .cv-md-h5, .cv-md-h6 { font-size: 13.5px; }
.cv-md-pre { background: #f6f8fa; border: 1px solid #d0d7de; border-radius: 6px; padding: 10px; overflow-x: auto; margin: 0 0 8px; }
.cv-md-pre code { background: transparent; padding: 0; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; white-space: pre; }
.cv-md-code { background: #eff1f3; padding: 1px 4px; border-radius: 4px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.cv-md-link { color: #0969da; }
.cv-md-ul { padding-left: 20px; list-style: disc; margin: 0 0 8px; }
.cv-md-ol { padding-left: 20px; list-style: decimal; margin: 0 0 8px; }
.cv-md-blockquote { border-left: 4px solid #d0d7de; padding-left: 10px; margin: 0 0 8px; color: #57606a; }
.cv-md-hr { border: none; border-top: 1px solid #d0d7de; margin: 10px 0; }
.cv-dev { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.cv-dev-head { font-weight: 600; font-size: 12.5px; color: #1f2328; }
.cv-dev-actions { display: flex; gap: 6px; }
.cv-dev-btn { padding: 5px 12px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; color: #ffffff; }
.cv-dev-codex { background: #1f2328; }
.cv-dev-claude { background: #d97706; }
.cv-dev-btn:hover { opacity: 0.85; }
.cv-dev-status { font-size: 12px; color: #57606a; }
.cv-dev-path { font-size: 11px; color: #8c959f; word-break: break-all; margin-top: 2px; }
.cv-dev-error { font-size: 12px; color: #cf222e; background: #ffebe9; border: 1px solid #ff8182; border-radius: 4px; padding: 6px 8px; }
.cv-dev-log { background: #0d1117; color: #e6edf3; border-radius: 6px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 200px; overflow-y: auto; margin: 0; }
.cv-dev-done { font-size: 12px; color: #1a7f37; font-weight: 600; }
.cv-stage { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; margin-left: 6px; }
.cv-stage-idle { background: #f6f8fa; color: #57606a; }
.cv-stage-developing { background: #ddf4ff; color: #0969da; }
.cv-stage-review-ready { background: #fff8c5; color: #9a6700; }
.cv-stage-reviewing { background: #fbefff; color: #8250df; }
.cv-stage-passed { background: #dafbe1; color: #1a7f37; }
.cv-dev-btn.cv-dev-warn { background: #d4a72c; color: #ffffff; }
.cv-dev-btn.cv-dev-review { background: #8250df; color: #ffffff; }
.cv-review-fail { display: flex; flex-direction: column; gap: 6px; }
.cv-review-issues { margin: 0; padding-left: 18px; font-size: 12px; color: #1f2328; }
.cv-review-issues li { margin: 2px 0; }
.cv-refresh { padding: 6px 10px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #57606a; cursor: pointer; font-size: 14px; line-height: 1; }
.cv-refresh:hover { background: #f6f8fa; color: #1f2328; }
.cv-links { display: flex; flex-direction: column; gap: 4px; }
.cv-link-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #57606a; flex-wrap: wrap; }
.cv-link { color: #0969da; font-weight: 600; text-decoration: none; }
.cv-link:hover { text-decoration: underline; }
.cv-link-state { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-link-state-open { background: #dafbe1; color: #1a7f37; }
.cv-link-state-closed { background: #ffebe9; color: #cf222e; }
.cv-link-state-merged { background: #d8f5ff; color: #8250df; }
.cv-stage-new { background: #fff8c5; color: #9a6700; }
.cv-timeline { border-top: 1px solid #d0d7de; padding-top: 6px; display: flex; flex-direction: column; gap: 4px; }
.cv-timeline-head { font-size: 12px; font-weight: 600; color: #57606a; }
.cv-tl-row { display: flex; align-items: center; gap: 6px; font-size: 11.5px; flex-wrap: wrap; }
.cv-tl-kind { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-tl-kind-dev { background: #ddf4ff; color: #0969da; }
.cv-tl-kind-rework { background: #fff8c5; color: #9a6700; }
.cv-tl-kind-review { background: #fbefff; color: #8250df; }
.cv-tl-kind-resume { background: #f6f8fa; color: #57606a; }
.cv-tl-kind-note { background: #f6f8fa; color: #57606a; }
.cv-tl-time { color: #8c959f; }
.cv-tl-hash { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 10.5px; background: #eff1f3; padding: 0 4px; border-radius: 4px; }
.cv-tl-verdict { font-weight: 600; }
.cv-tl-pass { color: #1a7f37; }
.cv-tl-fail { color: #cf222e; }
.cv-tl-note { color: #57606a; }
`

/** Inject the plugin stylesheet once; returns the disposer. */
function installStyles(): () => void {
  const tag = document.createElement('style')
  tag.dataset.plugin = PANEL_ID
  tag.textContent = PANEL_CSS
  document.head.appendChild(tag)
  return () => { tag.remove() }
}

// ---- light Markdown renderer (pure JS, no third-party dependency) ----

const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

function renderInline(text: string, keyBase: string): React.ReactNode[] {
  const parts = String(text).split(INLINE_RE)
  return parts.map((part, i) => {
    const key = `${keyBase}-${i}`
    if (part === '') return null
    if (part.startsWith('`') && part.endsWith('`')) {
      return <code key={key} className="cv-md-code">{part.slice(1, -1)}</code>
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{renderInline(part.slice(2, -2), `${key}s`)}</strong>
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{renderInline(part.slice(1, -1), `${key}e`)}</em>
    }
    const link = part.match(/^\[([^\]]+)\]\(([^)]+)\)$/)
    if (link) {
      const href = /^https?:\/\//.test(link[2]) ? link[2] : '#'
      return <a key={key} className="cv-md-link" href={href} target="_blank" rel="noreferrer">{renderInline(link[1], `${key}l`)}</a>
    }
    return part
  })
}

interface ListState { ordered: boolean; items: string[] }

function renderMarkdown(md: string): React.ReactNode[] {
  const lines = String(md || '').split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  const push = (el: React.ReactNode) => { blocks.push(el); key++ }

  const flushList = (list: ListState | null) => {
    if (list === null) return
    const Tag = list.ordered ? 'ol' : 'ul'
    push(
      <Tag key={`b${key}`} className={list.ordered ? 'cv-md-ol' : 'cv-md-ul'}>
        {list.items.map((item, j) => <li key={j}>{renderInline(item, `li${key}-${j}`)}</li>)}
      </Tag>,
    )
  }

  let list: ListState | null = null

  while (i < lines.length) {
    const line = lines[i].trim()

    if (line.startsWith('```')) {
      flushList(list); list = null
      const buf: string[] = []
      i++
      while (i < lines.length && !lines[i].trim().startsWith('```')) {
        buf.push(lines[i])
        i++
      }
      i++
      push(<pre key={`b${key}`} className="cv-md-pre"><code>{buf.join('\n')}</code></pre>)
      continue
    }

    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      flushList(list); list = null
      const level = h[1].length
      const H = `h${level}` as 'h1'
      push(<H key={`b${key}`} className={`cv-md-h cv-md-h${level}`}>{renderInline(h[2], `h${key}`)}</H>)
      i++
      continue
    }

    if (line.startsWith('>')) {
      flushList(list); list = null
      const quote: string[] = []
      while (i < lines.length && lines[i].trim().startsWith('>')) {
        quote.push(lines[i].trim().replace(/^>\s?/, ''))
        i++
      }
      push(<blockquote key={`b${key}`} className="cv-md-blockquote">{renderInline(quote.join('\n'), `q${key}`)}</blockquote>)
      continue
    }

    if (/^(\*{3,}|-{3,}|_{3,})$/.test(line)) {
      flushList(list); list = null
      push(<hr key={`b${key}`} className="cv-md-hr" />)
      i++
      continue
    }

    const ul = line.match(/^[-*]\s+(.*)$/)
    if (ul) {
      if (list === null || list.ordered) { flushList(list); list = { ordered: false, items: [] } }
      list.items.push(ul[1])
      i++
      continue
    }

    const ol = line.match(/^\d+\.\s+(.*)$/)
    if (ol) {
      if (list === null || !list.ordered) { flushList(list); list = { ordered: true, items: [] } }
      list.items.push(ol[1])
      i++
      continue
    }

    if (line === '') {
      flushList(list); list = null
      i++
      continue
    }

    flushList(list); list = null
    const para: string[] = []
    while (
      i < lines.length && lines[i].trim() !== ''
      && !/^(#{1,6})\s/.test(lines[i].trim())
      && !lines[i].trim().startsWith('```')
      && !lines[i].trim().startsWith('>')
      && !/^[-*]\s/.test(lines[i].trim())
      && !/^\d+\.\s/.test(lines[i].trim())
    ) {
      para.push(lines[i].trim())
      i++
    }
    const paraNodes: React.ReactNode[] = []
    para.forEach((p, j) => {
      if (j > 0) paraNodes.push(<br key={`br${key}-${j}`} />)
      paraNodes.push(...renderInline(p, `p${key}-${j}`))
    })
    push(<p key={`b${key}`} className="cv-md-p">{paraNodes}</p>)
  }

  flushList(list)
  return blocks
}

// ---- display components ----

function fmtDate(s: string | undefined): string {
  if (!s) return ''
  try { return new Date(s).toLocaleString() } catch { return s }
}

interface GhComment {
  author?: { login?: string } | null
  createdAt?: string
  body?: string
}

interface GhIssue {
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

interface TimelineEvent {
  event: string
  created_at?: string
  actor?: string
  commit_id?: string | null
  source?: { number?: number; title?: string; html_url?: string; state?: string } | null
}

function IssueView({ issue, kind, workflow, onWorkflow, timeline }: {
  issue: GhIssue
  kind: 'issue' | 'pr'
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
  timeline?: TimelineEvent[]
}) {
  const isPR = kind === 'pr'
  const state = String(issue.state || '').toUpperCase()
  const stateBadge = isPR && state === 'MERGED'
    ? <span className="cv-badge cv-badge-merged">✅ Merged</span>
    : state === 'OPEN'
      ? <span className="cv-badge cv-badge-open">🟢 Open</span>
      : <span className="cv-badge cv-badge-closed">🔴 Closed</span>
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
      <a className="cv-issue-title" href={issue.url} target="_blank" rel="noreferrer">{issue.title}</a>
      {labels ? <div className="cv-issue-labels">{labels.split(' ').map((l, i) => <span key={i}>{l}</span>)}</div> : null}
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
      {timeline && timeline.length > 0 ? (
        <div className="cv-links">
          {timeline.map((ev, i) => {
            if (ev.event === 'cross-referenced' && ev.source) {
              return (
                <div key={i} className="cv-link-row">
                  🔗 关联
                  <a className="cv-link" href={ev.source.html_url} target="_blank" rel="noreferrer">
                    {ev.source.title ? `#${ev.source.number} ${ev.source.title}` : `#${ev.source.number}`}
                  </a>
                  <span className={`cv-link-state cv-link-state-${ev.source.state ?? 'open'}`}>
                    {ev.source.state === 'closed' ? '已关闭' : ev.source.state === 'merged' ? '已合并' : '打开'}
                  </span>
                </div>
              )
            }
            if (ev.event === 'referenced' && ev.commit_id) {
              return <div key={i} className="cv-link-row">🔗 引用提交 <code className="cv-md-code">{ev.commit_id.slice(0, 7)}</code></div>
            }
            return null
          })}
        </div>
      ) : null}
      <div className="cv-issue-body">
        <div className="cv-md">{renderMarkdown(issue.body ?? '')}</div>
      </div>
      {issue.url && kind === 'issue' && state === 'OPEN'
        ? <DevSection url={issue.url} workflow={workflow} onWorkflow={onWorkflow} />
        : null}
      <CommentsSection comments={issue.comments ?? []} />
    </div>
  )
}

async function apiCall<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/clickvibe/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json() as Promise<T>
}

interface Workflow {
  key: string
  url: string
  repoKey: string
  worktree: string
  branch: string
  stage: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
  devAgent: 'codex' | 'claude' | null
  devTaskId: string | null
  devSessionId: string | null
  devInterrupted: boolean
  reviewAgent: 'codex' | 'claude' | null
  reviewTaskId: string | null
  reviewSessionId: string | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
  updatedAt: number
  events?: WorkflowEvent[]
  derived?: { head: string | null; hasNewCommits: boolean; lastDevHash: string | null; lastReviewHash: string | null }
}

interface WorkflowEvent {
  kind: 'dev' | 'review' | 'rework' | 'resume' | 'note'
  at: string
  hash?: string
  verdict?: { passed: boolean; issues: string[] }
  note?: string
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function stageLabel(stage: Workflow['stage'], workflow: Workflow | null): string {
  switch (stage) {
    case 'idle': return '未开发'
    case 'developing': return '开发中'
    case 'review-ready':
      // 已有 review 结果:未通过 → "Review 未通过";否则 → "待 review"
      return workflow?.reviewResult
        ? (workflow.reviewResult.passed ? 'Review 通过' : 'Review 未通过')
        : '待 review'
    case 'reviewing': return 'review 中'
    case 'passed': return '✅ 已通过'
  }
}

function DevSection({ url, workflow, onWorkflow }: {
  url: string
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [statusLines, setStatusLines] = React.useState<string[]>([])
  const esRef = React.useRef<EventSource | null>(null)
  const stage = workflow?.stage ?? 'idle'
  const interrupted = workflow?.devInterrupted ?? false

  // 打开 SSE 实时流
  const openStream = (taskId: string) => {
    esRef.current?.close()
    const es = new EventSource(`/clickvibe/api/stream?taskId=${encodeURIComponent(taskId)}`)
    esRef.current = es
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data) as string | { __done?: boolean }
        if (typeof data === 'object' && data.__done) {
          es.close()
          return
        }
        setStatusLines((prev) => [...prev, String(data)])
      } catch {
        setStatusLines((prev) => [...prev, e.data])
      }
    }
    es.onerror = () => { es.close() }
  }

  React.useEffect(() => () => {
    esRef.current?.close()
  }, [])

  // 恢复现场:若已有进行中的任务,重连其 SSE
  React.useEffect(() => {
    if (!workflow) return
    const taskId = workflow.stage === 'reviewing' ? workflow.reviewTaskId : workflow.devTaskId
    if (taskId && (workflow.stage === 'developing' || workflow.stage === 'reviewing')) {
      openStream(taskId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow?.devTaskId, workflow?.reviewTaskId, workflow?.stage])

  const refresh = async () => {
    const res = await apiCall<{ ok: true; workflows: Workflow[] }>('state', {})
    if (res.ok) {
      onWorkflow(res.workflows.find((w) => w.url === url) ?? null)
    }
  }

  const startDev = async (agent: 'codex' | 'claude', context?: string) => {
    setBusy('developing')
    setError(null)
    setStatusLines([])
    try {
      const res = await apiCall<{ ok: true; taskId: string; worktree: string; branch: string } | { ok: false; error: string }>('develop', context ? { url, agent, context } : { url, agent })
      if (!res.ok) { setError(res.error); setBusy(null); return }
      await refresh()
      openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e)); setBusy(null)
    }
  }

  const resume = async (context?: string) => {
    setBusy('resuming')
    setError(null)
    setStatusLines([])
    try {
      const res = await apiCall<{ ok: true; taskId: string } | { ok: false; error: string }>('resume', context ? { url, context } : { url })
      if (!res.ok) { setError(res.error); setBusy(null); return }
      await refresh()
      openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e)); setBusy(null)
    }
  }

  const startReview = async (agent: 'codex' | 'claude') => {
    setBusy('reviewing')
    setError(null)
    setStatusLines([])
    try {
      const res = await apiCall<{ ok: true; taskId: string } | { ok: false; error: string }>('review', { url, agent })
      if (!res.ok) { setError(res.error); setBusy(null); return }
      await refresh()
      openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e)); setBusy(null)
    }
  }

  const showDevButtons = stage === 'idle'
  const showReviewButtons = stage === 'review-ready' && !interrupted && !workflow?.reviewResult
  const showReworkButtons = stage === 'review-ready' && workflow?.reviewResult?.passed === false

  return (
    <div className="cv-dev">
      {/* 状态卡:当前状态 + 关键事实 */}
      <div className="cv-dev-head">
        🚀 开发流程 <span className={`cv-stage cv-stage-${stage}`}>{stageLabel(stage, workflow)}</span>
        {workflow?.derived?.hasNewCommits ? <span className="cv-stage cv-stage-new">有未 review 的新提交</span> : null}
      </div>
      {workflow?.worktree ? <div className="cv-dev-path">{workflow.worktree}</div> : null}
      {workflow?.derived?.head ? <div className="cv-dev-path">HEAD {workflow.derived.head}</div> : null}

      {/* 操作区(悬浮感):与信息分离 */}
      <div className="cv-dev-actions">
        {interrupted && stage === 'developing' ? (
          <button className="cv-dev-btn cv-dev-warn" onClick={() => resume()} disabled={busy !== null}>
            {busy === 'resuming' ? '恢复中…' : '↩ 恢复开发'}
          </button>
        ) : null}
        {showDevButtons ? (
          <>
            <button className="cv-dev-btn cv-dev-codex" onClick={() => startDev('codex')} disabled={busy !== null}>Codex 开发</button>
            <button className="cv-dev-btn cv-dev-claude" onClick={() => startDev('claude')} disabled={busy !== null}>Claude 开发</button>
          </>
        ) : null}
        {showReviewButtons ? (
          <>
            <button className="cv-dev-btn cv-dev-review" onClick={() => startReview('codex')} disabled={busy !== null}>Codex Review</button>
            <button className="cv-dev-btn cv-dev-review" onClick={() => startReview('claude')} disabled={busy !== null}>Claude Review</button>
          </>
        ) : null}
        {workflow?.reviewResult && !workflow.reviewResult.passed ? (
          <button
            className="cv-dev-btn cv-dev-codex"
            onClick={() => resume(workflow?.reviewResult?.issues.join('\n'))}
            disabled={busy !== null}
            title="续上次开发会话,并把 review 意见带进去"
          >↩ 按 review 意见继续开发</button>
        ) : null}
      </div>

      {error ? <div className="cv-dev-error">{error}</div> : null}

      {statusLines.length > 0 ? (
        <pre className="cv-dev-log">{statusLines.join('\n')}</pre>
      ) : null}

      {/* 最新 review 结论(当前状态的一部分) */}
      {workflow?.reviewResult && !workflow.reviewResult.passed ? (
        <div className="cv-review-fail">
          <div className="cv-dev-error">❌ 最近一次 Review 发现 {workflow.reviewResult.issues.length} 个问题</div>
          <ul className="cv-review-issues">
            {workflow.reviewResult.issues.map((issue, i) => <li key={i}>{issue}</li>)}
          </ul>
        </div>
      ) : null}
      {workflow?.reviewResult?.passed ? <div className="cv-dev-done">✅ Review 通过</div> : null}

      {/* 历史时间线:全部事件,按时间顺序 */}
      {(workflow?.events ?? []).length > 0 ? (
        <div className="cv-timeline">
          <div className="cv-timeline-head">📜 历史</div>
          {[...(workflow?.events ?? [])].reverse().map((ev, i) => (
            <div key={i} className="cv-tl-row">
              <span className={`cv-tl-kind cv-tl-kind-${ev.kind}`}>
                {ev.kind === 'dev' ? '开发' : ev.kind === 'rework' ? '返工' : ev.kind === 'review' ? 'Review' : ev.kind === 'resume' ? '恢复' : '备注'}
              </span>
              <span className="cv-tl-time">{fmtTime(ev.at)}</span>
              {ev.hash ? <code className="cv-tl-hash">{ev.hash}</code> : null}
              {ev.kind === 'review' && ev.verdict
                ? <span className={ev.verdict.passed ? 'cv-tl-verdict cv-tl-pass' : 'cv-tl-verdict cv-tl-fail'}>
                    {ev.verdict.passed ? '✅ 通过' : `❌ ${ev.verdict.issues.length} 个问题`}
                  </span>
                : null}
              {ev.note ? <span className="cv-tl-note">{ev.note}</span> : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function CommentsSection({ comments }: { comments: GhComment[] }) {
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
      {open ? comments.map((c, i) => (
        <div key={i} className="cv-comment">
          <div className="cv-comment-head">
            <span className="cv-comment-author">@{c.author?.login ?? 'unknown'}</span>
            <span className="cv-comment-date">{fmtDate(c.createdAt)}</span>
          </div>
          <div className="cv-md cv-comment-body">{renderMarkdown(c.body ?? '')}</div>
        </div>
      )) : null}
    </div>
  )
}

async function fetchIssue(url: string): Promise<{ ok: true; data: { kind: 'issue' | 'pr'; item: unknown } } | { ok: false; error: string }> {
  const response = await fetch('/clickvibe/api/fetch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url }),
  })
  return response.json() as Promise<{ ok: true; data: { kind: 'issue' | 'pr'; item: unknown } } | { ok: false; error: string }>
}

function PanelContent() {
  const [url, setUrl] = React.useState('')
  const [loading, setLoading] = React.useState(false)
  const [result, setResult] = React.useState<{ kind: 'issue' | 'pr'; item: GhIssue; timeline?: TimelineEvent[] } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [workflow, setWorkflow] = React.useState<Workflow | null>(null)
  const [restored, setRestored] = React.useState(false)

  // 恢复现场:打开面板时读回所有工作流,若存在进行中的任务自动重连展示
  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await apiCall<{ ok: true; workflows: Workflow[] }>('state', {})
        if (!cancelled && res.ok && res.workflows.length > 0) {
          const active = res.workflows[0]
          setWorkflow(active)
          setUrl(active.url)
          // 自动重新抓取该 issue
          const fetchRes = await fetchIssue(active.url)
          if (!cancelled) {
            if (fetchRes.ok) setResult(fetchRes.data as { kind: 'issue' | 'pr'; item: GhIssue; timeline?: TimelineEvent[] })
            else setError(fetchRes.error)
          }
        }
      } catch {
        // 恢复失败不阻塞面板
      } finally {
        if (!cancelled) setRestored(true)
      }
    })()
    return () => { cancelled = true }
  }, [])

  const run = async (targetUrl = url) => {
    const trimmed = targetUrl.trim()
    if (!trimmed) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      // 按目标 url 匹配已存 workflow(恢复现场的关键:抓取不清 workflow)
      const stateRes = await apiCall<{ ok: true; workflows: Workflow[] }>('state', {})
      const matched = stateRes.ok ? stateRes.workflows.find((w) => w.url === trimmed) ?? null : null
      setWorkflow(matched)
      const res = await fetchIssue(trimmed)
      if (res.ok) setResult(res.data as { kind: 'issue' | 'pr'; item: GhIssue; timeline?: TimelineEvent[] })
      else setError(res.error)
    } catch (e) {
      setError(`调用失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
  }

  const updateWorkflow = (w: Workflow | null) => {
    setWorkflow(w)
    // workflow 变化时同步刷新状态(不打断当前展示)
  }

  return (
    <div className="cv-panel">
      <div className="cv-panel-header">
        <span>ClickVibe</span>
        <button className="cv-close" onClick={() => setPanelOpen(false)}>✕</button>
      </div>
      <div className="cv-input-row" />
      <div className="cv-input-row">
        <input
          className="cv-input"
          placeholder="https://github.com/owner/repo/issues/123 或 /pull/123"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') run() }}
        />
        <button className="cv-fetch" onClick={() => run()} disabled={loading}>
          {loading ? '抓取中…' : '抓取'}
        </button>
        {result ? (
          <button className="cv-refresh" onClick={() => run()} disabled={loading} title="重新抓取当前 issue">
            ⟳
          </button>
        ) : null}
      </div>
      {error ? <div className="cv-error">{error}</div> : null}
      {result
        ? <IssueView issue={result.item} kind={result.kind} workflow={workflow} onWorkflow={updateWorkflow} timeline={result.timeline} />
        : loading
          ? <div className="cv-loading">正在通过 gh 抓取…</div>
          : restored
            ? <div className="cv-hint">粘贴一个 GitHub issue / PR 链接,回车抓取</div>
            : <div className="cv-loading">正在恢复现场…</div>}
    </div>
  )
}

export const name = 'clickvibe-client'

export const inject = ['slots']

export function apply(ctx: ClientContext): void {
  const slots = ctx.get('slots')
  if (slots === undefined) return

  ctx.effect(() => {
    const disposers: (() => void)[] = [installStyles()]

    disposers.push(slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: PANEL_ID, order: 20 },
      () => {
        const open = usePanelOpen()
        if (!open) return null
        return (
          <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, zIndex: 9000, pointerEvents: 'auto' }}>
            <PanelContent />
          </div>
        )
      },
    )))

    disposers.push(slots.inject('sidebar.footer.action', () => slots.register(
      { name: 'sidebar.footer.action', id: PANEL_ID, order: 20 },
      (props: { wide: boolean }) => (
        <button
          className="cv-toggle"
          title="ClickVibe"
          onClick={() => setPanelOpen(!panelState.open)}
        >
          {props.wide ? 'ClickVibe' : 'CV'}
        </button>
      ),
    )))

    return () => { for (const dispose of disposers) dispose() }
  }, 'clickvibe: styles, panel and toggle')
}
