import assert from 'node:assert/strict'
import test from 'node:test'
import { deriveDeliveryTimelineItem } from '../src/client/delivery-timeline.ts'
import { latestDevelopmentEvent } from '../src/client/runtime.ts'

test('dev timeline projection exposes frozen summary, diffstat and log anchor', () => {
  const item = deriveDeliveryTimelineItem({
    kind: 'rework',
    at: '2026-08-23T03:00:00Z',
    hash: 'def456',
    round: 2,
    agent: 'codex',
    fixed: 2,
    taskId: 'dev-123-token',
    stats: {
      commits: [{ hash: 'def456', subject: '修复竞态' }],
      filesChanged: 2,
      insertions: 14,
      deletions: 3,
      diffstat: [{ path: 'src/a.ts', insertions: 14, deletions: 3 }],
    },
  })

  assert.equal(item.kindLabel, '返工')
  assert.equal(item.summary, '第 2 轮 · Codex · 2 文件 · +14/-3 · 处理 2 条意见')
  assert.equal(item.detail.kind, 'development')
  assert.deepEqual(item.detail.commits, [{ hash: 'def456', subject: '修复竞态' }])
  assert.equal(item.detail.taskId, 'dev-123-token')
})

test('review projection preserves historical issue text and legacy events degrade safely', () => {
  const review = deriveDeliveryTimelineItem({
    kind: 'review',
    at: '2026-08-23T02:00:00Z',
    round: 1,
    agent: 'claude',
    verdict: { passed: false, issues: ['竞态条件', '缺少失败测试'] },
  })
  assert.equal(review.summary, '第 1 轮 · Claude · 2 条意见')
  assert.deepEqual(review.detail, { kind: 'review', issues: ['竞态条件', '缺少失败测试'] })

  const passed = deriveDeliveryTimelineItem({
    kind: 'review',
    at: '2026-08-23T04:00:00Z',
    round: 2,
    agent: 'codex',
    verdict: { passed: true, issues: [] },
  })
  assert.equal(passed.summary, '第 2 轮 · Codex · 0 条意见')

  const legacy = deriveDeliveryTimelineItem({ kind: 'dev', at: '2026-08-22T01:00:00Z', hash: 'old123' })
  assert.equal(legacy.summary, '')
  assert.equal(legacy.detail.kind, 'development')
})

test('auto-run events show the step count, never a round number', () => {
  const started = deriveDeliveryTimelineItem({ kind: 'auto-run', at: '2026-08-24T00:51:00Z', round: 0 })
  assert.equal(started.kindLabel, '自动推进')
  assert.equal(started.summary, '')

  const paused = deriveDeliveryTimelineItem({
    kind: 'auto-run',
    at: '2026-08-24T01:00:42Z',
    round: 0,
    step: 4,
    note: '自动跑到底已暂停:session-interrupted',
  })
  assert.equal(paused.summary, '第 4 步')
})

test('resume delivery remains the latest development summary', () => {
  const resumed = { kind: 'resume', at: '2026-08-23T03:00:00Z', hash: 'def456', fixed: 2 } as const
  assert.equal(
    latestDevelopmentEvent([
      { kind: 'dev', at: '2026-08-23T01:00:00Z', hash: 'abc123' },
      { kind: 'review', at: '2026-08-23T02:00:00Z', verdict: { passed: false, issues: ['竞态'] } },
      resumed,
    ]),
    resumed,
  )
})
