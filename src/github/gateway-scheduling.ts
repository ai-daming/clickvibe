import { GithubRateLimitError } from './rest.ts'

/**
 * Pure scheduling policy for the Gateway owner (issue #131, review r7 size
 * split): candidate selection depends only on its inputs — same wait/running
 * snapshots in, same choice out. The owner keeps the mutable state machine.
 */

/** One real resource bucket's last published snapshot (design §8). */
export interface BucketLedger {
  limit: number | null
  remaining: number | null
  used: number | null
  reset: number | null
  observedAt: number
  /** Monotonic republish counter — tells a step whether fresh evidence
   *  superseded its dispatch (vs. a silently consumed unit). */
  evidenceSeq: number
}

export interface PendingStep {
  requestId: string
  repo: string
  bucket: string
  priority: 'critical' | 'normal'
  deadlineAt: number
  enqueuedAt: number
  /** Evidence sequence at dispatch — see settleReservation. */
  evidenceSeq: number
  pacingMs: number
  run: () => Promise<unknown>
  settle: (value: unknown) => void
  fail: (error: unknown) => void
}

/**
 * Pick the next eligible step (ADR-0010 §3): repository capacity filters,
 * then the lane policy — aged normals first (starvation fence, review r6/F2),
 * then criticals, then normals — with repository round-robin inside the lane.
 */
export function selectCandidate(options: {
  waiting: PendingStep[]
  runningRepos: Map<string, number>
  lastDispatchPerRepo: Map<string, number>
  repositoryConcurrency: number
  agingMs: number
  now: number
}): PendingStep | null {
  const { waiting, runningRepos, lastDispatchPerRepo, repositoryConcurrency, agingMs, now } = options
  const eligible = waiting.filter((step) => (runningRepos.get(step.repo) ?? 0) < repositoryConcurrency)
  if (eligible.length === 0) return null
  const critical = eligible.filter((step) => step.priority === 'critical')
  const aged = eligible.filter((step) => step.priority === 'normal' && now - step.enqueuedAt >= agingMs)
  const lane = aged.length > 0 ? aged : critical.length > 0 ? critical : eligible.filter((s) => s.priority === 'normal')
  const pool = lane.length > 0 ? lane : eligible
  let chosen = pool[0]
  for (const step of pool) {
    if ((lastDispatchPerRepo.get(step.repo) ?? 0) < (lastDispatchPerRepo.get(chosen.repo) ?? 0)) chosen = step
  }
  return chosen
}

/** Outcome of the pure admission gate. */
export type AdmissionDecision = 'dispatch' | 'requeue' | 'rejected'

/** Live owner state the pure admission gate reads (no hidden closures). */
export interface AdmissionState {
  running: Map<number, { repo: string; bucket: string }>
  buckets: Map<string, BucketLedger>
  reservedByBucket: Map<string, number>
  credentialConcurrency: number
  repositoryConcurrency: number
  unknownBudgetProbeCap: number
  noteTerminal: (
    requestId: string,
    outcome: 'succeeded' | 'failed' | 'rate-limited' | 'interrupted',
    error?: unknown,
  ) => void
  scheduleDispatch: () => void
}

/**
 * The admission gate (design §6/§8): budget, probe caps and concurrency
 * limits. Runs as the LAST indivisible decision before run() — re-checked
 * after the pacing sleep, because state moved while the step slept
 * (review r8/F2: ten sleepers woke past the 6/3 caps together).
 */

/**
 * Pure admission gate (design §6/§8) over the owner's live state — the last
 * indivisible decision before run(), re-run after the pacing sleep.
 */
export function admitCandidate(candidate: PendingStep, state: AdmissionState): AdmissionDecision {
  if (state.running.size >= state.credentialConcurrency) return 'requeue'
  const repoRunning = [...state.running.values()].filter((entry) => entry.repo === candidate.repo).length
  if (repoRunning >= state.repositoryConcurrency) return 'requeue'
  // Per-bucket budget admission (design §8). A published ledger whose
  // reset already elapsed is stale — drop it and probe like unknown.
  let ledger = state.buckets.get(candidate.bucket)
  if (ledger && ledger.reset !== null && ledger.reset * 1000 <= Date.now()) {
    state.buckets.delete(candidate.bucket)
    ledger = undefined
  }
  if (ledger && ledger.remaining !== null) {
    const outstanding = state.reservedByBucket.get(candidate.bucket) ?? 0
    if (ledger.remaining - outstanding <= 0) {
      if (outstanding > 0) {
        // The in-flight reservation owns the truth; wait for its
        // settlement instead of failing on a possibly-stale number.
        return 'requeue'
      }
      const resetAt = ledger.reset !== null ? ledger.reset * 1000 : null
      if (resetAt !== null && resetAt > Date.now()) {
        if (resetAt > candidate.deadlineAt) {
          const error = new GithubRateLimitError(resetAt, 'primary')
          state.noteTerminal(candidate.requestId, 'rate-limited', error)
          candidate.fail(error)
          return 'rejected'
        }
        const wake = setTimeout(() => state.scheduleDispatch(), Math.max(resetAt - Date.now(), 1))
        wake.unref?.()
        return 'requeue'
      }
      // Exhausted with no usable reset: forget the guess, probe on.
      state.buckets.delete(candidate.bucket)
    }
  } else if (!ledger) {
    // Unknown budget: at most a conservative number of probe steps runs
    // concurrently; a settlement publishes the bucket and unlocks the lane.
    const unknownRunning = [...state.running.values()].filter((entry) => !state.buckets.has(entry.bucket)).length
    if (unknownRunning >= state.unknownBudgetProbeCap) return 'requeue'
  }
  return 'dispatch'
}
