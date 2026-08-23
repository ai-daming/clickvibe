import assert from 'node:assert/strict'
import test from 'node:test'
import { buildDevComment, buildReviewComment } from '../src/workflow/delivery-comment.ts'

test('dev comment starts with the standard flat meta block and lists fixed review issues', () => {
  const body = buildDevComment({
    commit: '9f3a2c1', issueNumber: '20', fixedIssues: ['修复竞态', '补充失败测试'],
    agent: 'codex', at: '2026-08-22T09:00:00.000Z',
  })
  assert.equal(body, [
    '== Dev Meta ==',
    '- event: dev',
    '- commit: 9f3a2c1',
    '- issue: #20',
    '- fixed: 2',
    '- next: review',
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
    '- 修复竞态',
    '- 补充失败测试',
    '',
    '下一步:请 Review 当前提交。',
  ].join('\n'))
})

test('initial dev delivery has fixed zero and still includes a delivery summary', () => {
  const body = buildDevComment({
    commit: '9f3a2c1', issueNumber: '20', fixedIssues: [], agent: 'claude', at: '2026-08-22T09:00:00Z',
  })
  assert.match(body, /- fixed: 0\n- next: review\n- agent: claude/)
  assert.match(body, /### 本次交付摘要\n\n已完成本轮 Issue 需求实现。/)
})

test('passed review comment points to merge', () => {
  const body = buildReviewComment({
    commit: '3fb7db6', issueNumber: '20', passed: true, issues: [], agent: 'codex', at: '2026-08-22T10:00:00Z',
  })
  assert.ok(body.startsWith('== Review Meta ==\n- event: review'))
  assert.match(body, /- passed: true\n- next: merge/)
  assert.match(body, /✅ ClickVibe Review 通过/)
  assert.match(body, /下一步:可合并当前提交。/)
})

test('failed review comment lists every issue and points to rework', () => {
  const body = buildReviewComment({
    commit: '3fb7db6', issueNumber: '20', passed: false, issues: ['竞态', '缺测试'], agent: 'claude', at: '2026-08-22T10:00:00Z',
  })
  assert.match(body, /- passed: false\n- next: rework/)
  assert.match(body, /- 竞态\n- 缺测试/)
  assert.match(body, /下一步:请重新开发并处理上述问题。/)
})
