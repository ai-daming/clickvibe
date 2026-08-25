import assert from 'node:assert/strict'
import test from 'node:test'
import { issueSnapshot, sameIssueContract } from '../src/github/issue.ts'

const base = {
  url: 'https://github.com/o/r/issues/5',
  title: '目标',
  body: '## 目标\n做一件事',
  state: 'OPEN',
  updatedAt: '2026-08-25T03:00:00Z',
}

/**
 * 重挂授权的契约身份(#123 事故,2026-08-25):协议要求 agent 在运行中向 issue
 * 发评论(不变量、Dev Meta),评论与 updatedAt 变化不得使授权失效;正文/标题/
 * 状态变化才需要重新授权。与 review 结论的 bodyHash 契约同一原则。
 */
test('sameIssueContract ignores comments and updatedAt, binds to body/title/state/url', async () => {
  const { sameIssueContract } = await import('../src/github/issue.ts')
  const authorized = issueSnapshot({ ...base, comments: [] })
  const withAgentComments = issueSnapshot({
    ...base,
    updatedAt: '2026-08-25T03:18:04Z',
    comments: [{ author: { login: 'ai-daming' }, body: '## 开发前不变量…' }],
  })
  assert.ok(sameIssueContract(authorized, withAgentComments), '协议要求的评论不应使授权失效')

  assert.ok(!sameIssueContract(authorized, issueSnapshot({ ...base, body: '## 目标\n改需求了' })))
  assert.ok(!sameIssueContract(authorized, issueSnapshot({ ...base, title: '新标题' })))
  assert.ok(!sameIssueContract(authorized, issueSnapshot({ ...base, state: 'CLOSED' })))
  assert.ok(!sameIssueContract(authorized, issueSnapshot({ ...base, url: 'https://github.com/o/r/issues/6' })))
})
