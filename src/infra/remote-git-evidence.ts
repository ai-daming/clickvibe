/** Production lifecycle sink for the Remote Git Coordinator (ADR-0011 §8). */

import { appendDiagnosticLine, DEFAULT_DIAGNOSTIC_MAX_BYTES, waitForDiagnosticLines } from './diagnostic-log-store.ts'
import {
  deriveRemoteGitMetrics,
  type RemoteGitEvidenceSink,
  type RemoteGitLifecycleEvent,
} from './remote-git-lifecycle.ts'
import { stateDir } from './state.ts'
import { logTaskDiagnostic } from './task-diagnostics.ts'

const EVIDENCE_KEY = 'remote-git-coordinator'
const MAX_BUFFERED_LINES = 2000
const FLUSH_DEBOUNCE_MS = 1_000

export function createRemoteGitEvidenceSink(): RemoteGitEvidenceSink {
  const directory = stateDir()
  let lines: string[] = []
  let events: RemoteGitLifecycleEvent[] = []
  let debounceTimer: NodeJS.Timeout | null = null
  let pending: Promise<void> = Promise.resolve()

  const maxBytes = async (): Promise<number> => {
    try {
      const { loadConfig } = await import('./runtime.ts')
      return (await loadConfig()).diagnosticsMaxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES
    } catch {
      return DEFAULT_DIAGNOSTIC_MAX_BYTES
    }
  }

  const append = async (line: string, budget: number): Promise<void> => {
    try {
      await appendDiagnosticLine(directory, EVIDENCE_KEY, line, budget)
    } catch (error) {
      logTaskDiagnostic('remote-git-evidence-write-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const drain = async (): Promise<void> => {
    const budget = await maxBytes()
    const outgoing = lines
    lines = []
    for (const line of outgoing) await append(line, budget)
    const terminated = new Set(events.filter((event) => event.kind === 'terminal').map((event) => event.requestId))
    const closed = events.filter((event) => terminated.has(event.requestId))
    events = events.filter((event) => !terminated.has(event.requestId))
    if (closed.length > 0) {
      await append(
        JSON.stringify({
          event: 'remote-git-metrics',
          ...deriveRemoteGitMetrics(closed),
          at: new Date().toISOString(),
        }),
        budget,
      )
    }
    await waitForDiagnosticLines(directory, EVIDENCE_KEY).catch((error: unknown) => {
      logTaskDiagnostic('remote-git-evidence-write-failed', {
        stage: 'await-drained',
        error: error instanceof Error ? error.message : String(error),
      })
    })
  }

  const schedule = (): void => {
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      pending = pending.then(drain).catch(() => undefined)
    }, FLUSH_DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  return {
    write(event): void {
      lines.push(JSON.stringify({ event: 'remote-git-lifecycle', ...event, at: new Date(event.at).toISOString() }))
      events.push(event)
      if (lines.length > MAX_BUFFERED_LINES) lines.splice(0, lines.length - MAX_BUFFERED_LINES)
      if (events.length > MAX_BUFFERED_LINES) events.splice(0, events.length - MAX_BUFFERED_LINES)
      schedule()
    },
    async flush(): Promise<void> {
      if (debounceTimer) {
        clearTimeout(debounceTimer)
        debounceTimer = null
      }
      await pending
      pending = drain()
      await pending
    },
  }
}
