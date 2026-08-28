import assert from 'node:assert/strict'
import test from 'node:test'
import { effectiveActionForIssue, freshSessionEntry } from '../src/client/fresh-session.ts'
import {
  FRESH_SESSION_ROUND_THRESHOLD,
  canStartFreshSession,
  deriveFreshSessionAvailability,
  selectSessionLaunch,
} from '../src/workflow/fresh-session.ts'

const reviewEvents = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    kind: 'review' as const,
    at: `2026-08-23T0${index}:00:00Z`,
    verdict: { passed: false, issues: [`issue ${index + 1}`] },
  }))

test('fresh sessions become available only after five landed review verdicts', () => {
  assert.equal(FRESH_SESSION_ROUND_THRESHOLD, 5)
  assert.equal(canStartFreshSession(5), false)
  assert.equal(canStartFreshSession(6), true)

  assert.deepEqual(deriveFreshSessionAvailability(reviewEvents(4), true, true), {
    round: 5,
    develop: false,
    review: false,
  })
  assert.deepEqual(deriveFreshSessionAvailability(reviewEvents(5), true, true), {
    round: 6,
    develop: true,
    review: true,
  })
})

test('fresh session entries require a corresponding resumable session', () => {
  assert.deepEqual(deriveFreshSessionAvailability(reviewEvents(5), false, true), {
    round: 6,
    develop: false,
    review: true,
  })
  assert.deepEqual(deriveFreshSessionAvailability(reviewEvents(5), true, false), {
    round: 6,
    develop: true,
    review: false,
  })
})

test('client maps fresh entries only beside matching continuation actions', () => {
  const available = { round: 6, develop: true, review: true }
  assert.equal(freshSessionEntry('resume', available), 'develop')
  assert.equal(freshSessionEntry('rework', available), 'develop')
  assert.equal(freshSessionEntry('review', available), 'review')
  assert.equal(freshSessionEntry('develop', available), null)
  assert.equal(freshSessionEntry('merge', available), null)
  assert.equal(freshSessionEntry('review', { ...available, review: false }), null)
})

test('client action fallback preserves closed, existing and brand-new issue behavior', () => {
  const review = { kind: 'review' as const, label: 'Review', hint: 'review now' }
  assert.deepEqual(effectiveActionForIssue(false, review, true), review)
  assert.equal(effectiveActionForIssue(true, review, true).kind, 'none')
  assert.equal(effectiveActionForIssue(false, undefined, false).kind, 'develop')
  assert.equal(effectiveActionForIssue(false, undefined, true).kind, 'none')
})

test('an unknown local-git observation fails closed with an explicit label', () => {
  const observation = { freshness: 'unknown' as const, error: '本地 Git 快照采样失败（已重试一次）: boom' }
  const action = effectiveActionForIssue(false, undefined, true, observation)
  assert.equal(action.kind, 'none')
  assert.equal(action.label, '本地状态未知')
  assert.match(action.hint, /boom/)
  // A healthy observation never alters the decision.
  const review = { kind: 'review' as const, label: 'Review', hint: 'review now' }
  assert.deepEqual(effectiveActionForIssue(false, review, true, undefined), review)
})

test('fresh and continuation requests split before command and prompt construction', () => {
  const owned = { sessionId: 'old-session', invalid: false }
  assert.deepEqual(selectSessionLaunch(false, owned), { sessionId: 'old-session', startsFresh: false })
  assert.deepEqual(selectSessionLaunch(true, owned), { sessionId: null, startsFresh: true })
  assert.deepEqual(selectSessionLaunch(false, { sessionId: null, invalid: true }), {
    sessionId: null,
    startsFresh: true,
  })
})
