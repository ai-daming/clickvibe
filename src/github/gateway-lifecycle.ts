/**
 * Gateway lifecycle stream (issue #131 slice A; ADR-0010 §6/§10).
 *
 * One discriminative event stream per logical request is the ONLY metric
 * source — no parallel counters. Events are emitted at the owner's real
 * decision points (cache hit, join, loader execution, upstream step settle,
 * terminal), and #133's units derive from them:
 *
 *   logical = successful hit + successful join + successful execution
 *             + logical non-success (failed / rate-limited / interrupted)
 *
 * A logical request may settle several upstream steps (pagination); each
 * dispatched step is one upstream request. Rate observations carry the
 * response's real bucket fields and stay null when headers are absent —
 * never a fabricated core bucket (#149 rounds 4-6).
 */

export interface GatewayRateObservation {
  limit: number | null
  remaining: number | null
  reset: number | null
  retryAfterSeconds: number | null
  observedAt: number
}

export type GatewayLifecycleEvent =
  | { kind: 'declared'; requestId: string; scope: 'resource' | 'aggregate' | 'direct'; key: string; at: number }
  | { kind: 'cache-hit'; requestId: string; at: number }
  | { kind: 'joined'; requestId: string; leaderId: string; at: number }
  | { kind: 'dispatched'; requestId: string; step: number; at: number }
  | {
      kind: 'upstream-settled'
      requestId: string
      step: number
      ok: boolean
      rate: GatewayRateObservation | null
      at: number
    }
  | {
      kind: 'terminal'
      requestId: string
      outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted'
      error: string | null
      at: number
    }

export interface GatewayMetrics {
  logicalRequests: number
  cacheHits: number
  singleflightJoins: number
  executions: number
  failures: number
  rateLimited: number
  interrupted: number
  upstreamRequests: number
}

const MAX_EVENTS = 2000

/** Bounded in-memory recorder owned by the Gateway owner; sealed by close(). */
export class GatewayLifecycleRecorder {
  private events: GatewayLifecycleEvent[] = []
  private closed = false

  emit(event: GatewayLifecycleEvent): void {
    if (this.closed) return
    this.events.push(event)
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS)
  }

  snapshot(): GatewayLifecycleEvent[] {
    return [...this.events]
  }

  seal(): void {
    this.closed = true
  }

  get sealed(): boolean {
    return this.closed
  }
}

/** Derive the #133 units from the stream (pure). */
export function deriveGatewayMetrics(events: GatewayLifecycleEvent[]): GatewayMetrics {
  const declared = new Set<string>()
  const hit = new Set<string>()
  const joined = new Set<string>()
  const settledOwn = new Set<string>()
  const terminals = new Map<string, Extract<GatewayLifecycleEvent, { kind: 'terminal' }>>()
  let upstreamRequests = 0

  for (const event of events) {
    switch (event.kind) {
      case 'declared':
        declared.add(event.requestId)
        break
      case 'cache-hit':
        hit.add(event.requestId)
        break
      case 'joined':
        joined.add(event.requestId)
        break
      case 'dispatched':
        break
      case 'upstream-settled':
        upstreamRequests += 1
        settledOwn.add(event.requestId)
        break
      case 'terminal':
        terminals.set(event.requestId, event)
        break
    }
  }

  let cacheHits = 0
  let singleflightJoins = 0
  let executions = 0
  let failures = 0
  let rateLimited = 0
  let interrupted = 0
  for (const requestId of declared) {
    const terminal = terminals.get(requestId)
    // Non-success terminals partition into their own buckets first — a failed
    // upstream execution is a failure, never a successful execution.
    if (terminal && terminal.outcome !== 'succeeded') {
      if (terminal.outcome === 'rate-limited') rateLimited += 1
      else if (terminal.outcome === 'interrupted') interrupted += 1
      else failures += 1
      continue
    }
    if (hit.has(requestId)) {
      cacheHits += 1
      continue
    }
    if (joined.has(requestId)) {
      singleflightJoins += 1
      continue
    }
    if (settledOwn.has(requestId)) {
      executions += 1
      continue
    }
    interrupted += 1
  }
  return {
    logicalRequests: declared.size,
    cacheHits,
    singleflightJoins,
    executions,
    failures,
    rateLimited,
    interrupted,
    upstreamRequests,
  }
}
