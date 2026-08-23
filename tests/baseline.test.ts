import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baselineDependencyIssue,
  baselinePreviewOptions,
  frozenBaseHash,
  frozenRemoteBase,
  requestedRemoteBase,
  resolveSelectedRemoteBase,
} from '../src/workflow/baseline.ts'

test('baseline request accepts only origin refs and keeps origin/HEAD as the default sentinel', () => {
  assert.equal(requestedRemoteBase(undefined), 'origin/HEAD')
  assert.equal(requestedRemoteBase(' origin/HEAD '), 'origin/HEAD')
  assert.equal(requestedRemoteBase('origin/release/2.0'), 'origin/release/2.0')
  assert.throws(() => requestedRemoteBase('release/2.0'), /origin\/\*/)
  assert.throws(() => requestedRemoteBase('HEAD'), /origin\/\*/)
  assert.throws(() => requestedRemoteBase('origin/../main'), /远端分支/)
})

test('frozen baseRef resolves to its exact remote branch', () => {
  assert.equal(frozenRemoteBase('origin/release/2.0 @ abc123'), 'origin/release/2.0')
  assert.equal(frozenRemoteBase('refs/remotes/origin/integration @ def456'), 'origin/integration')
  assert.equal(frozenRemoteBase(null), null)
  assert.equal(frozenBaseHash('origin/release/2.0 @ abc123'), 'abc123')
  assert.equal(frozenBaseHash(null), null)
})

test('first selection resolves origin/HEAD while a frozen baseline rejects replacement', () => {
  assert.equal(
    resolveSelectedRemoteBase({ requested: undefined, frozen: null, defaultRemoteBase: 'origin/main' }),
    'origin/main',
  )
  assert.equal(
    resolveSelectedRemoteBase({
      requested: undefined,
      frozen: 'origin/release/2.0 @ abc123',
      defaultRemoteBase: 'origin/main',
    }),
    'origin/release/2.0',
  )
  assert.equal(
    resolveSelectedRemoteBase({
      requested: 'origin/release/2.0',
      frozen: 'origin/release/2.0 @ abc123',
      defaultRemoteBase: 'origin/main',
    }),
    'origin/release/2.0',
  )
  assert.throws(
    () =>
      resolveSelectedRemoteBase({
        requested: 'origin/main',
        frozen: 'origin/release/2.0 @ abc123',
        defaultRemoteBase: 'origin/main',
      }),
    /基线已定格/,
  )
})

test('baseline preview keeps the default sentinel first and removes duplicate refs', () => {
  assert.deepEqual(
    baselinePreviewOptions('origin/main', ['origin/release/2.0', 'origin/main', 'origin/HEAD', 'origin/main']),
    ['origin/HEAD', 'origin/main', 'origin/release/2.0'],
  )
})

test('issue development branch baseline suggests the parent issue dependency', () => {
  assert.equal(baselineDependencyIssue('origin/clickvibe-issue-17'), 17)
  assert.equal(baselineDependencyIssue('origin/release/clickvibe-issue-18'), 18)
  assert.equal(baselineDependencyIssue('origin/release-2.0'), null)
})
