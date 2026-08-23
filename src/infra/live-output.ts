import type { AgentKind } from './contracts.ts'

// Client decoding is intentionally browser-local; runtime-contract.test.ts
// locks this wire contract to src/client/runtime.ts without crossing bundles.

export type LiveLogKind =
  | 'system'
  | 'stage'
  | 'command'
  | 'command_output'
  | 'reasoning'
  | 'tool'
  | 'thinking'
  | 'message'
  | 'text'
  | 'usage'

export interface TokenUsage {
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  totalTokens?: number
}

export interface LiveLogEvent {
  source: 'system' | 'agent'
  agent?: AgentKind
  kind: LiveLogKind
  text: string
  usage?: TokenUsage
}

const EVENT_PREFIX = '[clickvibe:event]'

function finiteToken(value: unknown): number | undefined {
  const number = Number(value)
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : undefined
}

export function tokenUsage(value: unknown): TokenUsage | undefined {
  if (!value || typeof value !== 'object') return undefined
  const record = value as Record<string, unknown>
  const nested = record.total_token_usage ?? record.totalTokenUsage ?? record.last_token_usage ?? record.lastTokenUsage
  if (nested && nested !== value) {
    const parsed = tokenUsage(nested)
    if (parsed) return parsed
  }
  const inputTokens = finiteToken(record.input_tokens ?? record.inputTokens)
  const cachedInputTokens = finiteToken(
    record.cached_input_tokens ?? record.cache_read_input_tokens ?? record.cachedInputTokens,
  )
  const outputTokens = finiteToken(record.output_tokens ?? record.outputTokens)
  const explicitTotal = finiteToken(record.total_tokens ?? record.totalTokens)
  const totalTokens =
    explicitTotal ??
    (inputTokens !== undefined || outputTokens !== undefined ? (inputTokens ?? 0) + (outputTokens ?? 0) : undefined)
  if (
    inputTokens === undefined &&
    cachedInputTokens === undefined &&
    outputTokens === undefined &&
    totalTokens === undefined
  )
    return undefined
  return { inputTokens, cachedInputTokens, outputTokens, totalTokens }
}

/** Durable wire format. Percent encoding keeps agent JSON out of verdict regexes. */
export function encodeLiveLogEvent(event: LiveLogEvent): string {
  return `${EVENT_PREFIX}${encodeURIComponent(JSON.stringify(event))}`
}

/** Read new structured records and legacy plain-text logs without migration. */
export function decodeLiveLogLine(line: string): LiveLogEvent {
  if (line.startsWith(EVENT_PREFIX)) {
    try {
      const value = JSON.parse(decodeURIComponent(line.slice(EVENT_PREFIX.length))) as LiveLogEvent
      if ((value.source === 'system' || value.source === 'agent') && typeof value.text === 'string') return value
    } catch {
      // Corrupt records remain visible as plain text instead of breaking history.
    }
  }
  return line.startsWith('[clickvibe]')
    ? { source: 'system', kind: 'system', text: line }
    : { source: 'agent', kind: 'text', text: line }
}

export function formatElapsed(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const remainder = seconds % 60
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
}

export function taskStartedAt(taskId: string | null): number | null {
  const matched = taskId?.match(/^[a-z]+-(\d+)-/)
  if (!matched) return null
  const value = Number(matched[1])
  return Number.isSafeInteger(value) ? value : null
}

/** Latest usage event is authoritative; absent usage is intentionally hidden. */
export function latestTokenUsage(events: LiveLogEvent[]): TokenUsage | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    if (events[index].usage) return events[index].usage
  }
  return undefined
}
