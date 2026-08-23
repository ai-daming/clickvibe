import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDevelopmentEventKind, deriveEventRound, latestDevelopmentHash } from '../src/workflow/delivery-audit.ts'

test('delivery rounds advance only when a review verdict lands', () => {
  const events = [
    { kind: 'dev', at: '2026-08-23T01:00:00Z', round: 1 },
    { kind: 'review', at: '2026-08-23T02:00:00Z', verdict: { passed: false, issues: ['竞态'] }, round: 1 },
    { kind: 'resume', at: '2026-08-23T03:00:00Z', round: 2 },
  ] as const

  assert.equal(deriveEventRound([]), 1)
  assert.equal(deriveEventRound([...events]), 2)
  assert.equal(latestDevelopmentHash([...events]), undefined)
})

test('legacy review events without round still advance the manual workflow round', () => {
  assert.equal(
    deriveEventRound([
      { kind: 'review', at: '2026-08-23T02:00:00Z', verdict: { passed: false, issues: ['旧意见'] } },
      { kind: 'note', at: '2026-08-23T02:30:00Z', note: 'manual' },
    ]),
    2,
  )
})

test('resume is a development delivery and no-review restarts stay dev events', () => {
  assert.equal(
    latestDevelopmentHash([
      { kind: 'dev', at: '2026-08-23T01:00:00Z', hash: 'abc123' },
      { kind: 'resume', at: '2026-08-23T02:00:00Z', hash: 'def456' },
    ]),
    'def456',
  )
  assert.equal(
    latestDevelopmentHash([
      { kind: 'dev', at: '2026-08-23T01:00:00Z', hash: 'abc123' },
      { kind: 'resume', at: '2026-08-23T02:00:00Z' },
    ]),
    'abc123',
  )
  assert.equal(deriveDevelopmentEventKind(true, ''), 'dev')
  assert.equal(deriveDevelopmentEventKind(false, ''), 'dev')
  assert.equal(deriveDevelopmentEventKind(false, '按 Review 意见返工'), 'rework')
})
