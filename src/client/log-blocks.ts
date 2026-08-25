import type { LiveLogEvent, LiveLogKind } from './runtime.ts'

export const COLLAPSED_LOG_LINE_THRESHOLD = 20
export const COLLAPSED_LOG_CHARACTER_THRESHOLD = 2_000
const COLLAPSED_LOG_PREVIEW_LINES = 8
const COLLAPSED_LOG_PREVIEW_CHARACTERS = 800

export interface LogBlock {
  id: string
  source: LiveLogEvent['source']
  agent?: LiveLogEvent['agent']
  kind: Exclude<LiveLogKind, 'usage'>
  text: string
  eventCount: number
}

export interface CollapsedLogBlock {
  collapsible: boolean
  text: string
  fullText: string
  lineCount: number
}

export interface NumberedLogLine {
  number: number
  text: string
}

function appendCommandOutput(current: string, next: string): string {
  if (current === '' || next === '' || current.endsWith('\n') || next.startsWith('\n')) return current + next
  return `${current}\n${next}`
}

/** Build body-only presentation blocks without mutating the durable event list. */
export function buildLogBlocks(events: readonly LiveLogEvent[]): LogBlock[] {
  const blocks: LogBlock[] = []
  for (const [index, event] of events.entries()) {
    if (event.kind === 'usage') continue
    const previous = blocks.at(-1)
    if (event.kind === 'command_output' && previous?.kind === 'command_output') {
      previous.text = appendCommandOutput(previous.text, event.text)
      previous.eventCount += 1
      continue
    }
    blocks.push({
      id: `log-${index}-${event.kind}`,
      source: event.source,
      agent: event.agent,
      kind: event.kind,
      text: event.text,
      eventCount: 1,
    })
  }
  return blocks
}

function logicalLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

/** Split display text into addressable lines without treating a trailing newline as new content. */
export function numberLogLines(text: string, startNumber: number): NumberedLogLine[] {
  const lines = logicalLines(text)
  if (lines.length === 0) return [{ number: startNumber, text: '' }]
  return lines.map((line, index) => ({ number: startNumber + index, text: line }))
}

function previewLines(lines: readonly string[]): string {
  const preview: string[] = []
  for (const line of lines.slice(0, COLLAPSED_LOG_PREVIEW_LINES)) {
    const candidateLength = preview.reduce((total, value) => total + value.length, 0) + preview.length + line.length
    if (preview.length > 0 && candidateLength > COLLAPSED_LOG_PREVIEW_CHARACTERS) break
    preview.push(line)
  }
  return preview.join('\n')
}

/** Decide presentation only; fullText always retains the exact supplied text. */
export function collapseLogBlock(text: string): CollapsedLogBlock {
  const lines = logicalLines(text)
  const collapsible = lines.length > COLLAPSED_LOG_LINE_THRESHOLD || text.length > COLLAPSED_LOG_CHARACTER_THRESHOLD
  return {
    collapsible,
    text: collapsible ? previewLines(lines) : text,
    fullText: text,
    lineCount: lines.length,
  }
}

export function toggleExpandedLogBlock(current: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  return next
}
