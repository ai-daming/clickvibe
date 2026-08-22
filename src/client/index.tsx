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
import { selectHistoryTask } from '../task-history.ts'
import { githubCompareUrl, workflowStatusLabel } from '../state-view.ts'
import { deliveryPublicationLabel, type DeliveryPublication } from '../delivery-publication.ts'
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
.cv-panel-header-actions { display: flex; align-items: center; gap: 6px; }
.cv-close { border: none; background: transparent; cursor: pointer; font-size: 14px; color: #57606a; }
.cv-close:hover { color: #1f2328; }
.cv-input-row { display: flex; gap: 6px; padding: 4px 14px; flex-shrink: 0; }
.cv-input-row:last-of-type { padding-bottom: 10px; }
.cv-project-toolbar { padding: 10px 12px; border-bottom: 1px solid #d0d7de; display: grid; gap: 8px; }
.cv-project-selects { display: flex; gap: 6px; }
.cv-select { min-width: 0; flex: 1; border: 1px solid #d0d7de; border-radius: 6px; background: #fff; padding: 6px 8px; color: #1f2328; }
.cv-project-meta { color: #57606a; font-size: 11px; }
.cv-project-list { flex: 1; overflow-y: auto; padding: 8px 10px 16px; }
.cv-group-title { margin: 10px 2px 5px; color: #57606a; font-size: 11px; font-weight: 700; }
.cv-issue-row { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; gap: 8px; align-items: center; padding: 9px 8px; border: 1px solid #d8dee4; border-radius: 7px; margin-bottom: 6px; background: #fff; }
.cv-issue-row-main { min-width: 0; }
.cv-issue-row-title { display: block; color: #0969da; font-size: 12.5px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; cursor: pointer; }
.cv-issue-row-meta { color: #57606a; font-size: 10.5px; margin-top: 3px; display: flex; gap: 7px; flex-wrap: wrap; }
.cv-row-lag { color: #9a6700; font-weight: 600; }
.cv-row-contract { color: #cf222e; font-weight: 600; }
.cv-row-action { border: none; border-radius: 6px; padding: 5px 8px; background: #1f883d; color: white; font-size: 11px; white-space: nowrap; cursor: pointer; }
.cv-row-action.cv-row-none { background: #afb8c1; cursor: default; }
.cv-row-action.cv-row-running { background: #0969da; cursor: default; }
.cv-back { border: none; background: transparent; color: #0969da; cursor: pointer; padding: 0; font-size: 12px; }
.cv-input { flex: 1; min-width: 0; padding: 6px 8px; border: 1px solid #d0d7de; border-radius: 6px; background: #ffffff; color: #1f2328; font-size: 12px; }
.cv-input::placeholder { color: #8c959f; }
.cv-fetch { padding: 6px 12px; border: none; border-radius: 6px; background: #0969da; color: #ffffff; cursor: pointer; font-size: 12px; }
.cv-fetch:disabled { opacity: 0.6; }
.cv-error { margin: 0 14px 10px; padding: 8px 10px; border-radius: 6px; background: #ffebe9; color: #cf222e; border: 1px solid #ff8182; flex-shrink: 0; }
.cv-stale { margin: 8px 12px 0; padding: 6px 8px; border-radius: 6px; background: #fff8c5; color: #9a6700; border: 1px solid #d4a72c; font-size: 11.5px; flex-shrink: 0; }
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
.cv-dep-block { display: flex; flex-direction: column; gap: 4px; }
.cv-dep-label { font-size: 12px; font-weight: 600; color: #57606a; }
.cv-link-row { display: flex; align-items: center; gap: 6px; font-size: 12px; color: #57606a; flex-wrap: wrap; }
.cv-link { color: #0969da; font-weight: 600; text-decoration: none; }
.cv-link:hover { text-decoration: underline; }
.cv-link-state { display: inline-block; padding: 0 6px; border-radius: 8px; font-size: 10.5px; font-weight: 600; }
.cv-link-state-open { background: #dafbe1; color: #1a7f37; }
.cv-link-state-closed { background: #ffebe9; color: #cf222e; }
.cv-link-state-merged { background: #d8f5ff; color: #8250df; }
.cv-link-state-open { background: #dafbe1; color: #1a7f37; }
.cv-link-kind { font-size: 10.5px; font-weight: 700; color: #57606a; }
.cv-pr-icon { flex-shrink: 0; display: inline-block; }
.cv-pr-open { color: #1a7f37; }
.cv-pr-merged { color: #8250df; }
.cv-pr-closed { color: #cf222e; }
.cv-issue-open { color: #1a7f37; }
.cv-issue-closed { color: #8250df; }
.cv-link-state-issue-closed { background: #fbefff; color: #8250df; }
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
.cv-tl-public { color: #0969da; font-weight: 600; text-decoration: none; }
.cv-tl-public:hover { text-decoration: underline; }
.cv-tl-local { color: #8c959f; }
.cv-tl-publish-fail { color: #cf222e; font-weight: 600; }
.cv-delivery-summary { font-size: 12px; color: #57606a; background: #f6f8fa; border-radius: 4px; padding: 6px 8px; }
.cv-review-next { font-size: 12px; font-weight: 600; }
.cv-state { border: 1px solid #d0d7de; border-radius: 6px; padding: 8px 10px; display: flex; flex-direction: column; gap: 4px; }
.cv-state-head { font-size: 12px; font-weight: 600; color: #57606a; }
.cv-state-table { width: 100%; border-collapse: collapse; font-size: 11.5px; }
.cv-state-table td { padding: 3px 0; vertical-align: top; }
.cv-state-k { width: 78px; color: #8c959f; font-weight: 600; }
.cv-state-v { color: #1f2328; word-break: break-all; }
.cv-state-delta { display: block; color: #57606a; font-size: 11px; }
.cv-state-warn { display: inline-block; margin-left: 6px; padding: 0 6px; border-radius: 8px; background: #fff8c5; color: #9a6700; font-weight: 600; font-size: 10.5px; }
.cv-review-stale { font-size: 12px; color: #9a6700; background: #fff8c5; border: 1px solid #d4a72c; border-radius: 4px; padding: 6px 8px; }
.cv-dev-noop { font-size: 12px; color: #8c959f; padding: 4px 0; }
.cv-agent-toggle { display: inline-flex; gap: 2px; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; align-self: center; }
.cv-agent-toggle button { border: none; background: #ffffff; color: #57606a; padding: 4px 10px; font-size: 12px; cursor: pointer; }
.cv-agent-toggle button.on { background: #0969da; color: #ffffff; }
.cv-agent-toggle button:disabled { opacity: 0.45; cursor: not-allowed; }
.cv-dev-btn.cv-dev-sync { background: #0969da; }
.cv-dev-btn.cv-dev-merge { background: #1a7f37; }
.cv-dev-link { border: none; background: transparent; color: #0969da; font-size: 11.5px; cursor: pointer; padding: 4px 2px; text-decoration: underline; }
.cv-dev-link:hover { opacity: 0.8; }
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
function linkedState(source: NonNullable<TimelineEvent['source']>): 'open' | 'closed' | 'merged' {
  if (source.is_pr) {
    if (source.pr_merged) return 'merged'
    return source.state === 'closed' ? 'closed' : 'open'
  }
  return source.state === 'closed' ? 'closed' : 'open'
}

const OCTICON_PR = 'M1.5 3.25a2.25 2.25 0 1 1 3 2.122v5.256a2.251 2.251 0 1 1-1.5 0V5.372A2.25 2.25 0 0 1 1.5 3.25Zm5.677-.177L9.573.677A.25.25 0 0 1 10 .854V2.5h1A2.5 2.5 0 0 1 13.5 5v5.628a2.251 2.251 0 1 1-1.5 0V5a1 1 0 0 0-1-1h-1v1.646a.25.25 0 0 1-.427.177L7.177 3.427a.25.25 0 0 1 0-.354ZM3.75 2.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm0 9.5a.75.75 0 1 0 0 1.5.75.75 0 0 0 0-1.5Zm8.25.75a.75.75 0 1 0 1.5 0 .75.75 0 0 0-1.5 0Z'
const OCTICON_MERGE = 'M5.45 5.154A4.25 4.25 0 0 0 9.25 7.5h1.378a2.251 2.251 0 1 1 0 1.5H9.25A5.734 5.734 0 0 1 5 7.123v3.505a2.25 2.25 0 1 1-1.5 0V5.372a2.25 2.25 0 1 1 1.95-.218ZM4.25 13.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm8.5-8.5a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Z'

/** GitHub-style PR state icon (open: pull-request, merged: git-merge, closed: pull-request). */
function PrStateIcon({ state }: { state: 'open' | 'closed' | 'merged' }) {
  return (
    <svg className={`cv-pr-icon cv-pr-${state}`} viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d={state === 'merged' ? OCTICON_MERGE : OCTICON_PR} />
    </svg>
  )
}

const OCTICON_ISSUE_OPEN = 'M8 9.5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Z'
const OCTICON_ISSUE_CLOSED = 'M8 0a8 8 0 1 1 0 16A8 8 0 0 1 8 0ZM1.5 8a6.5 6.5 0 1 0 13 0 6.5 6.5 0 0 0-13 0Zm3.97 1.78a.75.75 0 0 1 1.06 0l1.22 1.22 2.28-2.28a.75.75 0 1 1 1.06 1.06l-2.81 2.81a.75.75 0 0 1-1.06 0l-1.75-1.75a.75.75 0 0 1 0-1.06Z'

/** GitHub-style issue state icon (open: ring, closed: ring + check). */
function IssueStateIcon({ state }: { state: 'open' | 'closed' }) {
  return (
    <svg className={`cv-pr-icon cv-issue-${state}`} viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d={state === 'closed' ? OCTICON_ISSUE_CLOSED : OCTICON_ISSUE_OPEN} />
    </svg>
  )
}

/** Label of a linked item's state (GitHub wording). */
function linkedStateLabel(source: NonNullable<TimelineEvent['source']>): string {
  const state = linkedState(source)
  if (source.is_pr) {
    return state === 'merged' ? '已合并' : state === 'closed' ? '已关闭' : '打开'
  }
  return state === 'closed' ? '已关闭' : '打开'
}

/** One resolved dependency: number + title + GitHub state. */
interface Dependency {
  number: number
  title: string
  state: string
}

/** Dependency graph of the viewed issue: who it waits on, who waits on it. */
interface Dependencies {
  blockedBy: Dependency[]
  blocking: Dependency[]
}

/** Derive the owner/repo part of a GitHub URL for building dependency links. */
function repoOf(url: string | undefined): string {
  const match = String(url ?? '').match(/github\.com\/([^/]+\/[^/]+)\//)
  return match ? match[1] : ''
}

function IssueView({ issue, kind, workflow, onWorkflow, timeline, dependencies, autoAction, onAutoActionHandled, onDelivered }: {
  issue: GhIssue
  kind: 'issue' | 'pr'
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
  timeline?: TimelineEvent[]
  dependencies?: Dependencies
  autoAction?: boolean
  onAutoActionHandled?: () => void
  onDelivered?: () => void
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
        <div className="cv-links">
          {dependencies.blockedBy.length > 0 ? (
            <div className="cv-dep-block">
              <div className="cv-dep-label">🔒 blockedBy(依赖,需先完成)</div>
              {dependencies.blockedBy.map((dep, i) => {
                const dependencyState = dep.state.toLowerCase()
                return <div key={i} className="cv-link-row">
                  <a className="cv-link" href={`https://github.com/${repoOf(issue.url)}/issues/${dep.number}`} target="_blank" rel="noreferrer">
                    #{dep.number}{dep.title ? ` ${dep.title}` : ''}
                  </a>
                  {dependencyState === 'closed'
                    ? <span className="cv-link-state cv-link-state-closed">已关闭(依赖完成)</span>
                    : dependencyState === 'open'
                      ? <span className="cv-link-state cv-link-state-open">打开(未完成)</span>
                      : null}
                </div>
              })}
            </div>
          ) : null}
          {dependencies.blocking.length > 0 ? (
            <div className="cv-dep-block">
              <div className="cv-dep-label">🔓 blocking(被依赖,等我完成)</div>
              {dependencies.blocking.map((dep, i) => {
                const dependencyState = dep.state.toLowerCase()
                return <div key={i} className="cv-link-row">
                  <a className="cv-link" href={`https://github.com/${repoOf(issue.url)}/issues/${dep.number}`} target="_blank" rel="noreferrer">
                    #{dep.number}{dep.title ? ` ${dep.title}` : ''}
                  </a>
                  <span className={`cv-link-state cv-link-state-${dependencyState}`}>
                    {dependencyState === 'closed' ? '已关闭' : dependencyState === 'open' ? '打开' : dep.state}
                  </span>
                </div>
              })}
            </div>
          ) : null}
        </div>
      ) : null}
      {timeline && timeline.length > 0 ? (
        <div className="cv-links">
          {timeline.map((ev, i) => {
            if (ev.event === 'cross-referenced' && ev.source) {
              const linkedStateValue = linkedState(ev.source)
              return (
                <div key={i} className="cv-link-row">
                  {ev.source.is_pr
                    ? <PrStateIcon state={linkedStateValue} />
                    : <IssueStateIcon state={linkedStateValue === 'closed' ? 'closed' : 'open'} />}
                  <span className="cv-link-kind">{ev.source.is_pr ? 'PR' : 'Issue'}</span>
                  <a className="cv-link" href={ev.source.html_url} target="_blank" rel="noreferrer">
                    #{ev.source.number} {ev.source.title ?? ''}
                  </a>
                  <span className={
                    ev.source.is_pr
                      ? `cv-link-state cv-link-state-${linkedStateValue}`
                      : `cv-link-state ${linkedStateValue === 'closed' ? 'cv-link-state-issue-closed' : 'cv-link-state-open'}`
                  }>
                    {linkedStateLabel(ev.source)}
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
      {issue.url && kind === 'issue' && (state === 'OPEN' || workflow?.derived?.nextAction.kind === 'cleanup')
        ? <DevSection key={issue.url} url={issue.url} issue={issue} workflow={workflow} onWorkflow={onWorkflow} autoAction={autoAction} onAutoActionHandled={onAutoActionHandled} onDelivered={onDelivered} />
        : null}
      <CommentsSection comments={issue.comments ?? []} />
    </div>
  )
}

async function apiCall<T>(method: string, body: Record<string, unknown>, timeoutMs?: number): Promise<T> {
  const controller = timeoutMs === undefined ? null : new AbortController()
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch(`/clickvibe/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clickvibe-request': '1' },
      body: JSON.stringify(body),
      ...(controller ? { signal: controller.signal } : {}),
    })
    return response.json() as Promise<T>
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
  }
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
  devSessionAgent: 'codex' | 'claude' | null
  devInterrupted: boolean
  reviewAgent: 'codex' | 'claude' | null
  reviewTaskId: string | null
  reviewSessionId: string | null
  reviewSessionAgent: 'codex' | 'claude' | null
  reviewResult: { passed: boolean; issues: string[]; commentUrl?: string } | null
  prNumber: string | null
  issueState?: 'OPEN' | 'CLOSED'
  baseRef: string | null
  delivery?: {
    status: 'merged' | 'cleanup-pending' | 'archived'
    mergedAt: string
    prHead: string
    mergeStrategy: 'merge'
    cleanup: { worktree: boolean; localBranch: boolean; remoteBranch: boolean; issue: boolean }
    lastError?: string
  }
  updatedAt: number
  events?: WorkflowEvent[]
  derived?: {
    head: string | null
    branch: string | null
    mainHead: string | null
    originMainHead: string | null
    upstreamHead: string | null
    aheadOfMain: number
    behindMain: number
    aheadOfBase: number
    behindBase: number
    aheadOfUpstream: number | null
    behindUpstream: number | null
    needsSync: boolean
    mergeConflict?: boolean
    lastDevHash: string | null
    lastReviewHash: string | null
    reviewedHash: string | null
    reviewedIssueBodyHash: string | null
    currentIssueBodyHash: string | null
    reviewedIssueUpdatedAt: string | null
    currentIssueUpdatedAt: string | null
    issueContractCurrent: boolean
    issueContractStatus: 'current' | 'changed' | 'unknown'
    issueContractUnknownReason: 'missing-review-snapshot' | 'current-contract-unavailable' | null
    hasNewCommits: boolean
    verdictCurrent: boolean
    nextAction: NextAction
    status: 'idle' | 'developing' | 'review-ready' | 'reviewing' | 'passed'
    baseBranch: string
  }
}

type NextActionKind = 'develop' | 'resume' | 'sync' | 'create-pr' | 'review' | 'rework' | 'merge' | 'cleanup' | 'none'

interface NextAction {
  kind: NextActionKind
  label: string
  hint: string
}

interface WorkflowEvent {
  kind: 'dev' | 'review' | 'rework' | 'resume' | 'note'
  at: string
  hash?: string
  verdict?: { passed: boolean; issues: string[] }
  issueContract?: { bodyHash: string; updatedAt: string }
  fixed?: number
  publication?: DeliveryPublication
  note?: string
}

function fmtTime(iso: string): string {
  try { return new Date(iso).toLocaleString() } catch { return iso }
}

function stageLabel(stage: Workflow['stage'], workflow: Workflow | null): string {
  return workflowStatusLabel(
    stage,
    workflow?.reviewResult?.passed ?? null,
    workflow?.derived?.verdictCurrent,
    workflow?.derived?.issueContractStatus,
    workflow?.derived?.issueContractUnknownReason,
  )
}

function DevSection({ url, issue, workflow, onWorkflow, autoAction, onAutoActionHandled, onDelivered }: {
  url: string
  issue: GhIssue
  workflow: Workflow | null
  onWorkflow: (w: Workflow | null) => void
  autoAction?: boolean
  onAutoActionHandled?: () => void
  onDelivered?: () => void
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [statusLines, setStatusLines] = React.useState<string[]>([])
  const [activeTaskId, setActiveTaskId] = React.useState<string | null>(null)
  const [streamState, setStreamState] = React.useState<'idle' | 'history' | 'connecting' | 'streaming' | 'retrying' | 'ended'>('idle')
  const [streamNotice, setStreamNotice] = React.useState<string | null>(null)
  const [agentChoice, setAgentChoice] = React.useState<'codex' | 'claude'>(() => workflow?.reviewAgent ?? workflow?.devAgent ?? 'codex')
  const esRef = React.useRef<EventSource | null>(null)
  const streamGenerationRef = React.useRef(0)
  const checkingStreamRef = React.useRef(false)
  const autoActionConsumedRef = React.useRef(false)
  const derived = workflow?.derived
  const stage = derived?.status ?? workflow?.stage ?? 'idle'
  const nextAction = derived?.nextAction
  const workflowEvents = workflow?.events ?? []
  const lastDelivery = [...workflowEvents].reverse().find((event) => event.kind === 'dev' || event.kind === 'rework')

  const appendStatusLine = (line: string) => {
    setStatusLines((previous) => [...previous, line])
  }

  type HistoryResponse =
    | { ok: true; taskId: string | null; key: string; kind: 'dev' | 'review'; lines: string[]; cursor: number; active: boolean }
    | { ok: false; error: string }

  const fetchHistory = async (taskId: string): Promise<HistoryResponse> => {
    const response = await fetch(`/clickvibe/api/history?taskId=${encodeURIComponent(taskId)}`)
    return response.json() as Promise<HistoryResponse>
  }

  // 磁盘历史是基线;只有 /history 返回的 cursor 之后才接 SSE 增量。
  const openStream = async (taskId: string, expectRunning = true) => {
    const generation = ++streamGenerationRef.current
    setActiveTaskId(taskId)
    setStreamState('history')
    setStreamNotice(null)
    esRef.current?.close()
    setStatusLines([])

    let history: HistoryResponse
    try {
      history = await fetchHistory(taskId)
    } catch {
      if (generation !== streamGenerationRef.current) return
      setStreamState('retrying')
      setStreamNotice('历史加载失败,正在等待网络恢复…')
      window.setTimeout(() => {
        if (generation === streamGenerationRef.current) void openStream(taskId, expectRunning)
      }, 1500)
      return
    }
    if (generation !== streamGenerationRef.current) return
    if (!history.ok) {
      setActiveTaskId(null)
      setStreamState('ended')
      setStreamNotice('任务已结束/中断')
      if (expectRunning) void refresh()
      return
    }

    setStatusLines(history.lines)
    if (!history.active) {
      setActiveTaskId(null)
      setStreamState(expectRunning ? 'ended' : 'idle')
      setStreamNotice(expectRunning ? '任务已结束/中断' : null)
      if (expectRunning) void refresh()
      return
    }

    setStreamState('connecting')
    const es = new EventSource(`/clickvibe/api/stream?taskId=${encodeURIComponent(taskId)}&cursor=${history.cursor}`)
    esRef.current = es
    es.onopen = () => {
      if (generation === streamGenerationRef.current) setStreamState('streaming')
    }
    es.onmessage = (e) => {
      if (generation !== streamGenerationRef.current) return
      try {
        const data = JSON.parse(e.data) as string | { __done?: boolean; __historyRequired?: boolean; line?: string; cursor?: number }
        if (typeof data === 'object' && data.__done) {
          es.close()
          setActiveTaskId(null)
          setStreamState('ended')
          void refresh()
          return
        }
        if (typeof data === 'object' && data.__historyRequired) {
          es.close()
          void openStream(taskId, true)
          return
        }
        appendStatusLine(typeof data === 'object' && typeof data.line === 'string' ? data.line : String(data))
      } catch {
        appendStatusLine(e.data)
      }
    }
    es.onerror = () => {
      if (generation !== streamGenerationRef.current || checkingStreamRef.current) return
      setStreamState('retrying')
      checkingStreamRef.current = true
      // EventSource hides HTTP status. Re-read the authoritative task target:
      // active means native EventSource retry should continue; inactive/404 is
      // terminal and must clear the stop control instead of failing silently.
      void fetchHistory(taskId).then((latest) => {
        if (generation !== streamGenerationRef.current) return
        if (latest.ok && latest.active) return
        es.close()
        setActiveTaskId(null)
        setStreamState('ended')
        setStreamNotice('任务已结束/中断')
        void refresh()
      }).catch(() => {
        // Network outage: leave EventSource open so its built-in retry survives
        // phone network switches and temporary Host unreachability.
      }).finally(() => {
        checkingStreamRef.current = false
      })
    }
  }

  React.useEffect(() => () => {
    streamGenerationRef.current += 1
    esRef.current?.close()
  }, [])

  // 恢复现场:完成态也加载最后一次磁盘历史;进行态再接 SSE。
  React.useEffect(() => {
    if (!workflow) return
    const { taskId, expectRunning } = selectHistoryTask({
      stage: workflow.stage,
      devTaskId: workflow.devTaskId,
      reviewTaskId: workflow.reviewTaskId,
      hasReviewResult: Boolean(workflow.reviewResult),
    })
    if (taskId) {
      void openStream(taskId, expectRunning)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workflow?.devTaskId, workflow?.reviewTaskId, workflow?.stage])

  // agent 选择跟随锁定 agent(review 锁 reviewAgent;resume/rework 用 devAgent)
  React.useEffect(() => {
    const preferred = workflow?.reviewAgent ?? workflow?.devAgent
    setAgentChoice(preferred ?? 'codex')
  }, [workflow?.reviewAgent, workflow?.devAgent])

  const refresh = async () => {
    const res = await apiCall<{ ok: true; workflows: Workflow[] }>('state', { url })
    if (res.ok) {
      onWorkflow(res.workflows.find((w) => w.url === url) ?? null)
    }
  }

  const authorize = async (
    action: 'develop' | 'review' | 'resume' | 'merge',
    agent: 'codex' | 'claude' | null,
    context = '',
  ): Promise<{ authorizationId: string; authorizationDigest: string; target?: { prNumber: string; branch: string; head: string; mergeFlag: '--merge' } } | null> => {
    const expectedSnapshot = {
      url,
      title: String(issue.title ?? ''),
      body: String(issue.body ?? ''),
      state: String(issue.state ?? '').toUpperCase(),
      updatedAt: String(issue.updatedAt ?? ''),
      comments: (issue.comments ?? []).map((comment) => ({
        author: String(comment.author?.login ?? 'unknown'),
        body: String(comment.body ?? ''),
      })),
    }
    const res = await apiCall<
      | { ok: true; authorizationId: string; authorizationDigest: string; target?: { prNumber: string; branch: string; head: string; mergeFlag: '--merge' }; preview: { title?: string; updatedAt?: string; commentCount?: number; digest: string } }
      | { ok: false; error: string }
    >('authorize', { action, url, ...(agent ? { agent } : {}), context, ...(action === 'develop' ? { expectedSnapshot } : {}) })
    if (!res.ok) { setError(res.error); return null }
    const preview = res.preview
    const mergePreview = preview as typeof preview & { prNumber?: string; branch?: string; mergeFlag?: string; cleanup?: string[] }
    const summary = action === 'develop'
      ? `${agent} 将以高权限开发以下已冻结快照:\n\n${preview.title ?? url}\n更新时间: ${preview.updatedAt || '未知'}\n评论: ${preview.commentCount ?? 0} 条\n快照: ${preview.digest.slice(0, 12)}\n\n确认启动?`
      : action === 'merge'
        ? `ClickVibe 将执行不可逆的合并与清理:\n\nPR: #${mergePreview.prNumber ?? '?'}\n分支: ${mergePreview.branch ?? '?'}\n策略: ${mergePreview.mergeFlag ?? '--merge'} (merge commit，禁止 squash/rebase)\n清理: ${(mergePreview.cleanup ?? []).join('、')}\n授权: ${res.authorizationDigest.slice(0, 12)}\n\n确认合并并清理?`
      : `${agent} 将以高权限执行 ${action}。\n目标: ${url}\n授权: ${preview.digest.slice(0, 12)}\n\n确认启动?`
    if (!window.confirm(summary)) return null
    return { authorizationId: res.authorizationId, authorizationDigest: res.authorizationDigest, ...(res.target ? { target: res.target } : {}) }
  }

  const startDev = async (agent: 'codex' | 'claude' | 'dryrun', context?: string) => {
    setBusy('developing')
    setError(null)
    setStatusLines([])
    try {
      const authorization = agent === 'dryrun' ? {} : await authorize('develop', agent, context ?? '')
      if (agent !== 'dryrun' && !authorization) { setBusy(null); return }
      const res = await apiCall<{ ok: true; taskId: string; worktree: string; branch: string } | { ok: false; error: string }>('develop', { url, agent, ...(context ? { context } : {}), ...authorization })
      if (!res.ok) { setError(res.error); setBusy(null); return }
      await refresh()
      void openStream(res.taskId)
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
      const agent = workflow?.devAgent ?? 'codex'
      const authorization = await authorize('resume', agent, context ?? '')
      if (!authorization) { setBusy(null); return }
      const res = await apiCall<{ ok: true; taskId: string } | { ok: false; error: string }>('resume', { url, agent, ...(context ? { context } : {}), ...authorization })
      if (!res.ok) { setError(res.error); setBusy(null); return }
      await refresh()
      void openStream(res.taskId)
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
      const authorization = await authorize('review', agent)
      if (!authorization) { setBusy(null); return }
      const res = await apiCall<{ ok: true; taskId: string } | { ok: false; error: string }>('review', { url, agent, ...authorization })
      if (!res.ok) { setError(res.error); setBusy(null); return }
      await refresh()
      void openStream(res.taskId)
      setBusy(null)
    } catch (e) {
      setError(String(e)); setBusy(null)
    }
  }

  const stop = async () => {
    if (!activeTaskId) return
    const res = await apiCall<{ ok: boolean; error?: string }>('stop', { taskId: activeTaskId })
    if (!res.ok) setError(res.error ?? '停止失败')
  }

  const syncWorktree = async () => {
    setBusy('syncing')
    setError(null)
    try {
      const res = await apiCall<{ ok: true; worktree: string; branch: string; head: string | null } | { ok: false; error: string; conflict?: boolean }>('sync', { url })
      if (!res.ok) {
        setError(res.error)
        // 冲突现场保留后,唯一动作会切换为「按意见返工」,刷新让按钮立即接手
        if (res.conflict) await refresh()
        // sync 没有 LiveTask/SSE;主动重载磁盘日志显示同步/冲突结果。
        if (workflow?.devTaskId) void openStream(workflow.devTaskId, false)
        setBusy(null)
        return
      }
      await refresh()
      if (workflow?.devTaskId) void openStream(workflow.devTaskId, false)
      setBusy(null)
    } catch (e) {
      setError(String(e)); setBusy(null)
    }
  }

  const mergeAndCleanup = async () => {
    setBusy('merging')
    setError(null)
    try {
      const authorization = await authorize('merge', null)
      if (!authorization) { setBusy(null); return }
      const res = await apiCall<
        | { ok: true; merged: true; archived: true; prNumber: string }
        | { ok: false; error: string; merged?: boolean; cleanupPending?: boolean }
      >('merge', { url, ...authorization })
      if (!res.ok) {
        setError(res.error)
        if (res.merged) await refresh()
        setBusy(null)
        return
      }
      await refresh()
      setBusy(null)
      onDelivered?.()
    } catch (e) {
      setError(String(e)); setBusy(null)
    }
  }

  // 唯一动作:服务端由 git 事实推导;issue 已关闭时本地覆盖为无动作
  const issueClosed = String(issue.state ?? '').toUpperCase() === 'CLOSED'
  // #5 回归修复:从未开发过(无 workflow 记录)的 OPEN issue,服务端 /api/state
  // 只枚举已持久化 workflow,不会为其推导 nextAction(恒为 undefined),导致按钮
  // 缺失。这里按 deriveNextAction 的 idle 分支本地兜底为『开始开发』;
  // 有 workflow 记录时仍以服务端推导为准。
  const idleDevelop: NextAction = { kind: 'develop', label: '开始开发', hint: '创建 worktree 并启动 agent 开发' }
  const effectiveAction: NextAction = issueClosed && nextAction?.kind !== 'cleanup'
    ? { kind: 'none', label: '无', hint: 'issue 已关闭,无待办动作' }
    : (nextAction ?? (workflow === null
      ? idleDevelop
      : { kind: 'none', label: '无', hint: '等待状态…' }))

  const runAction = () => {
    switch (effectiveAction.kind) {
      case 'develop': void startDev(agentChoice); break
      case 'resume': void resume(); break
      case 'rework': void resume(workflow?.reviewResult?.issues.join('\n')); break
      case 'review': void startReview(agentChoice); break
      case 'sync': void syncWorktree(); break
      case 'create-pr':
        if (workflow) {
          window.open(githubCompareUrl(workflow.repoKey, workflow.branch, workflow.baseRef, workflow.derived?.baseBranch), '_blank', 'noopener')
        }
        break
      case 'merge':
      case 'cleanup': void mergeAndCleanup(); break
      case 'none': break
    }
  }

  React.useEffect(() => {
    if (!autoAction) {
      autoActionConsumedRef.current = false
      return
    }
    if (autoActionConsumedRef.current || effectiveAction.kind === 'none') return
    autoActionConsumedRef.current = true
    onAutoActionHandled?.()
    runAction()
    // The parent owns the one-shot trigger; use the currently rendered issue snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAction])

  // review 锁定:从未 review 过则两个 agent 都可选;锁过只留那个
  const lockedAgent = effectiveAction.kind === 'review' ? workflow?.reviewAgent ?? null : null
  const showAgentToggle = effectiveAction.kind === 'develop' || effectiveAction.kind === 'review'

  const actionButtonClass = effectiveAction.kind === 'merge' || effectiveAction.kind === 'cleanup'
    ? 'cv-dev-btn cv-dev-merge'
    : effectiveAction.kind === 'sync'
      ? 'cv-dev-btn cv-dev-sync'
      : effectiveAction.kind === 'review'
        ? 'cv-dev-btn cv-dev-review'
        : (effectiveAction.kind === 'resume' || effectiveAction.kind === 'rework')
          ? 'cv-dev-btn cv-dev-warn'
          : 'cv-dev-btn cv-dev-codex'

  const busyLabel = busy === 'merging' ? '合并并清理中…' : busy === 'syncing' ? '同步中…' : busy === 'resuming' ? '恢复中…' : busy === 'reviewing' ? 'Review 中…' : busy === 'developing' ? '启动中…' : null

  return (
    <div className="cv-dev">
      {/* 状态卡:当前状态 + 关键事实 */}
      <div className="cv-dev-head">
        🚀 开发流程 <span className={`cv-stage cv-stage-${stage}`}>{stageLabel(stage, workflow)}</span>
        {derived?.hasNewCommits ? <span className="cv-stage cv-stage-new">有未 review 的新提交</span> : null}
      </div>
      {workflow?.worktree ? <div className="cv-dev-path">{workflow.worktree}</div> : null}
      {workflow?.prNumber ? (
        <div className="cv-dev-path">
          🔗 PR{' '}
          <a className="cv-link" href={`https://github.com/${workflow.repoKey}/pull/${workflow.prNumber}`} target="_blank" rel="noreferrer">
            #{workflow.prNumber}
          </a>
        </div>
      ) : null}
      {lastDelivery?.fixed !== undefined ? (
        <div className="cv-delivery-summary">
          {lastDelivery.fixed > 0
            ? `上次开发完成:修复 ${lastDelivery.fixed} 个 Review 问题,已请求再次 Review`
            : '上次开发完成:首次交付,已请求 Review'}
        </div>
      ) : null}

      {/* 权威状态视图:worktree / main / 远端 三方对比(issue #5) */}
      {derived ? (
        <div className="cv-state">
          <div className="cv-state-head">📊 状态视图</div>
          <table className="cv-state-table">
            <tbody>
              <tr>
                <td className="cv-state-k">worktree</td>
                <td className="cv-state-v">
                  {derived.branch ?? workflow?.branch ?? '—'} <code className="cv-tl-hash">{derived.head ?? '—'}</code>
                </td>
              </tr>
              {derived.mainHead ? (
                <tr>
                  <td className="cv-state-k">main</td>
                  <td className="cv-state-v">
                    <code className="cv-tl-hash">{derived.mainHead}</code>
                    <span className="cv-state-delta">worktree 落后 {derived.behindMain} · 领先 {derived.aheadOfMain}</span>
                  </td>
                </tr>
              ) : null}
              {derived.originMainHead ? (
                <tr>
                  <td className="cv-state-k">远端</td>
                  <td className="cv-state-v">
                    origin/main <code className="cv-tl-hash">{derived.originMainHead}</code>
                    <span className="cv-state-delta">worktree 落后 {derived.behindBase} · 领先 {derived.aheadOfBase}</span>
                    {derived.needsSync ? <span className="cv-state-warn">⚠ 需要同步</span> : null}
                    {derived.mergeConflict ? <span className="cv-state-warn">⚠ 合并冲突待解决(转交 agent)</span> : null}
                  </td>
                </tr>
              ) : null}
              {derived.upstreamHead ? (
                <tr>
                  <td className="cv-state-k">远端分支</td>
                  <td className="cv-state-v">
                    origin/{derived.branch ?? workflow?.branch} <code className="cv-tl-hash">{derived.upstreamHead}</code>
                    <span className="cv-state-delta">worktree 落后 {derived.behindUpstream ?? 0} · 领先 {derived.aheadOfUpstream ?? 0}</span>
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      ) : null}

      {/* review 结论同时绑定 HEAD 与 Issue 正文契约；任一变化都不冒充当前结论。 */}
      {workflow?.reviewResult ? (
        <div className={derived?.verdictCurrent ? (workflow.reviewResult.passed ? 'cv-dev-done' : 'cv-review-fail') : 'cv-review-stale'}>
          {derived?.verdictCurrent
            ? (workflow.reviewResult.passed
              ? `✅ Review 通过(针对提交 ${derived.reviewedHash ?? '?'})`
              : `❌ Review 发现 ${workflow.reviewResult.issues.length} 个问题(针对提交 ${derived.reviewedHash ?? '?'})`)
            : derived?.issueContractStatus === 'changed'
              ? `⏳ 验收已变更,需重新 Review(原契约 ${derived.reviewedIssueBodyHash?.slice(0, 12) ?? '?'},当前 ${derived.currentIssueBodyHash?.slice(0, 12) ?? '?'})`
              : derived?.issueContractUnknownReason === 'missing-review-snapshot'
                ? '⏳ 现有 Review 结论缺少验收契约快照,需重新 Review'
                : derived?.issueContractUnknownReason === 'current-contract-unavailable'
                  ? '⏸ 暂时无法读取当前验收契约,合并已暂停;请刷新后重试'
              : `⏳ Review 结论针对旧提交 ${derived?.reviewedHash ?? '?'},当前 HEAD ${derived?.head ?? '?'} 已变化,结论已过期`}
        </div>
      ) : null}
      {workflow?.reviewResult && !workflow.reviewResult.passed && derived?.verdictCurrent ? (
        <ul className="cv-review-issues">
          {workflow.reviewResult.issues.map((issue, i) => <li key={i}>{issue}</li>)}
        </ul>
      ) : null}
      {workflow?.reviewResult && derived?.verdictCurrent ? (
        <div className={`cv-review-next ${workflow.reviewResult.passed ? 'cv-tl-pass' : 'cv-tl-fail'}`}>
          下一步:{workflow.reviewResult.passed ? '可合并' : '请重新开发'}
        </div>
      ) : null}

      {/* 唯一动作 */}
      <div className="cv-dev-actions">
        {effectiveAction.kind === 'none' ? (
          <div className="cv-dev-noop">· {effectiveAction.hint}</div>
        ) : (
          <>
            {showAgentToggle ? (
              <div className="cv-agent-toggle" title={lockedAgent ? `Review 锁定 ${lockedAgent}` : '选择 agent'}>
                <button className={agentChoice === 'codex' ? 'on' : ''} onClick={() => setAgentChoice('codex')} disabled={lockedAgent !== null && lockedAgent !== 'codex'}>Codex</button>
                <button className={agentChoice === 'claude' ? 'on' : ''} onClick={() => setAgentChoice('claude')} disabled={lockedAgent !== null && lockedAgent !== 'claude'}>Claude</button>
              </div>
            ) : null}
            <button
              className={actionButtonClass}
              onClick={runAction}
              disabled={busy !== null}
              title={effectiveAction.hint}
            >
              {busyLabel ?? effectiveAction.label}
            </button>
          </>
        )}
        {stage === 'idle' && effectiveAction.kind === 'develop' ? (
          <button className="cv-dev-link" onClick={() => startDev('dryrun')} disabled={busy !== null}>安全演练(dry-run)</button>
        ) : null}
        {activeTaskId ? (
          <button className="cv-dev-btn cv-dev-warn" onClick={() => void stop()}>停止任务</button>
        ) : null}
      </div>

      {error ? <div className="cv-dev-error">{error}</div> : null}
      {streamNotice ? <div className="cv-dev-error">{streamNotice}</div> : null}

      {statusLines.length > 0 ? (
        <pre className="cv-dev-log">{statusLines.join('\n')}</pre>
      ) : streamState === 'history' ? (
        <pre className="cv-dev-log">正在恢复历史…</pre>
      ) : activeTaskId ? (
        <pre className="cv-dev-log">等待 agent 输出…{streamState === 'retrying' ? '\n连接中断,正在自动重连…' : ''}</pre>
      ) : null}

      {/* 交付流水:本地事件与其公开 GitHub 评论状态,按时间倒序 */}
      {workflowEvents.length > 0 ? (
        <div className="cv-timeline">
          <div className="cv-timeline-head">📜 交付流水 · 本地事件 / GitHub 评论</div>
          {[...workflowEvents].reverse().map((ev, i) => (
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
              {(ev.kind === 'dev' || ev.kind === 'rework') && ev.fixed !== undefined
                ? <span className="cv-tl-note">修复 {ev.fixed} 个问题</span>
                : null}
              {ev.note ? <span className="cv-tl-note">{ev.note}</span> : null}
              {ev.publication?.status === 'posted'
                ? ev.publication.url
                  ? <a className="cv-tl-public" href={ev.publication.url} target="_blank" rel="noreferrer">
                      {deliveryPublicationLabel(ev.publication)}
                    </a>
                  : <span className="cv-tl-public">{deliveryPublicationLabel(ev.publication)}</span>
                : ev.publication?.status === 'failed'
                  ? <span className="cv-tl-publish-fail" title={ev.publication.error}>{deliveryPublicationLabel(ev.publication)}</span>
                  : <span className="cv-tl-local">{deliveryPublicationLabel(ev.publication)}</span>}
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

type FetchIssueResponse =
  | { ok: true; data: { kind: 'issue' | 'pr'; item: unknown; timeline?: TimelineEvent[]; dependencies?: Dependencies }; dependencyError?: string }
  | { ok: false; error: string }

async function fetchIssue(url: string, timeoutMs?: number, forceRefresh = false): Promise<FetchIssueResponse> {
  const controller = timeoutMs === undefined ? null : new AbortController()
  const timeout = controller ? window.setTimeout(() => controller.abort(), timeoutMs) : null
  try {
    const response = await fetch('/clickvibe/api/fetch', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-clickvibe-request': '1' },
      body: JSON.stringify({ url, forceRefresh }),
      ...(controller ? { signal: controller.signal } : {}),
    })
    return response.json() as Promise<FetchIssueResponse>
  } finally {
    if (timeout !== null) window.clearTimeout(timeout)
  }
}

interface ProjectOption { repoKey: string; path: string; available: boolean }
interface RepositoryIssue extends GhIssue {
  blockedBy: Dependency[]
  workflow: Workflow
  contract?: { ok: boolean; missing: string[] }
}

interface RepositoryFreshness {
  stale: boolean
  refreshed: boolean
  refreshing: boolean
  lastAttemptAt: number
  lastSuccessAt: number | null
  repositoryCount?: number
  successfulRepositoryCount?: number
  partial?: boolean
  error?: string
}

type WorkflowStateResponse =
  | { ok: true; workflows: Workflow[]; freshness: RepositoryFreshness | null; dependenciesRefreshDue: boolean }
  | { ok: false; error: string }

function PanelContent() {
  const [projects, setProjects] = React.useState<ProjectOption[]>([])
  const [repoKey, setRepoKey] = React.useState('')
  const [issues, setIssues] = React.useState<RepositoryIssue[]>([])
  const [dependencyFilter, setDependencyFilter] = React.useState<'all' | 'ready' | 'blocked'>('all')
  const [groupBy, setGroupBy] = React.useState<'milestone' | 'dependency'>('milestone')
  const [loading, setLoading] = React.useState(false)
  const [result, setResult] = React.useState<{ kind: 'issue' | 'pr'; item: GhIssue; timeline?: TimelineEvent[]; dependencies?: Dependencies } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [workflow, setWorkflow] = React.useState<Workflow | null>(null)
  const [autoAction, setAutoAction] = React.useState(false)
  const [freshness, setFreshness] = React.useState<RepositoryFreshness | null>(null)
  const [dependencyRefreshError, setDependencyRefreshError] = React.useState<string | null>(null)
  const [stateRefreshError, setStateRefreshError] = React.useState<string | null>(null)
  const workflowRefreshInFlight = React.useRef(false)

  const mergeWorkflowStates = React.useCallback((workflows: Workflow[]) => {
    const byUrl = new Map(workflows.map((item) => [item.url, item]))
    setIssues((previous) => previous.map((issue) => {
      const current = byUrl.get(String(issue.url ?? ''))
      return current ? { ...issue, workflow: current } : issue
    }))
    setWorkflow((previous) => previous ? byUrl.get(previous.url) ?? previous : previous)
  }, [])

  const updateWorkflow = React.useCallback((next: Workflow | null) => {
    setWorkflow(next)
    if (next) mergeWorkflowStates([next])
  }, [mergeWorkflowStates])

  const refreshWorkflowStates = React.useCallback(async () => {
    if (!repoKey || workflowRefreshInFlight.current) return
    workflowRefreshInFlight.current = true
    try {
      const response = await apiCall<WorkflowStateResponse>('state', { repoKey }, 8_000)
      if (response.ok) {
        setStateRefreshError(null)
        mergeWorkflowStates(response.workflows)
        setFreshness(response.freshness)
        // GitHub dependency freshness has its own repo-scoped TTL clock. It is
        // deliberately independent from local git availability.
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
                { ok: true; issues: RepositoryIssue[]; freshness: RepositoryFreshness | null }
                | { ok: false; error: string }
              >('repo/issues', { repoKey }, 4_000)
              if (next.ok) {
                setIssues(next.issues)
                setFreshness(next.freshness)
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
      // Polling is best-effort. Keep the last usable snapshot when the panel
      // host disconnects; a later tick or explicit refresh will recover it.
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
    setStateRefreshError(null)
    setDependencyRefreshError(null)
    try {
      const response = await apiCall<
        { ok: true; issues: RepositoryIssue[]; freshness: RepositoryFreshness | null }
        | { ok: false; error: string }
      >('repo/issues', { repoKey: selected, forceRefresh }, 30_000)
      if (!response.ok) setError(response.error)
      else {
        setIssues(response.issues)
        setFreshness(response.freshness)
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
    return () => { cancelled = true }
  }, [])

  // Keep list badges bound to the same live /state facts as the detail view.
  React.useEffect(() => {
    if (!repoKey) return
    const timer = window.setInterval(() => { void refreshWorkflowStates() }, 5000)
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
        setStateRefreshError(null)
      } else if (stateResponse && !stateResponse.ok) {
        setStateRefreshError(stateResponse.error)
      }
      if (!response.ok) setError(response.error)
      else {
        // Workflows are persisted only after development starts; keep the
        // repo snapshot for never-started rows and as a graceful fallback when
        // /state is temporarily unavailable.
        setWorkflow(stateResponse?.ok
          ? stateResponse.workflows.find((item) => item.url === url) ?? issue.workflow
          : issue.workflow)
        setResult(response.data as { kind: 'issue' | 'pr'; item: GhIssue; timeline?: TimelineEvent[]; dependencies?: Dependencies })
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

  const filtered = issues.filter((issue) => {
    const blocked = issue.blockedBy.some((dependency) => dependency.state.toUpperCase() === 'OPEN')
    return dependencyFilter === 'all' || (dependencyFilter === 'blocked' ? blocked : !blocked)
  })
  const grouped = new Map<string, RepositoryIssue[]>()
  for (const issue of filtered) {
    const blocked = issue.blockedBy.some((dependency) => dependency.state.toUpperCase() === 'OPEN')
    const key = groupBy === 'milestone' ? issue.milestone?.title ?? '无里程碑' : blocked ? '被依赖阻塞' : '依赖已就绪'
    grouped.set(key, [...(grouped.get(key) ?? []), issue])
  }

  const rowAction = (issue: RepositoryIssue) => {
    const action = issue.workflow.derived?.nextAction
    if (!action || action.kind === 'none') return
    if (action.kind === 'create-pr') {
      window.open(githubCompareUrl(
        issue.workflow.repoKey,
        issue.workflow.branch,
        issue.workflow.baseRef,
        issue.workflow.derived?.baseBranch,
      ), '_blank', 'noopener')
      return
    }
    void openIssue(issue, true)
  }

  return (
    <div className="cv-panel">
      <div className="cv-panel-header">
        <span>{result ? <button className="cv-back" onClick={() => { setResult(null); setAutoAction(false); void refreshWorkflowStates() }}>← 项目 Issues</button> : 'ClickVibe · 项目'}</span>
        <span className="cv-panel-header-actions">
          {result ? <button className="cv-refresh" onClick={() => void refreshDetail()} disabled={loading} title="强制同步远端并刷新详情">⟳</button> : null}
          <button className="cv-close" onClick={() => setPanelOpen(false)}>✕</button>
        </span>
      </div>
      {freshness?.stale ? (
        <div className="cv-stale" title={freshness.error}>
          {freshness.refreshing
            ? '⚠ 状态可能过期 · 远端同步较慢，后台仍在刷新，当前使用本地 refs'
            : '⚠ 状态可能过期 · 远端同步失败，当前使用本地 refs'}
        </div>
      ) : null}
      {stateRefreshError ? <div className="cv-stale" title={stateRefreshError}>{stateRefreshError.startsWith('GitHub 额度已用完,约 ') ? stateRefreshError : '⚠ 状态可能过期 · 自动刷新失败，当前保留上次结果'}</div> : null}
      {dependencyRefreshError ? <div className="cv-stale" title={dependencyRefreshError}>{dependencyRefreshError.startsWith('GitHub 额度已用完,约 ') ? dependencyRefreshError : '⚠ 依赖状态可能过期 · GitHub 刷新失败，当前保留上次结果'}</div> : null}
      {result ? (
        <IssueView
          issue={result.item}
          kind={result.kind}
          workflow={workflow}
          onWorkflow={updateWorkflow}
          timeline={result.timeline}
          dependencies={result.dependencies}
          autoAction={autoAction}
          onAutoActionHandled={() => setAutoAction(false)}
          onDelivered={() => {
            setResult(null)
            setWorkflow(null)
            setAutoAction(false)
            void loadRepo(repoKey)
          }}
        />
      ) : (
        <>
          <div className="cv-project-toolbar">
            <select className="cv-select" value={repoKey} onChange={(event) => { const value = event.target.value; setRepoKey(value); void loadRepo(value) }}>
              {projects.map((project) => <option key={project.repoKey} value={project.repoKey}>{project.repoKey}{project.available ? '' : ' · 远程配置'}</option>)}
            </select>
            <div className="cv-project-selects">
              <select className="cv-select" value={dependencyFilter} onChange={(event) => setDependencyFilter(event.target.value as typeof dependencyFilter)}>
                <option value="all">全部依赖状态</option><option value="ready">依赖已就绪</option><option value="blocked">被依赖阻塞</option>
              </select>
              <select className="cv-select" value={groupBy} onChange={(event) => setGroupBy(event.target.value as typeof groupBy)}>
                <option value="milestone">按里程碑分组</option><option value="dependency">按依赖分组</option>
              </select>
              <button className="cv-refresh" onClick={() => void loadRepo(repoKey, true)} disabled={loading} title="刷新 GitHub 与 git 状态">⟳</button>
            </div>
            {repoKey ? <div className="cv-project-meta">{issues.length} 个 open issue · {projects.find((project) => project.repoKey === repoKey)?.available ? '本机 git + GitHub' : '远程配置 · GitHub'} 实时事实</div> : null}
          </div>
          {error ? <div className="cv-error">{error}</div> : null}
          {loading ? <div className="cv-loading">正在读取项目 issues 与实时状态…</div> : projects.length === 0 ? <div className="cv-hint">请先在 ~/.clickvibe/config.yaml 配置 repos</div> : (
            <div className="cv-project-list">
              {[...grouped.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([group, rows]) => (
                <React.Fragment key={group}>
                  <div className="cv-group-title">{group} · {rows.length}</div>
                  {[...rows].sort((a, b) => {
                    // 就绪优先:就绪(未开发+依赖OK) → 开发中 → 阻塞 → 已交付;同档按编号。
                    const levelOf = (issue: RepositoryIssue): number => {
                      if (issue.blockedBy.some((dependency) => dependency.state.toUpperCase() === 'OPEN')) return 2
                      const status = issue.workflow.derived?.status ?? issue.workflow.stage
                      if (status === 'passed') return 3
                      if (status === 'idle') return 0
                      return 1 // developing / reviewing / review-ready
                    }
                    return levelOf(a) - levelOf(b) || (a.number ?? 0) - (b.number ?? 0)
                  }).map((issue) => {
                    const derived = issue.workflow.derived
                    const status = derived?.status ?? issue.workflow.stage
                    const baseAction = derived?.nextAction ?? { kind: 'develop' as const, label: '开始开发', hint: '' }
                    // blockedBy 门槛:有 OPEN 依赖时,阻止"开始/恢复开发"(未开发先等依赖完成);
                    // review/返工/合并等已开发流程不受影响(不能因依赖未完成卡死已做的工作)。
                    const blockedByOpen = issue.blockedBy.filter((dependency) => dependency.state.toUpperCase() === 'OPEN')
                    const action = (baseAction.kind === 'develop' || baseAction.kind === 'resume') && blockedByOpen.length > 0
                      ? { kind: 'none' as const, label: `被 #${blockedByOpen.map((dependency) => dependency.number).join('#')} 阻塞`, hint: '依赖未完成,先完成被阻塞的依赖' }
                      : baseAction
                    // 契约门槛:缺 目标/验收标准/依赖 的 issue 标记『不满足契约』并提示补齐,
                    // 不硬选(不拦人工开发,按钮保留、hint 提示补全);自动选取(#9)按 contract.ok 排除。
                    const contract = issue.contract
                    const shownAction = contract && !contract.ok && (action.kind === 'develop' || action.kind === 'resume')
                      ? { ...action, hint: `该 issue 缺:${contract.missing.join('、')},建议先在 GitHub 补齐契约(目标/验收标准/依赖);人工仍可开发` }
                      : action
                    return <div className="cv-issue-row" key={issue.number}>
                      <span className={`cv-stage cv-stage-${status}`}>{stageLabel(status, issue.workflow)}</span>
                      <div className="cv-issue-row-main">
                        <span className="cv-issue-row-title" onClick={() => void openIssue(issue)}>#{issue.number} {issue.title}</span>
                        <div className="cv-issue-row-meta">
                          <span>分支: {issue.workflow.branch}</span>
                          {(derived?.behindBase ?? 0) > 0 ? <span className="cv-row-lag">⚠ 落后 {derived?.behindBase}</span> : null}
                          <span>里程碑: {issue.milestone?.title ?? '无'}</span>
                          <span>blockedBy: {issue.blockedBy.length ? issue.blockedBy.map((dependency) => `#${dependency.number}${dependency.state.toUpperCase() === 'OPEN' ? '⏳' : '✓'}`).join(' ') : '无'}</span>
                          {contract && !contract.ok ? <span className="cv-row-contract">⚠ 不满足契约(缺:{contract.missing.join('、')})</span> : null}
                        </div>
                      </div>
                      <button className={`cv-row-action${shownAction.kind === 'none' ? (shownAction.label === '任务进行中' ? ' cv-row-running' : ' cv-row-none') : ''}`} disabled={shownAction.kind === 'none'} title={shownAction.hint} onClick={() => rowAction(issue)}>{shownAction.kind === 'none' ? (status === 'passed' ? '已交付' : shownAction.label) : shownAction.label}</button>
                    </div>
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
