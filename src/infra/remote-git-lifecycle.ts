/** Remote Git lifecycle is the sole metric source for ADR-0011/#133. */

export interface RemoteGitScope {
  repoKey: string
  repositoryId?: string | null
  remote: string
}

export type RemoteGitOperation = 'fetch' | 'push' | 'push-recovery' | 'ls-remote'
export type RemoteGitTerminalOutcome = 'confirmed' | 'failed' | 'unknown' | 'interrupted'

export type RemoteGitLifecycleEvent =
  | { kind: 'declared'; requestId: string; scope: RemoteGitScope; operation: RemoteGitOperation; at: number }
  | { kind: 'joined'; requestId: string; leaderId: string; flightId: string; at: number }
  | { kind: 'queued'; requestId: string; flightId: string; at: number }
  | {
      kind: 'dispatched'
      requestId: string
      flightId: string
      operation: 'fetch' | 'push' | 'ls-remote'
      waitedMs: number
      at: number
    }
  | {
      kind: 'subprocess-settled'
      requestId: string
      flightId: string
      phase: 'fetch' | 'push' | 'readback'
      upstream: boolean
      ok: boolean
      serviceMs: number
      error: string | null
      at: number
    }
  | { kind: 'invalidated'; requestId: string; flightId: string; repoKey: string; at: number }
  | { kind: 'readback-settled'; requestId: string; flightId: string; confirmed: boolean; at: number }
  | {
      kind: 'terminal'
      requestId: string
      flightId: string
      outcome: RemoteGitTerminalOutcome
      error: string | null
      at: number
    }
  | {
      kind: 'late-result'
      requestId: string
      flightId: string
      outcome: RemoteGitTerminalOutcome
      error: string | null
      at: number
    }

export interface RemoteGitMetrics {
  logicalRequests: number
  singleflightJoins: number
  executions: number
  upstreamRequests: number
  failures: number
  unknowns: number
  interrupted: number
  invalidations: number
  writeReadbacks: number
  waitMsTotal: number
  serviceMsTotal: number
}

export interface RemoteGitEvidenceSink {
  write(event: RemoteGitLifecycleEvent): void
  flush(): Promise<void>
}

export function deriveRemoteGitMetrics(events: RemoteGitLifecycleEvent[]): RemoteGitMetrics {
  const requests = new Set<string>()
  const joined = new Set<string>()
  const executions = new Set<string>()
  const terminals = new Map<string, Extract<RemoteGitLifecycleEvent, { kind: 'terminal' }>>()
  let upstreamRequests = 0
  let invalidations = 0
  let writeReadbacks = 0
  let waitMsTotal = 0
  let serviceMsTotal = 0
  for (const event of events) {
    switch (event.kind) {
      case 'declared':
        requests.add(event.requestId)
        break
      case 'joined':
        joined.add(event.requestId)
        break
      case 'queued':
        break
      case 'dispatched':
        executions.add(event.flightId)
        waitMsTotal += event.waitedMs
        break
      case 'subprocess-settled':
        if (event.upstream) upstreamRequests += 1
        serviceMsTotal += event.serviceMs
        break
      case 'invalidated':
        invalidations += 1
        break
      case 'readback-settled':
        writeReadbacks += 1
        break
      case 'terminal':
        terminals.set(event.requestId, event)
        break
      case 'late-result':
        break
    }
  }
  let failures = 0
  let unknowns = 0
  let interrupted = 0
  for (const terminal of terminals.values()) {
    if (terminal.outcome === 'failed') failures += 1
    else if (terminal.outcome === 'unknown') unknowns += 1
    else if (terminal.outcome === 'interrupted') interrupted += 1
  }
  return {
    logicalRequests: requests.size,
    singleflightJoins: joined.size,
    executions: executions.size,
    upstreamRequests,
    failures,
    unknowns,
    interrupted,
    invalidations,
    writeReadbacks,
    waitMsTotal,
    serviceMsTotal,
  }
}
