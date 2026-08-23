import type { WorkflowEvent } from '../infra/state.ts'
import { deriveEventRound } from './delivery-audit.ts'

export const FRESH_SESSION_ROUND_THRESHOLD = 5

export interface FreshSessionAvailability {
  round: number
  develop: boolean
  review: boolean
}

export interface SessionLaunch {
  sessionId: string | null
  startsFresh: boolean
}

/** Fresh sessions are a manual escape hatch beginning with round six. */
export function canStartFreshSession(round: number): boolean {
  return Number.isSafeInteger(round) && round > FRESH_SESSION_ROUND_THRESHOLD
}

/** Keep visibility tied to both event history and an actually resumable session. */
export function deriveFreshSessionAvailability(
  events: WorkflowEvent[] | undefined,
  hasDevelopSession: boolean,
  hasReviewSession: boolean,
): FreshSessionAvailability {
  const round = deriveEventRound(events ?? [])
  const overThreshold = canStartFreshSession(round)
  return {
    round,
    develop: overThreshold && hasDevelopSession,
    review: overThreshold && hasReviewSession,
  }
}

/** Route an explicit fresh choice away from every previous session id. */
export function selectSessionLaunch(
  freshRequested: boolean,
  ownedSession: { sessionId: string | null; invalid: boolean },
): SessionLaunch {
  return {
    sessionId: freshRequested ? null : ownedSession.sessionId,
    startsFresh: freshRequested || ownedSession.invalid,
  }
}
