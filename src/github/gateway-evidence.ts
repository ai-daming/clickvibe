/**
 * Production evidence sink for the Gateway owner (issue #131 review r6/F3;
 * ADR-0010 §10 — "evidence writer 是 owner 的组成部分").
 *
 * Lifecycle events land in the shared diagnostics stream as JSONL. Three
 * production requirements (review r6):
 * - durability does not depend on close()/flush(): writes debounce to disk on
 *   their own, so a crash loses at most the debounce window, not the tail;
 * - write errors are surfaced through the observable diagnostics channel,
 *   never swallowed (错误不埋葬);
 * - every flush also emits a derived #133 metrics summary — the production
 *   threshold consumer of the lifecycle stream.
 */

import {
  appendDiagnosticLine,
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  waitForDiagnosticLines,
} from '../infra/diagnostic-log-store.ts'
import { logTaskDiagnostic } from '../infra/task-diagnostics.ts'
import { loadConfig } from '../infra/runtime.ts'
import { stateDir } from '../infra/state.ts'
import { deriveGatewayMetrics, type GatewayLifecycleEvent } from './gateway-lifecycle.ts'
import type { GatewayEvidenceSink } from './gateway-lifecycle.ts'

/** Namespace for gateway evidence lines in the shared diagnostics stream —
 * a plain-string key routes to the global diagnostics.jsonl by design. */
const GATEWAY_EVIDENCE_KEY = 'github-gateway'

/** Match the recorder's bound: the sink never buffers more than the stream kept. */
const MAX_BUFFERED_LINES = 2000

/** Production flush cadence — the crash window is bounded, not the whole tail. */
const FLUSH_DEBOUNCE_MS = 1_000

export function createDiagnosticEvidenceSink(): GatewayEvidenceSink {
  let lines: string[] = []
  let events: GatewayLifecycleEvent[] = []
  let debounceTimer: NodeJS.Timeout | null = null
  let pending: Promise<void> = Promise.resolve()

  const maxBytes = () =>
    loadConfig()
      .then((config) => config.diagnosticsMaxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES)
      .catch(() => DEFAULT_DIAGNOSTIC_MAX_BYTES)

  const append = async (line: string, budget: number) => {
    try {
      await appendDiagnosticLine(stateDir(), GATEWAY_EVIDENCE_KEY, line, budget)
    } catch (error) {
      // The evidence stream itself failed — record it in the standard
      // diagnostics channel instead of dropping it silently.
      logTaskDiagnostic('github-gateway-evidence-write-failed', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const drain = async (): Promise<void> => {
    const budget = await maxBytes()
    const outgoing = lines
    lines = []
    for (const line of outgoing) await append(line, budget)
    // The production #133 threshold consumer: each flush publishes the
    // derived metrics of everything written so far.
    if (events.length > 0) {
      const metrics = deriveGatewayMetrics(events)
      await append(
        JSON.stringify({ event: 'github-gateway-metrics', ...metrics, at: new Date().toISOString() }),
        budget,
      )
      events = []
    }
    await waitForDiagnosticLines(stateDir(), GATEWAY_EVIDENCE_KEY).catch((error: unknown) => {
      logTaskDiagnostic('github-gateway-evidence-write-failed', {
        error: error instanceof Error ? error.message : String(error),
        stage: 'await-drained',
      })
    })
  }

  const schedule = () => {
    if (debounceTimer) return
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      pending = pending.then(drain).catch(() => undefined)
    }, FLUSH_DEBOUNCE_MS)
    debounceTimer.unref?.()
  }

  return {
    write(event: GatewayLifecycleEvent): void {
      lines.push(JSON.stringify({ event: 'github-gateway-lifecycle', ...event, at: new Date(event.at).toISOString() }))
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
