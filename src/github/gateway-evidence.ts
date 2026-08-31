/**
 * Production evidence sink for the Gateway owner (issue #131 review r5/F3;
 * ADR-0010 §10 — "evidence writer 是 owner 的组成部分").
 *
 * Lifecycle events buffer in memory and land in the shared diagnostics stream
 * as JSONL; `flush()` is awaitable and drains the write queue, which is what
 * `close()` waits on after the final terminal. Losing the tail buffer on a
 * process crash is the ADR's accepted failure mode — write attempts and
 * workflow business state are persisted independently.
 */

import {
  appendDiagnosticLine,
  DEFAULT_DIAGNOSTIC_MAX_BYTES,
  waitForDiagnosticLines,
} from '../infra/diagnostic-log-store.ts'
import { loadConfig } from '../infra/runtime.ts'
import { stateDir } from '../infra/state.ts'
import type { GatewayEvidenceSink } from './gateway-lifecycle.ts'
import type { GatewayLifecycleEvent } from './gateway-lifecycle.ts'

/** One dedicated diagnostics stream for gateway lifecycle evidence. */
const GATEWAY_EVIDENCE_KEY = 'github-gateway'

/** Match the recorder's bound: the sink never buffers more than the stream kept. */
const MAX_BUFFERED_LINES = 2000

export function createDiagnosticEvidenceSink(): GatewayEvidenceSink {
  let buffer: string[] = []
  const maxBytes = () =>
    loadConfig()
      .then((config) => config.diagnosticsMaxBytes ?? DEFAULT_DIAGNOSTIC_MAX_BYTES)
      .catch(() => DEFAULT_DIAGNOSTIC_MAX_BYTES)
  return {
    write(event: GatewayLifecycleEvent): void {
      buffer.push(JSON.stringify({ event: 'github-gateway-lifecycle', ...event, at: new Date(event.at).toISOString() }))
      if (buffer.length > MAX_BUFFERED_LINES) buffer.splice(0, buffer.length - MAX_BUFFERED_LINES)
    },
    async flush(): Promise<void> {
      if (buffer.length === 0) {
        await waitForDiagnosticLines(stateDir(), GATEWAY_EVIDENCE_KEY)
        return
      }
      const lines = buffer
      buffer = []
      for (const line of lines) {
        await appendDiagnosticLine(stateDir(), GATEWAY_EVIDENCE_KEY, line, maxBytes()).catch(() => undefined)
      }
      await waitForDiagnosticLines(stateDir(), GATEWAY_EVIDENCE_KEY)
    },
  }
}
