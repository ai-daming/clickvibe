/** Display helpers for the browser panel. */
import React from 'react'
import { renderMarkdownHtml } from './markdown.ts'

/**
 * Render untrusted issue / comment markdown through the hardened `marked`
 * pipeline (raw HTML escaped, unsafe links sunk to `#`).
 */
export function renderMarkdown(md: string): React.ReactNode {
  // biome-ignore lint/security/noDangerouslySetInnerHtml: output is hardened by renderMarkdownHtml (raw HTML escaped, unsafe links sunk to '#') and asserted in tests/client-markdown.test.ts
  return <div className="cv-md-render" dangerouslySetInnerHTML={{ __html: renderMarkdownHtml(md) }} />
}

export function fmtDate(s: string | undefined): string {
  if (!s) return ''
  try {
    return new Date(s).toLocaleString()
  } catch {
    return s
  }
}
