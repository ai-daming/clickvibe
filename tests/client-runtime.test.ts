import assert from 'node:assert/strict'
import test from 'node:test'
import {
  decodeLiveLogLine,
  deliveryPublicationLabel,
  githubCompareUrl,
  selectHistoryTask,
  workflowStatusLabel,
} from '../src/client/runtime.ts'

test('client runtime keeps host wire records and legacy text readable', () => {
  const event = { source: 'agent', agent: 'codex', kind: 'message', text: 'done' } as const
  const encoded = `[clickvibe:event]${encodeURIComponent(JSON.stringify(event))}`
  assert.deepEqual(decodeLiveLogLine(encoded), event)
  assert.deepEqual(decodeLiveLogLine('legacy'), { source: 'agent', kind: 'text', text: 'legacy' })
})

test('client runtime derives stable task, status, publication and compare labels', () => {
  assert.deepEqual(
    selectHistoryTask({ stage: 'developing', devTaskId: 'dev-2-x', reviewTaskId: 'review-1-x', hasReviewResult: true }),
    { taskId: 'dev-2-x', expectRunning: true },
  )
  assert.equal(workflowStatusLabel('review-ready', true, false, 'changed', null), '待重新 Review')
  assert.equal(
    deliveryPublicationLabel({ target: 'pr', status: 'posted', url: 'https://example.test' }),
    'GitHub PR 评论 ↗',
  )
  assert.equal(
    githubCompareUrl('owner/repo', 'feature/x', 'origin/release'),
    'https://github.com/owner/repo/compare/release...feature%2Fx?expand=1',
  )
  assert.equal(
    githubCompareUrl('owner/repo', 'feature/x', 'origin/release/deleted @ abc123', 'main', false),
    'https://github.com/owner/repo/compare/abc123...feature%2Fx?expand=1',
  )
})
