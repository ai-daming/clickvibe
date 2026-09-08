import { recoveryStateRoot } from './recovery-layout.ts'
/** Foreground shell adapter. Cause evidence is captured before callers handle or retry the failure. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { DiagnosticRecord, WorkItemIdentity } from './contracts.ts'
import { appendDiagnosticLine, DEFAULT_DIAGNOSTIC_MAX_BYTES } from './diagnostic-log-store.ts'
import { diagnosticLogPath } from './state-layout.ts'
import { classifyShellFailure, safeShellOutput, ShellCommandError, type ShellOutcome } from './shell-failure.ts'

export interface ShellCommandOptions {
  workdir?: string
  stdin?: string
  signal?: AbortSignal
  timeoutMs?: number
  sandboxPolicy?: { mode: 'read-only' | 'workspace-write' | 'danger-full-access'; workspaceRoot: string }
  diagnostic?: { operation: string; workItem: WorkItemIdentity; root: string; maxBytes?: number }
}

async function recordFailure(
  options: ShellCommandOptions,
  startedAt: number,
  result: ShellOutcome | null,
): Promise<never> {
  const endedAt = Date.now()
  const requested = options.timeoutMs ?? 30_000
  const label = options.diagnostic?.operation ?? 'foreground'
  // Caller labels are stable categories, never full shell commands.
  const operation = /^[a-z][a-z0-9-]{0,63}$/.test(label) ? label : 'foreground'
  const classification = result ? classifyShellFailure(result) : 'host-shell-failure'
  const signal = result?.signal && /^SIG[A-Z0-9]{1,12}$/.test(result.signal) ? result.signal : null
  const error = new ShellCommandError(operation, classification, signal, result?.exitCode ?? null)
  {
    const { root, workItem } = options.diagnostic ?? { root: recoveryStateRoot(), workItem: null }
    const diagnosticId = randomUUID()
    const correlationId = randomUUID()
    const path = join(dirname(diagnosticLogPath(root, workItem)), 'artifacts', `shell-${diagnosticId}.json`)
    const bytes = JSON.stringify({
      operation,
      classification,
      signal,
      exitCode: result?.exitCode ?? null,
      timedOut: result?.timedOut ?? null,
      aborted: result?.aborted ?? null,
      requestedTimeoutMs: requested,
      effectiveTimeoutMs: result?.timeoutMs ?? null,
      startedAt: new Date(startedAt).toISOString(),
      endedAt: new Date(endedAt).toISOString(),
      durationMs: Math.max(0, endedAt - startedAt),
      stdout: safeShellOutput(result?.stdout),
      stderr: safeShellOutput(result?.stderr),
      hostErrorOmitted: result === null,
    })
    const record: DiagnosticRecord = {
      schemaVersion: 1,
      recordType: 'diagnostic',
      diagnosticId,
      correlationId,
      source: 'clickvibe',
      workflow: workItem ? { workItem } : null,
      operation,
      classification,
      message: error.message,
      stack: null,
      occurredAt: new Date(endedAt).toISOString(),
      rawArtifact: {
        kind: 'diagnostic',
        artifactId: diagnosticId,
        path,
        redaction: 'applied',
        contentHash: `sha256-v1_${createHash('sha256').update(bytes).digest('base64url')}`,
      },
    }
    try {
      await appendDiagnosticLine(
        root,
        workItem,
        JSON.stringify(record),
        options.diagnostic?.maxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES,
        {
          generation: 'v0.2',
          artifact: { path, bytes },
        },
      )
    } catch {
      // Safe fallback, never the original command/error/stdout which may contain credentials.
      console.error(`${error.message}; diagnostic persistence failed`)
      error.message += '; diagnostic persistence failed'
      throw error
    }
  }
  throw error
}

export async function runCommand(ctx: Context, command: string, options: ShellCommandOptions = {}): Promise<string> {
  const startedAt = Date.now()
  let result: ShellOutcome
  try {
    const spec = ctx.shell.resolve({
      command,
      workdir: options.workdir,
      stdin: options.stdin,
      timeoutMs: options.timeoutMs ?? 30_000,
      sandboxPolicy: options.sandboxPolicy,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    result = await ctx.shell.run(spec)
  } catch (error) {
    if (options.diagnostic) return recordFailure(options, startedAt, null)
    throw error
  }
  if (result.exitCode !== 0 || result.timedOut || result.aborted || result.signal) {
    if (result.exitCode === null || options.diagnostic || result.timedOut || result.aborted || result.signal)
      return recordFailure(options, startedAt, result)
    const detail = [result.stderr?.text?.trim() ?? '', result.stdout.text.trim()].filter(Boolean).join('\n')
    throw new Error(`命令退出码 ${result.exitCode}${detail ? `: ${detail}` : ''}`)
  }
  if (result.stdout.truncated) {
    if (result.stdout.spillPath) return (await readFile(result.stdout.spillPath, 'utf8')).trim()
    throw new Error('命令输出超过上限且无 spill 文件,无法获取完整输出')
  }
  return result.stdout.text.trim()
}
