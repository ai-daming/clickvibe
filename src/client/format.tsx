/**
 * clickvibe client half: the right-side issue/PR panel.
 *
 * Registers:
 * - `shell.overlay` (id `clickvibe`) — the mount anchor for the occupied panel,
 * - `sidebar.footer.action` (id `clickvibe`) — the toggle button.
 *
 * Fetching goes through the plugin's own `/clickvibe/api/fetch` route
 * (no harness RPC — this is a formal bundle plugin, not a dynamic one).
 */
import React from 'react'

// ---- light Markdown renderer (pure JS, no third-party dependency) ----

export const INLINE_RE = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g

export function renderInline(text: string, keyBase: string): React.ReactNode[] {
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

export interface ListState { ordered: boolean; items: string[] }

export function renderMarkdown(md: string): React.ReactNode[] {
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

export function fmtDate(s: string | undefined): string {
  if (!s) return ''
  try { return new Date(s).toLocaleString() } catch { return s }
}
