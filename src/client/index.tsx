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
.cv-dev-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.cv-dev-btn { padding: 5px 10px; border: none; border-radius: 6px; cursor: pointer; font-size: 12px; font-weight: 600; color: #ffffff; }
.cv-dev-btn:disabled { cursor: default; opacity: 0.6; }
.cv-dev-codex { background: #1f2328; }
.cv-dev-claude { background: #d97706; }
.cv-dev-dryrun { background: #57606a; }
.cv-dev-status { font-size: 12px; color: #57606a; }
.cv-dev-path { font-size: 11px; color: #8c959f; word-break: break-all; margin-top: 2px; }
.cv-dev-error { font-size: 12px; color: #cf222e; background: #ffebe9; border: 1px solid #ff8182; border-radius: 4px; padding: 6px 8px; }
.cv-dev-log { background: #0d1117; color: #e6edf3; border-radius: 6px; padding: 8px 10px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow-y: auto; margin: 0; }
.cv-dev-done { font-size: 12px; color: #1a7f37; font-weight: 600; }
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

function IssueView({ issue, kind }: { issue: GhIssue; kind: 'issue' | 'pr' }) {
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
      <div className="cv-issue-body">
        <div className="cv-md">{renderMarkdown(issue.body ?? '')}</div>
      </div>
      {issue.url && kind === 'issue' && state === 'OPEN'
        ? <DevSection url={issue.url} />
        : null}
      <CommentsSection comments={issue.comments ?? []} />
    </div>
  )
}

type DevelopAgent = 'codex' | 'claude' | 'dryrun'
type DevelopStatus = 'idle' | 'starting' | 'creating' | 'running' | 'done' | 'failed'
const MAX_UI_LOG_LINES = 2_000

interface DevState {
  status: DevelopStatus
  worktree?: string
  branch?: string
  error?: string
}

interface PollSuccess {
  ok: true
  status: 'creating' | 'running' | 'done' | 'failed'
  cursor: number
  delta: string[]
  truncated: boolean
  done: boolean
}

async function apiCall<T>(method: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/clickvibe/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return response.json() as Promise<T>
}

function DevSection({ url }: { url: string }) {
  const [state, setState] = React.useState<DevState>({ status: 'idle' })
  const [logs, setLogs] = React.useState<string[]>([])
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null)
  const logRef = React.useRef<HTMLPreElement | null>(null)

  const stopPolling = React.useCallback(() => {
    if (timerRef.current !== null) clearTimeout(timerRef.current)
    timerRef.current = null
  }, [])

  React.useEffect(() => stopPolling, [stopPolling])
  React.useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [logs])

  const start = async (agent: DevelopAgent) => {
    if (agent !== 'dryrun' && !window.confirm(
      `将启动 ${agent} 执行该 Issue 及评论中的指令,并可能修改代码、提交、推送或创建 PR。确认继续?`,
    )) return
    stopPolling()
    setState({ status: 'starting' })
    setLogs([])
    try {
      const started = await apiCall<
        | { ok: true; taskId: string; worktree: string; branch: string }
        | { ok: false; error: string }
      >('develop', { url, agent })
      if (!started.ok) {
        setState({ status: 'failed', error: started.error })
        return
      }
      setState({ status: 'creating', worktree: started.worktree, branch: started.branch })
      let cursor = 0
      const poll = async (): Promise<void> => {
        try {
          const result = await apiCall<PollSuccess | { ok: false; error: string }>(
            'develop/poll',
            { taskId: started.taskId, cursor },
          )
          if (!result.ok) throw new Error(result.error)
          cursor = result.cursor
          if (result.delta.length > 0) setLogs((previous) => {
            const combined = [...previous, ...result.delta]
            if (combined.length <= MAX_UI_LOG_LINES) return combined
            return ['[clickvibe] 面板较早日志已截断', ...combined.slice(-(MAX_UI_LOG_LINES - 1))]
          })
          setState((previous) => ({ ...previous, status: result.status }))
          if (result.done) {
            stopPolling()
            return
          }
          timerRef.current = setTimeout(() => { void poll() }, 750)
        } catch (error) {
          stopPolling()
          setState((previous) => ({
            ...previous,
            status: 'failed',
            error: `日志轮询失败: ${String(error instanceof Error ? error.message : error)}`,
          }))
        }
      }
      await poll()
    } catch (error) {
      setState({ status: 'failed', error: `启动失败: ${String(error instanceof Error ? error.message : error)}` })
    }
  }

  const active = state.status === 'starting' || state.status === 'creating' || state.status === 'running'
  return (
    <div className="cv-dev">
      <div className="cv-dev-head">🚀 一键开发</div>
      <div className="cv-dev-actions">
        <button className="cv-dev-btn cv-dev-codex" disabled={active} onClick={() => { void start('codex') }}>Codex 开发</button>
        <button className="cv-dev-btn cv-dev-claude" disabled={active} onClick={() => { void start('claude') }}>Claude 开发</button>
        <button className="cv-dev-btn cv-dev-dryrun" disabled={active} onClick={() => { void start('dryrun') }}>安全演练</button>
      </div>
      {state.status !== 'idle' ? (
        <div className="cv-dev-status">
          {state.status === 'starting' ? '正在启动…'
            : state.status === 'creating' ? '正在准备 worktree…'
              : state.status === 'running' ? `开发中 (${state.branch ?? ''})`
                : state.status === 'done' ? '任务已完成'
                  : '任务失败'}
          {state.worktree ? <div className="cv-dev-path">{state.worktree}</div> : null}
        </div>
      ) : null}
      {state.error ? <div className="cv-dev-error">{state.error}</div> : null}
      {logs.length > 0 ? <pre ref={logRef} className="cv-dev-log">{logs.join('\n')}</pre> : null}
      {state.status === 'done' ? <div className="cv-dev-done">✅ 开发完成</div> : null}
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
  const [result, setResult] = React.useState<{ kind: 'issue' | 'pr'; item: GhIssue } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const run = async () => {
    if (!url.trim()) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetchIssue(url.trim())
      if (res.ok) setResult(res.data as { kind: 'issue' | 'pr'; item: GhIssue })
      else setError(res.error)
    } catch (e) {
      setError(`调用失败: ${String(e)}`)
    } finally {
      setLoading(false)
    }
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
        <button className="cv-fetch" onClick={run} disabled={loading}>
          {loading ? '抓取中…' : '抓取'}
        </button>
      </div>
      {error ? <div className="cv-error">{error}</div> : null}
      {result
        ? <IssueView issue={result.item} kind={result.kind} />
        : loading
          ? <div className="cv-loading">正在通过 gh 抓取…</div>
          : <div className="cv-hint">粘贴一个 GitHub issue / PR 链接,回车抓取</div>}
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
