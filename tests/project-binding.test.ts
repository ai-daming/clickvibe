import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canonicalProjectBindingIdentity,
  createProjectBinding,
  parseClickVibeConfigV1,
  projectBindingKey,
} from '../src/infra/project-binding.ts'

const container = { provider: 'github', instance: 'github.com', id: 'ai-daming/clickvibe' }
const repositoryId = 'repo_123e4567-e89b-42d3-a456-426614174000'

test('bindingId is stable across path and remote changes but scoped by container and clone', () => {
  const first = createProjectBinding({
    container,
    repository: { repositoryId, localPath: '/Users/one/clickvibe', primaryRemote: 'origin' },
  })
  const moved = createProjectBinding({
    container,
    repository: { repositoryId, localPath: '/Volumes/code/clickvibe', primaryRemote: 'upstream' },
  })

  assert.equal(
    canonicalProjectBindingIdentity(container, repositoryId),
    '["clickvibe.project-binding",1,"github","github.com","ai-daming/clickvibe","repo_123e4567-e89b-42d3-a456-426614174000"]',
  )
  assert.equal(first.bindingId, moved.bindingId)
  assert.equal(first.bindingId, 'pb1_oC1PH9XDXYcMHGp2OnRoYCy5cnY5nbLsrhHWbziYsxQ')
  assert.notEqual(first.bindingId, projectBindingKey({ ...container, id: 'other/repo' }, repositoryId))
  assert.notEqual(first.bindingId, projectBindingKey(container, 'repo_123e4567-e89b-42d3-a456-426614174001'))
})

test('schema 1 config validates binding fingerprints and rejects ambiguous local ownership', () => {
  const binding = createProjectBinding({
    container,
    repository: { repositoryId, localPath: '/work/clickvibe', primaryRemote: 'origin' },
  })
  const config = {
    schemaVersion: 1,
    worktreeRoot: '/worktrees',
    fetchTtlSeconds: 45,
    diagnosticsMaxBytes: 10_485_760,
    projectBindings: [binding],
  }
  assert.deepEqual(parseClickVibeConfigV1(config), config)

  assert.throws(() => parseClickVibeConfigV1({ ...config, schemaVersion: 2 }), /schemaVersion/)
  assert.throws(
    () => parseClickVibeConfigV1({ ...config, projectBindings: [{ ...binding, bindingId: 'pb1_wrong' }] }),
    /bindingId/,
  )
  assert.throws(
    () =>
      parseClickVibeConfigV1({ ...config, projectBindings: [binding, { ...binding, bindingId: binding.bindingId }] }),
    /container.*more than one active Binding/,
  )
  const secondContainer = createProjectBinding({
    container: { ...container, id: 'ai-daming/other' },
    repository: { repositoryId, localPath: '/work/other', primaryRemote: 'origin' },
  })
  assert.throws(
    () => parseClickVibeConfigV1({ ...config, projectBindings: [binding, secondContainer] }),
    /repositoryId.*unique/,
  )
})

test('schema 1 config rejects unknown shapes instead of treating corruption as empty config', () => {
  const binding = createProjectBinding({
    container,
    repository: { repositoryId, localPath: '/work/clickvibe', primaryRemote: 'origin' },
  })
  const base = { schemaVersion: 1, worktreeRoot: '/worktrees', projectBindings: [binding] }
  for (const value of [
    null,
    {},
    { ...base, worktreeRoot: '' },
    { ...base, worktreeRoot: 'relative/worktrees' },
    { ...base, fetchTtlSeconds: 0 },
    { ...base, fetchTtlSeconds: 29 },
    { ...base, fetchTtlSeconds: 61 },
    { ...base, fetchTtlSeconds: 45.5 },
    { ...base, diagnosticsMaxBytes: -1 },
    { ...base, diagnosticsMaxBytes: 1.5 },
    { ...base, projectBindings: 'not-an-array' },
    {
      ...base,
      projectBindings: [{ ...binding, repository: { ...binding.repository, localPath: 'relative/repo' } }],
    },
    { ...base, projectBindings: [{ ...binding, repository: { ...binding.repository, repositoryId: 'broken' } }] },
    { ...base, projectBindings: [{ ...binding, repository: { ...binding.repository, primaryRemote: '' } }] },
  ]) {
    assert.throws(() => parseClickVibeConfigV1(value), /ClickVibeConfigV1|ProjectBinding/)
  }
})
