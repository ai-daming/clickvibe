import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveEventRound } from '../src/workflow/delivery-audit.ts'

test('delivery rounds advance only when a review verdict lands', () => {
  const events = [
    { kind: 'dev', at: '2026-08-23T01:00:00Z', round: 1 },
    { kind: 'review', at: '2026-08-23T02:00:00Z', verdict: { passed: false, issues: ['竞态'] }, round: 1 },
    { kind: 'resume', at: '2026-08-23T03:00:00Z', round: 2 },
  ] as const

  assert.equal(deriveEventRound([], 'dev'), 1)
  assert.equal(deriveEventRound([...events], 'rework'), 2)
  assert.equal(deriveEventRound([...events], 'review'), 2)
})

test('legacy review events without round still advance the manual workflow round', () => {
  assert.equal(
    deriveEventRound(
      [
        { kind: 'review', at: '2026-08-23T02:00:00Z', verdict: { passed: false, issues: ['旧意见'] } },
        { kind: 'note', at: '2026-08-23T02:30:00Z', note: 'manual' },
      ],
      'resume',
    ),
    2,
  )
})
