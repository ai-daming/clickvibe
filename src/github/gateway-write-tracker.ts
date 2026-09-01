/**
 * Active logical-write tracker (ADR-0010 §9/§10, review CF1) — pure move out
 * of gateway-owner.ts (size hard limit). Not a second state machine: it is a
 * join set over the existing transaction promises plus one sticky bit.
 *
 * close() drains these transactions within its window instead of guessing a
 * terminal; one still unsettled at the deadline is swept by what it knows —
 * never dispatched → interrupted, dispatch attempted → unknown (it may have
 * executed upstream).
 */

export interface ActiveWriteTrackerHooks {
  /** Emit the phase-resolved terminal for a still-unsettled write. */
  noteTerminal(requestId: string, outcome: 'interrupted' | 'unknown', error: string): void
}

export interface ActiveWriteTracker {
  /** Run one whole logical write transaction under its request id. */
  run<T>(requestId: string, run: () => Promise<T>): Promise<T>
  /** Sticky: once the dispatch was attempted, the write may be upstream. */
  noteDispatchAttempted(requestId: string): void
  /** Whether the request is an in-flight logical write. */
  has(requestId: string): boolean
  /** Number of in-flight logical writes (quiescence input). */
  size(): number
  /** Await every in-flight transaction (bounded by the caller's deadline). */
  drain(): Promise<void>
  /** Terminal every still-active write by phase; call at the close deadline. */
  sweepAtDeadline(): void
}

export function createActiveWriteTracker(hooks: ActiveWriteTrackerHooks): ActiveWriteTracker {
  const active = new Map<string, { dispatchAttempted: boolean; settled: Promise<void> }>()

  return {
    run<T>(requestId: string, run: () => Promise<T>): Promise<T> {
      const record: { dispatchAttempted: boolean; settled: Promise<void> } = {
        dispatchAttempted: false,
        settled: Promise.resolve(),
      }
      const promise = Promise.resolve()
        .then(run)
        .finally(() => {
          active.delete(requestId)
        })
      record.settled = promise.then(
        () => {},
        () => {},
      )
      active.set(requestId, record)
      return promise
    },
    noteDispatchAttempted(requestId: string): void {
      const record = active.get(requestId)
      if (record) record.dispatchAttempted = true
    },
    has(requestId: string): boolean {
      return active.has(requestId)
    },
    size(): number {
      return active.size
    },
    drain(): Promise<void> {
      return Promise.all([...active.values()].map((record) => record.settled)).then(() => {})
    },
    sweepAtDeadline(): void {
      for (const [requestId, record] of active) {
        hooks.noteTerminal(
          requestId,
          record.dispatchAttempted ? 'unknown' : 'interrupted',
          'Gateway 关闭:写事务未在窗口内结算',
        )
      }
    },
  }
}
