/** Pure mapping of the shell adapter's reported cause; absent facts never imply success. */
export interface ShellOutcome {
  exitCode: number | null
  signal?: string | null
  timedOut?: boolean
  aborted?: boolean
  timeoutMs?: number
  stdout: { text: string; truncated?: boolean; spillPath?: string }
  stderr?: { text?: string; truncated?: boolean }
}
export type ShellFailureKind = 'timeout' | 'abort' | 'signal' | 'host-shell-failure' | 'command-failure' | 'unknown'

export function classifyShellFailure(result: ShellOutcome): ShellFailureKind {
  if (
    (result.timedOut !== undefined && typeof result.timedOut !== 'boolean') ||
    (result.aborted !== undefined && typeof result.aborted !== 'boolean') ||
    (result.exitCode !== null && !Number.isSafeInteger(result.exitCode)) ||
    (result.signal != null && (typeof result.signal !== 'string' || !/^SIG[A-Z0-9]{1,12}$/.test(result.signal)))
  )
    return 'unknown'

  if (
    (result.timedOut && result.aborted) ||
    (result.exitCode === 0 && (result.timedOut || result.aborted || result.signal))
  )
    return 'unknown'
  if (result.timedOut) return 'timeout'
  if (result.aborted) return 'abort'
  if (result.signal) return 'signal'
  return result.exitCode === null ? 'unknown' : 'command-failure'
}

/** Unknown command output may contain arbitrary secrets; retain availability/size, not guessed-safe text. */
export function safeShellOutput(output: { text?: string; truncated?: boolean } | undefined) {
  return {
    text: '',
    omitted: Boolean(output?.text),
    available: output !== undefined,
    truncated: output?.truncated ?? false,
  }
}

export class ShellCommandError extends Error {
  readonly classification: ShellFailureKind
  readonly failureKey: string
  constructor(operation: string, classification: ShellFailureKind, signal: string | null, exitCode: number | null) {
    super(`Shell ${operation}: ${classification} (exit=${exitCode ?? 'unknown'}, signal=${signal ?? 'unknown'})`)
    this.name = 'ShellCommandError'
    this.classification = classification
    this.failureKey = `${operation}:${classification}:${signal ?? 'none'}:${exitCode ?? 'null'}`
  }
}
