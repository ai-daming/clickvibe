import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDevComment, buildReviewComment } from '../src/workflow/delivery-comment.ts'

test('dev comment starts with the standard flat meta block and lists fixed review issues', () => {
  const body = buildDevComment({
    commit: '9f3a2c1',
    issueNumber: '20',
    fixedIssues: ['修复竞态', '补充失败测试'],
    agent: 'codex',
    round: 2,
    stats: { commits: [], filesChanged: 3, insertions: 18, deletions: 4, diffstat: [] },
    at: '2026-08-22T09:00:00.000Z',
  })
  assert.equal(
    body,
    [
      '== Dev Meta ==',
      '- event: dev',
      '- commit: 9f3a2c1',
      '- issue: #20',
      '- fixed: 2',
      '- next: review',
      '- round: 2',
      '- stats: commits=0 filesChanged=3 insertions=18 deletions=4',
      '- agent: codex',
      '- at: 2026-08-22T09:00:00.000Z',
      '',
      '## 🚀 ClickVibe 开发完成',
      '',
      '当前交付提交: `9f3a2c1`',
      '',
      '### 本次交付摘要',
      '',
      '已处理上一轮 Review 的 2 个问题:',
      '',
      '- [已于第 2 轮修复] 修复竞态',
      '- [已于第 2 轮修复] 补充失败测试',
      '',
      '下一步:请 Review 当前提交。',
    ].join('\n'),
  )
})

test('initial dev delivery has fixed zero and still includes a delivery summary', () => {
  const body = buildDevComment({
    commit: '9f3a2c1',
    issueNumber: '20',
    fixedIssues: [],
    agent: 'claude',
    round: 1,
    at: '2026-08-22T09:00:00Z',
  })
  assert.match(body, /- fixed: 0\n- next: review\n- round: 1\n- stats: unavailable\n- agent: claude/)
  assert.match(body, /### 本次交付摘要\n\n已完成本轮 Issue 需求实现。/)
})

test('passed review comment points to merge', () => {
  const body = buildReviewComment({
    commit: '3fb7db6',
    issueNumber: '20',
    passed: true,
    issues: [],
    agent: 'codex',
    round: 1,
    stats: {
      commits: [{ hash: '3fb7db6', subject: 'ship' }],
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
      diffstat: [],
    },
    at: '2026-08-22T10:00:00Z',
  })
  assert.ok(body.startsWith('== Review Meta ==\n- event: review'))
  assert.match(body, /- passed: true\n- next: merge/)
  assert.match(body, /- next: merge\n- round: 1\n- stats: commits=1 filesChanged=1 insertions=2 deletions=0/)
  assert.match(body, /✅ ClickVibe Review 通过/)
  assert.match(body, /下一步:可合并当前提交。/)
})

test('passed review comment keeps non-blocking notes visible without blocking merge', () => {
  const body = buildReviewComment({
    commit: '3fb7db6',
    issueNumber: '20',
    passed: true,
    issues: ['[无法验证] 窄面板可读性为 [人工] 验收项(非缺陷)'],
    agent: 'claude',
    round: 1,
    at: '2026-08-22T10:00:00Z',
  })
  assert.match(body, /✅ ClickVibe Review 通过/)
  assert.match(body, /未发现阻塞问题\(随行备注 1 条,不影响合并\)/)
  assert.ok(body.includes('- [无法验证] 窄面板可读性为 [人工] 验收项(非缺陷)'))
  assert.match(body, /下一步:可合并当前提交。/)
})

test('failed review comment lists every issue and points to rework', () => {
  const body = buildReviewComment({
    commit: '3fb7db6',
    issueNumber: '20',
    passed: false,
    issues: ['竞态', '缺测试'],
    agent: 'claude',
    round: 1,
    at: '2026-08-22T10:00:00Z',
  })
  assert.match(body, /- passed: false\n- next: rework/)
  assert.match(body, /- 竞态\n- 缺测试/)
  assert.match(body, /下一步:请重新开发并处理上述问题。/)
})

test('failed review comment can be updated to mark every issue fixed in a later round', () => {
  const body = buildReviewComment({
    commit: '3fb7db6',
    issueNumber: '20',
    passed: false,
    issues: ['竞态', '缺测试'],
    agent: 'claude',
    round: 1,
    fixedRound: 2,
    at: '2026-08-22T10:00:00Z',
  })
  assert.match(body, /- fixed-round: 2/)
  assert.match(body, /- \[已于第 2 轮修复\] 竞态\n- \[已于第 2 轮修复\] 缺测试/)
  assert.match(body, /第 2 轮修复已交付，请 Review 当前提交。/)
})
