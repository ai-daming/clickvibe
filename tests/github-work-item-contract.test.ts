import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGithubWorkItemContract } from '../src/github/work-item-contract.ts'
import { fingerprintWorkItemContract } from '../src/workflow/work-item-contract.ts'

const body = `## 问题与证据
状态：已观察
Evidence only.

## 目标
Ship the contract

## 验收标准
- [ ] Agent verifies it
- [x] [人工] Human verifies it
- [ ] [外部] Provider verifies it

## 依赖
依赖: Blocked by #134

## 非目标
无

## 约束
- No v0.3
- No legacy reader

## 架构影响与基线
- 架构影响等级：L3
`

function item(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: 'https://github.com/ai-daming/clickvibe/issues/136',
    title: 'Title',
    body,
    state: 'OPEN',
    updatedAt: '2026-09-03T00:00:00Z',
    comments: [],
    ...overrides,
  }
}

test('GitHub adapter parses the current Issue evidence contract into canonical fields', () => {
  const parsed = parseGithubWorkItemContract(item(), [{ number: 134, title: '', state: 'CLOSED' }])
  assert.deepEqual(parsed.workItem, {
    provider: 'github',
    instance: 'github.com',
    container: 'ai-daming/clickvibe',
    id: '136',
  })
  assert.deepEqual(parsed.goal, { state: 'known', value: 'Ship the contract' })
  assert.deepEqual(parsed.acceptanceCriteria, {
    state: 'known',
    value: [
      { description: 'Agent verifies it', verificationAuthority: 'agent' },
      { description: 'Human verifies it', verificationAuthority: 'human' },
      { description: 'Provider verifies it', verificationAuthority: 'external' },
    ],
  })
  assert.deepEqual(parsed.dependencies, {
    state: 'known',
    value: [{ ...parsed.workItem, id: '134' }],
  })
  assert.deepEqual(parsed.nonGoals, { state: 'known', value: [] })
  assert.deepEqual(parsed.constraints, { state: 'known', value: ['No v0.3', 'No legacy reader'] })
  assert.equal(parsed.architectureImpact, 'L3')
})

test('checkbox, title, comments and updatedAt changes do not change the canonical fingerprint', () => {
  const first = parseGithubWorkItemContract(item(), [{ number: 134, title: '', state: 'OPEN' }])
  const second = parseGithubWorkItemContract(
    item({
      title: 'Metadata changed',
      updatedAt: '2026-09-04T00:00:00Z',
      comments: [{ author: { login: 'bot' }, body: 'new comment' }],
      body: body.replace('- [ ] Agent', '- [x] Agent'),
    }),
    [{ number: 134, title: 'metadata', state: 'CLOSED' }],
  )
  assert.equal(fingerprintWorkItemContract(first), fingerprintWorkItemContract(second))
})

test('missing is distinct from explicit empty and conflicts fail closed', () => {
  const missing = parseGithubWorkItemContract(item({ body: body.replace(/\n## 非目标[\s\S]*?(?=\n## 约束)/, '') }))
  assert.deepEqual(missing.nonGoals, { state: 'unknown', reason: 'missing' })

  const badAuthority = parseGithubWorkItemContract(
    item({ body: body.replace('Agent verifies it', '[机器人] verifies it') }),
  )
  assert.deepEqual(badAuthority.acceptanceCriteria, { state: 'unknown', reason: 'unparseable' })

  const conflict = parseGithubWorkItemContract(item(), [{ number: 135, title: '', state: 'OPEN' }])
  assert.deepEqual(conflict.dependencies, { state: 'unknown', reason: 'conflicting' })
})
