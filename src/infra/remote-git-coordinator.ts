/** Per-(repoKey, remote) Remote Git coordinator (issue #135, ADR-0011). */

import { randomUUID } from 'node:crypto'
import {
  deriveRemoteGitMetrics,
  type RemoteGitEvidenceSink,
  type RemoteGitLifecycleEvent,
  type RemoteGitScope,
  type RemoteGitTerminalOutcome,
} from './remote-git-lifecycle.ts'
import {
  ensureRemoteGitFreshness,
  type RemoteGitFreshness,
  type RemoteGitFreshnessEntry,
} from './remote-git-freshness.ts'
import type { RemoteGitOutcome, RemoteGitWriteAttempt } from './remote-git-contracts.ts'
import { type RemoteGitDeleteInput, runDeleteRemoteBranchIfPresent } from './remote-git-delete.ts'

export { deriveRemoteGitMetrics }
export type { RemoteGitLifecycleEvent, RemoteGitMetrics, RemoteGitScope } from './remote-git-lifecycle.ts'
export type { RemoteGitOutcome, RemoteGitWriteAttempt } from './remote-git-contracts.ts'

export type { RemoteGitFreshness } from './remote-git-freshness.ts'

interface QueueEntry<T> {
  requestId: string
  flightId: string
  queuedAt: number
  run(): Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
  timer: ReturnType<typeof setTimeout>
}

interface FetchFlight {
  leaderId: string
  flightId: string
  promise: Promise<RemoteGitOutcome>
}

interface ScopeOwner {
  queue: Array<QueueEntry<unknown>>
  running: Promise<void> | null
  active?: QueueEntry<unknown>
  fetchFlights: Map<string, FetchFlight>
  lsRemoteFlights: Map<string, FetchFlight>
  freshness?: RemoteGitFreshnessEntry
}

export class RemoteGitQueueTimeoutError extends Error {
  constructor() {
    super('Remote Git 排队超过 120s 上限，结果 unknown')
    this.name = 'RemoteGitQueueTimeoutError'
  }
}

export class RemoteGitClosedError extends Error {
  constructor() {
    super('Remote Git Coordinator 已关闭')
    this.name = 'RemoteGitClosedError'
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const scopeKey = (scope: RemoteGitScope): string => JSON.stringify([scope.repoKey, scope.remote])

export function createRemoteGitCoordinator(
  options: { queueTimeoutMs?: number; closeWaitMs?: number; now?: () => number; sink?: RemoteGitEvidenceSink } = {},
) {
  const queueTimeoutMs = options.queueTimeoutMs ?? 120_000
  const closeWaitMs = options.closeWaitMs ?? 2_000
  const now = options.now ?? Date.now
  const owners = new Map<string, ScopeOwner>()
  const events: RemoteGitLifecycleEvent[] = []
  const openRequests = new Map<string, string>()
  const terminalRequests = new Set<string>()
  let closed = false

  const emit = (event: RemoteGitLifecycleEvent) => {
    events.push(event)
    if (events.length > 2_000) events.splice(0, events.length - 2_000)
    if (event.kind === 'declared') openRequests.set(event.requestId, '')
    if (event.kind === 'queued' || event.kind === 'dispatched') openRequests.set(event.requestId, event.flightId)
    options.sink?.write(event)
  }

  const assertOpen = (): void => {
    if (closed) throw new RemoteGitClosedError()
  }

  const ownerFor = (scope: RemoteGitScope): ScopeOwner => {
    const key = scopeKey(scope)
    let owner = owners.get(key)
    if (!owner) {
      owner = { queue: [], running: null, fetchFlights: new Map(), lsRemoteFlights: new Map() }
      owners.set(key, owner)
    }
    return owner
  }

  const drain = (owner: ScopeOwner): void => {
    if (owner.running || owner.queue.length === 0) return
    const entry = owner.queue.shift()
    if (!entry) return
    clearTimeout(entry.timer)
    owner.active = entry
    const running = entry
      .run()
      .then(entry.resolve, entry.reject)
      .finally(() => {
        delete owner.active
        owner.running = null
        drain(owner)
      })
    owner.running = running.then(
      () => undefined,
      () => undefined,
    )
  }

  const enqueue = <T>(
    scope: RemoteGitScope,
    requestId: string,
    flightId: string,
    run: () => Promise<T>,
  ): Promise<T> => {
    if (closed) return Promise.reject(new RemoteGitClosedError())
    const owner = ownerFor(scope)
    emit({ kind: 'queued', requestId, flightId, at: now() })
    return new Promise<T>((resolve, reject) => {
      const entry = {} as QueueEntry<T>
      Object.assign(entry, {
        requestId,
        flightId,
        queuedAt: now(),
        run,
        resolve,
        reject,
        timer: setTimeout(() => {
          const index = owner.queue.indexOf(entry as QueueEntry<unknown>)
          if (index < 0) return
          owner.queue.splice(index, 1)
          reject(new RemoteGitQueueTimeoutError())
        }, queueTimeoutMs),
      })
      entry.timer.unref?.()
      owner.queue.push(entry as QueueEntry<unknown>)
      drain(owner)
    })
  }

  const terminal = (
    requestId: string,
    flightId: string,
    outcome: RemoteGitTerminalOutcome,
    error?: unknown,
    attemptId?: string,
  ) => {
    const event = {
      requestId,
      flightId,
      ...(attemptId ? { attemptId } : {}),
      outcome,
      error: error === undefined ? null : errorText(error),
      at: now(),
    }
    if (terminalRequests.has(requestId)) {
      emit({ kind: 'late-result', ...event })
      return
    }
    terminalRequests.add(requestId)
    openRequests.delete(requestId)
    emit({ kind: 'terminal', ...event })
  }

  const noteSubprocess = (
    requestId: string,
    flightId: string,
    phase: 'fetch' | 'pre-read' | 'push' | 'readback',
    startedAt: number,
    error?: unknown,
    attemptId?: string,
  ) => {
    emit({
      kind: 'subprocess-settled',
      requestId,
      flightId,
      phase,
      ...(attemptId ? { attemptId } : {}),
      upstream: true,
      ok: error === undefined,
      serviceMs: Math.max(0, now() - startedAt),
      error: error === undefined ? null : errorText(error),
      at: now(),
    })
  }

  const fetch = async (input: {
    scope: RemoteGitScope
    prune: boolean
    execute(): Promise<string>
    invalidate(): void
    readback(): Promise<string>
  }): Promise<RemoteGitOutcome> => {
    assertOpen()
    const requestId = randomUUID()
    const owner = ownerFor(input.scope)
    emit({ kind: 'declared', requestId, scope: input.scope, operation: 'fetch', at: now() })
    const key = input.prune ? 'prune' : 'plain'
    const existing = owner.fetchFlights.get(key)
    if (existing) {
      emit({ kind: 'joined', requestId, leaderId: existing.leaderId, flightId: existing.flightId, at: now() })
      const outcome = await existing.promise
      terminal(requestId, outcome.flightId, outcome.outcome, outcome.error)
      return outcome
    }
    const flightId = randomUUID()
    const queuedAt = now()
    const promise = enqueue(input.scope, requestId, flightId, async (): Promise<RemoteGitOutcome> => {
      emit({ kind: 'dispatched', requestId, flightId, operation: 'fetch', waitedMs: now() - queuedAt, at: now() })
      const startedAt = now()
      let output: string | undefined
      let commandError: unknown
      try {
        output = await input.execute()
      } catch (error) {
        commandError = error
      }
      noteSubprocess(requestId, flightId, 'fetch', startedAt, commandError)
      input.invalidate()
      emit({ kind: 'invalidated', requestId, flightId, repoKey: input.scope.repoKey, at: now() })
      try {
        const readback = await input.readback()
        if (commandError !== undefined) {
          return { outcome: 'unknown', flightId, output, readback, error: errorText(commandError) }
        }
        return { outcome: 'confirmed', flightId, output, readback }
      } catch (error) {
        return { outcome: 'unknown', flightId, output, error: errorText(error) }
      }
    }).catch(
      (error): RemoteGitOutcome => ({
        outcome: error instanceof RemoteGitClosedError ? 'interrupted' : 'unknown',
        flightId,
        error: errorText(error),
      }),
    )
    owner.fetchFlights.set(key, { leaderId: requestId, flightId, promise })
    try {
      const outcome = await promise
      terminal(requestId, flightId, outcome.outcome, outcome.error)
      return outcome
    } finally {
      if (owner.fetchFlights.get(key)?.flightId === flightId) owner.fetchFlights.delete(key)
    }
  }

  const lsRemote = async (input: {
    scope: RemoteGitScope
    query: string
    execute(): Promise<string>
  }): Promise<RemoteGitOutcome> => {
    assertOpen()
    const requestId = randomUUID()
    const owner = ownerFor(input.scope)
    emit({ kind: 'declared', requestId, scope: input.scope, operation: 'ls-remote', at: now() })
    const existing = owner.lsRemoteFlights.get(input.query)
    if (existing) {
      emit({ kind: 'joined', requestId, leaderId: existing.leaderId, flightId: existing.flightId, at: now() })
      const outcome = await existing.promise
      terminal(requestId, outcome.flightId, outcome.outcome, outcome.error)
      return outcome
    }
    const flightId = randomUUID()
    const promise = (async (): Promise<RemoteGitOutcome> => {
      emit({ kind: 'dispatched', requestId, flightId, operation: 'ls-remote', waitedMs: 0, at: now() })
      const startedAt = now()
      try {
        const output = await input.execute()
        noteSubprocess(requestId, flightId, 'readback', startedAt)
        return { outcome: 'confirmed', flightId, output }
      } catch (error) {
        noteSubprocess(requestId, flightId, 'readback', startedAt, error)
        return { outcome: 'unknown', flightId, error: errorText(error) }
      }
    })()
    owner.lsRemoteFlights.set(input.query, { leaderId: requestId, flightId, promise })
    try {
      const outcome = await promise
      terminal(requestId, flightId, outcome.outcome, outcome.error)
      return outcome
    } finally {
      if (owner.lsRemoteFlights.get(input.query)?.flightId === flightId) owner.lsRemoteFlights.delete(input.query)
    }
  }

  const push = async (input: {
    scope: RemoteGitScope
    validate(): Promise<RemoteGitWriteAttempt>
    persistAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
    execute(attempt: RemoteGitWriteAttempt): Promise<string>
    invalidate(): void
    readback(attempt: RemoteGitWriteAttempt): Promise<string | null>
    settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  }): Promise<RemoteGitOutcome> => {
    assertOpen()
    const requestId = randomUUID()
    const flightId = randomUUID()
    const queuedAt = now()
    emit({ kind: 'declared', requestId, scope: input.scope, operation: 'push', at: now() })
    const outcome = await enqueue(input.scope, requestId, flightId, async (): Promise<RemoteGitOutcome> => {
      let attempt: RemoteGitWriteAttempt
      try {
        attempt = await input.validate()
        await input.persistAttempt(attempt)
      } catch (error) {
        return { outcome: 'failed', flightId, error: errorText(error) }
      }
      emit({
        kind: 'dispatched',
        requestId,
        flightId,
        operation: 'push',
        attemptId: attempt.attemptId,
        waitedMs: now() - queuedAt,
        at: now(),
      })
      const pushStartedAt = now()
      let output: string | undefined
      let commandError: unknown
      try {
        output = await input.execute(attempt)
      } catch (error) {
        commandError = error
      }
      noteSubprocess(requestId, flightId, 'push', pushStartedAt, commandError, attempt.attemptId)
      input.invalidate()
      emit({
        kind: 'invalidated',
        requestId,
        flightId,
        attemptId: attempt.attemptId,
        repoKey: input.scope.repoKey,
        at: now(),
      })
      let readback: string | null = null
      let readbackError: unknown
      const readbackStartedAt = now()
      try {
        readback = await input.readback(attempt)
      } catch (error) {
        readbackError = error
      }
      noteSubprocess(requestId, flightId, 'readback', readbackStartedAt, readbackError, attempt.attemptId)
      const confirmed = readbackError === undefined && readback === attempt.expectedOid
      emit({ kind: 'readback-settled', requestId, flightId, attemptId: attempt.attemptId, confirmed, at: now() })
      const settled: RemoteGitWriteAttempt = {
        ...attempt,
        status: confirmed ? 'confirmed' : 'unknown',
        ...(confirmed
          ? {}
          : { diagnosticRef: errorText(readbackError ?? commandError ?? `readback=${readback ?? '<missing>'}`) }),
      }
      try {
        await input.settleAttempt(settled)
      } catch (error) {
        return { outcome: 'unknown', flightId, output, readback: readback ?? undefined, error: errorText(error) }
      }
      return {
        outcome: confirmed ? 'confirmed' : 'unknown',
        flightId,
        attemptId: attempt.attemptId,
        output,
        readback: readback ?? undefined,
        ...(confirmed ? {} : { error: settled.diagnosticRef }),
      }
    }).catch(
      (error): RemoteGitOutcome => ({
        outcome: error instanceof RemoteGitClosedError ? 'interrupted' : 'unknown',
        flightId,
        error: errorText(error),
      }),
    )
    terminal(requestId, flightId, outcome.outcome, outcome.error, outcome.attemptId)
    return outcome
  }

  const ensureFresh = async (input: {
    scope: RemoteGitScope
    ttlMs: number
    refresh(): Promise<void>
    waitMs?: number
    force?: boolean
  }): Promise<RemoteGitFreshness> => {
    assertOpen()
    const owner = ownerFor(input.scope)
    return ensureRemoteGitFreshness(owner, input, now)
  }

  const clearFreshness = (): void => {
    for (const owner of owners.values()) delete owner.freshness
  }

  const recoverPush = async (input: {
    attempt: RemoteGitWriteAttempt
    readback(attempt: RemoteGitWriteAttempt): Promise<string | null>
    settleAttempt(attempt: RemoteGitWriteAttempt): Promise<void>
  }): Promise<RemoteGitOutcome> => {
    assertOpen()
    const requestId = randomUUID()
    const flightId = randomUUID()
    emit({ kind: 'declared', requestId, scope: input.attempt.scope, operation: 'push-recovery', at: now() })
    const outcome = await enqueue(input.attempt.scope, requestId, flightId, async (): Promise<RemoteGitOutcome> => {
      let readback: string | null = null
      let readbackError: unknown
      const startedAt = now()
      try {
        readback = await input.readback(input.attempt)
      } catch (error) {
        readbackError = error
      }
      noteSubprocess(requestId, flightId, 'readback', startedAt, readbackError, input.attempt.attemptId)
      const confirmed = readbackError === undefined && readback === input.attempt.expectedOid
      emit({
        kind: 'readback-settled',
        requestId,
        flightId,
        attemptId: input.attempt.attemptId,
        confirmed,
        at: now(),
      })
      const settled: RemoteGitWriteAttempt = {
        ...input.attempt,
        status: confirmed ? 'confirmed' : 'unknown',
        ...(confirmed ? {} : { diagnosticRef: errorText(readbackError ?? `readback=${readback ?? '<missing>'}`) }),
      }
      await input.settleAttempt(settled)
      return {
        outcome: confirmed ? 'confirmed' : 'unknown',
        flightId,
        attemptId: input.attempt.attemptId,
        readback: readback ?? undefined,
        ...(confirmed ? {} : { error: settled.diagnosticRef }),
      }
    }).catch((error): RemoteGitOutcome => ({ outcome: 'unknown', flightId, error: errorText(error) }))
    terminal(requestId, flightId, outcome.outcome, outcome.error, input.attempt.attemptId)
    return outcome
  }

  const deleteRemoteBranchIfPresent = (input: RemoteGitDeleteInput): Promise<RemoteGitOutcome> =>
    runDeleteRemoteBranchIfPresent(input, {
      assertOpen,
      now,
      newId: randomUUID,
      enqueue,
      emit,
      noteSubprocess,
      terminal,
      errorText,
    })

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    for (const [requestId, flightId] of openRequests) {
      terminal(requestId, flightId, 'interrupted', new RemoteGitClosedError())
    }
    for (const owner of owners.values()) {
      for (const entry of owner.queue.splice(0)) {
        clearTimeout(entry.timer)
        entry.reject(new RemoteGitClosedError())
      }
    }
    const running = Promise.all(
      [...owners.values()].map((owner) => owner.running).filter((value): value is Promise<void> => !!value),
    ).then(() => undefined)
    let timeout: ReturnType<typeof setTimeout> | undefined
    const bounded = new Promise<void>((resolve) => {
      timeout = setTimeout(resolve, closeWaitMs)
    })
    await Promise.race([running, bounded])
    if (timeout !== undefined) clearTimeout(timeout)
    await options.sink?.flush()
  }

  return {
    fetch,
    lsRemote,
    push,
    recoverPush,
    deleteRemoteBranchIfPresent,
    ensureFresh,
    clearFreshness,
    lifecycleEvents: (): RemoteGitLifecycleEvent[] => [...events],
    close,
  }
}

export type RemoteGitCoordinator = ReturnType<typeof createRemoteGitCoordinator>
