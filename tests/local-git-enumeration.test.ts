/** Enumeration sampler semantics (issue #122 Q3): builder, parser, immutability. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { buildRepositoryEnumerationCommand, parseRepositoryEnumeration } from '../src/infra/local-git-sampler.ts'
import { LocalGitSnapshotRegistry } from '../src/infra/local-git-snapshot.ts'

function section(key: string, rc: number, value: string | null): string {
  const encoded = value === null ? '' : Buffer.from(value, 'utf8').toString('base64')
  return `${key}\t${rc}\t${encoded}`
}

test('repository enumeration: builder/contract/parser agree and counts stay strict', () => {
  const command = buildRepositoryEnumerationCommand({ repoPath: '/repo/main' })
  assert.match(command, /git -C '\/repo\/main' rev-parse --git-dir 2>&1/)
  assert.match(
    command,
    /git -C '\/repo\/main' for-each-ref --format='%\(refname:short\)' refs\/heads refs\/remotes\/origin/,
  )
  assert.match(command, /rev-list --count "\$db\.\.\$br" 2>&1/)

  const enc = (value: string) => Buffer.from(value, 'utf8').toString('base64')
  const section = (key: string, rc: number, value: string) => `${key}\t${rc}\t${enc(value)}`
  const healthy = [
    section('ENUM_GITDIR', 0, '/repo/.git'),
    section('ENUM_HEAD', 0, 'abc1234'),
    section('ENUM_DEFAULT', 0, 'origin/main'),
    section('ENUM_REFS', 0, 'main\norigin/main\nclickvibe-issue-122\norigin/clickvibe-issue-9'),
    section('ENUM_BASE_AVAILABLE', 0, '1'),
    section('ENUM_COUNTS', 0, 'main\t0\t0\nclickvibe-issue-122\t0\t2'),
  ].join('\n')
  const parsed = parseRepositoryEnumeration(healthy)
  assert.deepEqual(parsed.requiredFailures, [])
  assert.equal(parsed.defaultBranch, 'main')
  assert.equal(parsed.counts['clickvibe-issue-122'], 2)
  assert.ok(parsed.refs.includes('origin/clickvibe-issue-9'))

  const noBase = [
    section('ENUM_GITDIR', 0, '/repo/.git'),
    section('ENUM_HEAD', 0, 'abc1234'),
    section('ENUM_DEFAULT', 0, 'origin/main'),
    section('ENUM_REFS', 0, 'main'),
    section('ENUM_BASE_AVAILABLE', 0, '0'),
    section('ENUM_COUNTS', 0, ''),
  ].join('\n')
  const noBaseParsed = parseRepositoryEnumeration(noBase)
  assert.deepEqual(noBaseParsed.requiredFailures, [], 'deleted default base skips counts as expected absence')
  assert.equal(Object.keys(noBaseParsed.counts).length, 0)

  const failedCount = [
    section('ENUM_GITDIR', 0, '/repo/.git'),
    section('ENUM_HEAD', 0, 'abc1234'),
    section('ENUM_DEFAULT', 0, 'origin/main'),
    section('ENUM_REFS', 0, 'clickvibe-issue-122'),
    section('ENUM_BASE_AVAILABLE', 0, '1'),
    section('ENUM_COUNTS', 0, 'clickvibe-issue-122\t128\tfatal: bad object'),
  ].join('\n')
  const failed = parseRepositoryEnumeration(failedCount)
  assert.deepEqual(
    failed.requiredFailures.map((failure) => failure.operation),
    ['git -C <repo> rev-list --count origin/main..clickvibe-issue-122'],
  )
  assert.match(failed.requiredFailures[0].error, /fatal: bad object/)

  const fractional = [
    section('ENUM_GITDIR', 0, '/repo/.git'),
    section('ENUM_HEAD', 0, 'abc1234'),
    section('ENUM_DEFAULT', 0, 'origin/main'),
    section('ENUM_REFS', 0, 'clickvibe-issue-122'),
    section('ENUM_BASE_AVAILABLE', 0, '1'),
    section('ENUM_COUNTS', 0, 'clickvibe-issue-122\t0\t1.5'),
  ].join('\n')
  assert.ok(parseRepositoryEnumeration(fractional).requiredFailures.length > 0)
})

test('enumeration envelopes are deeply immutable and carry the checkout HEAD', async () => {
  const output = [
    section('ENUM_GITDIR', 0, '/repo/.git'),
    section('ENUM_HEAD', 0, 'abc1234'),
    section('ENUM_DEFAULT', 0, 'origin/main'),
    section('ENUM_REFS', 0, 'clickvibe-issue-122'),
    section('ENUM_BASE_AVAILABLE', 0, '1'),
    section('ENUM_COUNTS', 0, 'clickvibe-issue-122\t0\t2'),
  ].join('\n')
  const ctx = {
    shell: {
      resolve: (spec: unknown) => spec,
      run: async () => ({ exitCode: 0, stdout: { text: output }, stderr: { text: '' } }),
    },
  } as unknown as Context
  const registry = new LocalGitSnapshotRegistry()
  const envelope = (await registry.observeEnumeration(ctx, 'ai-daming/clickvibe', { repoPath: '/repo/main' })).envelope
  assert.equal(envelope.sourceRevision, 'abc1234')
  assert.throws(() => {
    envelope.sample.counts['clickvibe-issue-122'] = 99
  }, /Cannot assign to read only|not extensible|readonly/i)
  const cached = (await registry.observeEnumeration(ctx, 'ai-daming/clickvibe', { repoPath: '/repo/main' })).envelope
  assert.equal(cached, envelope)
  assert.equal(cached.sample.counts['clickvibe-issue-122'], 2, 'cache hits must read the frozen value')
})
