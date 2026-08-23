import assert from 'node:assert/strict'
import test from 'node:test'
import { isActionErrorExpired } from '../src/client/action-error.ts'
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
})

test('only stale development gate errors expire after derived state advances', () => {
  const staleErrors = [
    '该 issue 尚未完成开发,无法 review',
    '开发仍在进行,尚无可 Review 的完成事实',
    '本地 workflow 缓存缺失,且尚无完成事实,无法 Review',
    '尚无完成事实,无法 Review',
  ]
  for (const stale of staleErrors) {
    assert.equal(isActionErrorExpired(stale, 'review-ready', null), true)
    assert.equal(isActionErrorExpired(stale, 'reviewing', null), true)
    assert.equal(isActionErrorExpired(stale, 'developing', null), false)
    assert.equal(isActionErrorExpired(stale, 'review-ready', 'reviewing'), false)
  }
  assert.equal(isActionErrorExpired('有进行中任务,请等待当前开发任务完成后再 Review', 'reviewing', null), false)
  assert.equal(
    isActionErrorExpired('本地 workflow 缓存缺失,无法从 PR 链接恢复对应 Issue 的 Review 上下文', 'review-ready', null),
    false,
  )
  assert.equal(isActionErrorExpired('合并门禁拒绝: review 结论过期', 'review-ready', null), false)
  assert.equal(isActionErrorExpired('网络请求失败', 'reviewing', null), false)
  assert.equal(isActionErrorExpired(null, 'review-ready', null), false)
})
