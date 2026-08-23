/**
 * Markdown rendering for the panel: a thin, hardened wrapper over `marked`.
 *
 * The panel hands the rendered HTML to React through dangerouslySetInnerHTML,
 * so anything originating in the source text must be neutralised before it can
 * reach the DOM: raw HTML tokens are emitted as escaped plain text, and only
 * http(s)/mailto links survive as real anchors (everything else sinks to `#`).
 */
import { marked } from 'marked'

const SAFE_LINK_RE = /^(https?:\/\/|mailto:)/i

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case '&':
        return '&amp;'
      case '<':
        return '&lt;'
      case '>':
        return '&gt;'
      case '"':
        return '&quot;'
      default:
        return '&#39;'
    }
  })
}

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    html(token) {
      return escapeHtml(token.text)
    },
    link(token) {
      const href = SAFE_LINK_RE.test(token.href) ? token.href : '#'
      const title = token.title ? ' title="' + escapeHtml(token.title) + '"' : ''
      const label = this.parser.parseInline(token.tokens)
      return '<a href="' + escapeHtml(href) + '"' + title + '>' + label + '</a>'
    },
  },
})

export function renderMarkdownHtml(md: string): string {
  return marked.parse(String(md ?? '')) as string
}
