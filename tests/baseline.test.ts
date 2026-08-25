import assert from 'node:assert/strict'
import test from 'node:test'
import {
  baselineDependencyIssue,
  baselinePreviewOptions,
  frozenBaseHash,
  frozenRemoteBase,
  requestedRemoteBase,
  resolveSelectedRemoteBase,
  updateBaseTip,
} from '../src/workflow/baseline.ts'
import { githubCompareUrl, workflowBaseBranch } from '../src/workflow/state-view.ts'

test('baseline request accepts only origin refs and keeps origin/HEAD as the default sentinel', () => {
  assert.equal(requestedRemoteBase(undefined), 'origin/HEAD')
  assert.equal(requestedRemoteBase(' origin/HEAD '), 'origin/HEAD')
  assert.equal(requestedRemoteBase('origin/release/2.0'), 'origin/release/2.0')
  assert.equal(requestedRemoteBase('origin/发布/二期'), 'origin/发布/二期')
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

test('base tip may advance while its selected branch identity stays immutable', () => {
  assert.equal(
    updateBaseTip('origin/release/2.0 @ aaa1111', 'origin/release/2.0', 'bbb2222'),
    'origin/release/2.0 @ bbb2222',
  )
  assert.throws(
    () => updateBaseTip('origin/release/2.0 @ aaa1111', 'origin/integration', 'bbb2222'),
    /基线分支身份.*拒绝更新/,
  )
  assert.throws(() => updateBaseTip('origin/release/2.0 @ aaa1111', 'origin/release/2.0', 'not-a-sha'), /提交/)
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
  assert.deepEqual(baselinePreviewOptions('invalid', ['origin/main', 'local', 'origin/../bad']), [
    'origin/HEAD',
    'origin/main',
  ])
  assert.deepEqual(baselinePreviewOptions('origin/main', ['origin/main', 'origin/发布/二期']), [
    'origin/HEAD',
    'origin/main',
    'origin/发布/二期',
  ])
})

test('issue development branch baseline suggests the parent issue dependency', () => {
  assert.equal(baselineDependencyIssue('origin/clickvibe-issue-17'), 17)
  assert.equal(baselineDependencyIssue('origin/release/clickvibe-issue-18'), 18)
  assert.equal(baselineDependencyIssue('origin/release-2.0'), null)
  assert.equal(baselineDependencyIssue('origin/clickvibe-issue-0'), null)
  assert.equal(baselineDependencyIssue('origin/clickvibe-issue-999999999999999999999999'), null)
})

test('compare URL always targets the selected baseline branch', () => {
  assert.equal(workflowBaseBranch('origin/trunk @ abc123', 'main'), 'trunk')
  assert.equal(
    githubCompareUrl('o/r', 'feature/7', 'origin/trunk @ abc123', 'main'),
    'https://github.com/o/r/compare/trunk...feature%2F7?expand=1',
  )
  assert.equal(
    githubCompareUrl('o/r', 'feature/7', 'origin/trunk @ abc123', 'main', false),
    'https://github.com/o/r/compare/trunk...feature%2F7?expand=1',
  )
})
