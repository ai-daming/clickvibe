import assert from 'node:assert/strict'
import test from 'node:test'
import { githubWorkItemIdentity } from '../src/github/work-item-identity.ts'
import { canonicalWorkItemIdentity, parseWorkItemIdentity, workItemKey } from '../src/infra/work-item-identity.ts'

test('WorkItemIdentity has one stable canonical serialization and durable key', () => {
  const identity = {
    provider: 'github',
    instance: 'github.com',
    container: 'ai-daming/clickvibe',
    id: '134',
  }

  assert.equal(
    canonicalWorkItemIdentity(identity),
    '["clickvibe.work-item-identity",1,"github","github.com","ai-daming/clickvibe","134"]',
  )
  assert.equal(workItemKey(identity), 'wi1_k8NlXDvPdtgr8pQ8yREG_5KaTn0rKWIllVJnNQZMA6M')
  assert.deepEqual(parseWorkItemIdentity(identity), identity)
})

test('WorkItemIdentity rejects missing, empty and non-string fields without normalizing values', () => {
  for (const value of [
    null,
    {},
    { provider: '', instance: 'github.com', container: 'o/r', id: '1' },
    { provider: 'github', instance: '', container: 'o/r', id: '1' },
    { provider: 'github', instance: 'github.com', container: '', id: '1' },
    { provider: 'github', instance: 'github.com', container: 'o/r', id: '' },
    { provider: 'github', instance: 'github.com', container: 'o/r', id: 1 },
  ]) {
    assert.throws(() => parseWorkItemIdentity(value), /WorkItemIdentity/)
  }

  const spaced = { provider: ' github ', instance: 'github.com', container: 'o/r', id: '1' }
  assert.deepEqual(parseWorkItemIdentity(spaced), spaced)
})

test('canonical JSON keeps field boundaries and JSON escaping unambiguous', () => {
  const first = { provider: 'a"b', instance: 'c\\d', container: 'e\nf', id: 'g' }
  const second = { provider: 'a', instance: '"bc\\d', container: 'e\nf', id: 'g' }
  assert.equal(canonicalWorkItemIdentity(first), '["clickvibe.work-item-identity",1,"a\\"b","c\\\\d","e\\nf","g"]')
  assert.notEqual(canonicalWorkItemIdentity(first), canonicalWorkItemIdentity(second))
  assert.notEqual(workItemKey(first), workItemKey(second))
})

test('GitHub adapter owns positive issue-number validation and host normalization', () => {
  assert.deepEqual(
    githubWorkItemIdentity({ instance: 'GitHub.COM', owner: 'ai-daming', repository: 'clickvibe', number: 134 }),
    {
      provider: 'github',
      instance: 'github.com',
      container: 'ai-daming/clickvibe',
      id: '134',
    },
  )
  assert.equal(
    githubWorkItemIdentity({ instance: 'github.example.com', owner: 'o', repository: 'r', number: '99' }).id,
    '99',
  )
  for (const number of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '', '0', '01', '1.5', 'abc']) {
    assert.throws(
      () => githubWorkItemIdentity({ instance: 'github.com', owner: 'o', repository: 'r', number }),
      /positive integer/,
    )
  }
  for (const coordinates of [
    { instance: '', owner: 'o', repository: 'r', number: 1 },
    { instance: 1, owner: 'o', repository: 'r', number: 1 },
    { instance: 'github.com', owner: '', repository: 'r', number: 1 },
    { instance: 'github.com', owner: 'o', repository: '', number: 1 },
    { instance: 'github.com', owner: 'o/x', repository: 'r', number: 1 },
  ]) {
    assert.throws(() => githubWorkItemIdentity(coordinates as never), /GitHub/)
  }
})
