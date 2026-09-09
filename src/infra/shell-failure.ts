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

// Only fixed Git/system phrases can leave this function. Never copy a captured path, argument or prefix.
const gitOutputOperations = new Set([
  'worktree-add',
  'worktree-attach',
  'worktree-repair',
  'worktree-common-dir',
  'worktree-default-base',
  'worktree-main-exists',
  'worktree-base-exists',
  'worktree-base-oid',
  'worktree-branch-exists',
  'worktree-branch-head',
  'worktree-head',
  'worktree-hooks',
  'worktree-list',
  'worktree-status',
])
const gitOutputLines = new Set([
  'fatal: not a git repository (or any of the parent directories): .git',
  'fatal: this operation must be run in a work tree',
  'fatal: not a valid object name: HEAD',
])
const systemReasons = [
  'No space left on device',
  'Permission denied',
  'Read-only file system',
  'No such file or directory',
  'Too many open files',
  'Input/output error',
]

/** Allowlist fragments from the last 4 KiB; all other output (including localized errors) is omitted. */
export function safeShellOutput(output: { text?: string; truncated?: boolean } | undefined, operation = '') {
  const original = typeof output?.text === 'string' ? output.text : ''
  const bytes = new TextEncoder().encode(original)
  const clipped = bytes.length > 4096
  let tail = new TextDecoder().decode(bytes.subarray(Math.max(0, bytes.length - 4096)))
  // A clipped first line is never a complete diagnostic statement, even if its suffix looks safe.
  if (clipped) tail = tail.includes('\n') ? tail.slice(tail.indexOf('\n') + 1) : ''
  const retained: string[] = []
  if (gitOutputOperations.has(operation)) {
    for (const line of tail.split(/\r?\n/)) {
      if (gitOutputLines.has(line)) retained.push(line)
      else if (
        /^(fatal|error): /.test(line) &&
        ![...line].some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)
      ) {
        const reason = systemReasons.find((reason) => line.endsWith(`: ${reason}`))
        if (reason) retained.push(`${line.startsWith('fatal:') ? 'fatal' : 'error'}: [details omitted]: ${reason}`)
      }
    }
  }
  // Generated phrases are ASCII; cap again because replacing a short prefix can expand a line.
  let text = retained.join('\n')
  const expanded = text.length > 4096
  while (text.length > 4096) text = text.slice(text.indexOf('\n') + 1)
  return {
    text,
    omitted: Boolean(original && (clipped || text !== original.replace(/\r\n/g, '\n').trimEnd())),
    available: output !== undefined,
    truncated: output?.truncated === true || clipped || expanded,
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
