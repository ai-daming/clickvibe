import assert from 'node:assert/strict'
import test from 'node:test'
import { fingerprintGithubIssueContract } from '../src/workflow/work-item-contract-repository.ts'

const base = {
  url: 'https://github.com/o/r/issues/5',
  title: '目标',
  body: '## 目标\n做一件事\n## 验收标准\n- [ ] 做完\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
  state: 'OPEN',
  updatedAt: '2026-08-25T03:00:00Z',
}

test('canonical contract ignores provider metadata and binds goal plus Work Item identity', () => {
  const authorized = fingerprintGithubIssueContract({ ...base, comments: [] })
  const withAgentComments = fingerprintGithubIssueContract({
    ...base,
    title: '新标题',
    state: 'CLOSED',
    updatedAt: '2026-08-25T03:18:04Z',
    comments: [{ author: { login: 'ai-daming' }, body: '## 开发前不变量…' }],
  })
  assert.equal(authorized, withAgentComments, '非契约元数据不应使授权失效')

  assert.notEqual(
    authorized,
    fingerprintGithubIssueContract({ ...base, body: base.body.replace('做一件事', '改需求了') }),
  )
  assert.notEqual(authorized, fingerprintGithubIssueContract({ ...base, url: 'https://github.com/o/r/issues/6' }))
})
