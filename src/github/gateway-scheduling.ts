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
