import assert from 'node:assert/strict'
import test from 'node:test'
import {
  authorizationSummary,
  baselineDependencyHint,
  baselineOptionLabel,
  expectedDevelopSnapshot,
} from '../src/client/dev-authorization.ts'

test('develop authorization freezes the visible issue snapshot', () => {
  assert.deepEqual(
    expectedDevelopSnapshot('https://github.com/o/r/issues/61', {
      title: 'Split the monolith',
      body: 'Acceptance contract',
      state: 'open',
      updatedAt: '2026-08-23T05:22:11Z',
      comments: [{ author: { login: 'reviewer' }, body: 'Keep contracts stable' }],
    }),
    {
      url: 'https://github.com/o/r/issues/61',
      title: 'Split the monolith',
      body: 'Acceptance contract',
      state: 'OPEN',
      updatedAt: '2026-08-23T05:22:11Z',
      comments: [{ author: 'reviewer', body: 'Keep contracts stable' }],
    },
  )
})

test('authorization confirmation copy preserves develop, review and merge details', () => {
  const common = {
    url: 'https://github.com/o/r/issues/61',
    authorizationDigest: 'authorization-digest',
    preview: { digest: 'snapshot-digest', title: 'Issue #61', updatedAt: 'today', commentCount: 2 },
  } as const
  assert.match(authorizationSummary({ ...common, action: 'develop', agent: 'codex' }), /Issue #61/)
  assert.match(authorizationSummary({ ...common, action: 'review', agent: 'claude' }), /claude.*review/s)
  assert.match(
    authorizationSummary({
      ...common,
      action: 'merge',
      agent: null,
      preview: { ...common.preview, prNumber: '65', branch: 'issue-61', mergeFlag: '--merge', cleanup: ['worktree'] },
    }),
    /PR: #65.*issue-61.*worktree/s,
  )
})

test('develop authorization copy and selector labels expose the exact baseline', () => {
  const summary = authorizationSummary({
    action: 'develop',
    agent: 'codex',
    url: 'https://github.com/o/r/issues/60',
    authorizationDigest: 'authorization-digest',
    preview: {
      digest: 'snapshot-digest',
      title: 'Issue #60',
      baseline: 'origin/release/2.0',
      baselineOptions: ['origin/HEAD', 'origin/release/2.0'],
      baselineFrozen: false,
      baselineRef: null,
      baselineDependencyIssue: 17,
    },
  })
  assert.match(summary, /开发基线: origin\/release\/2\.0/)
  assert.equal(baselineOptionLabel('origin/HEAD'), 'origin/HEAD（默认）')
  assert.equal(baselineOptionLabel('origin/release/2.0'), 'origin/release/2.0')
  assert.equal(baselineDependencyHint(17), '建议补「依赖: Blocked by #17」')
  assert.equal(baselineDependencyHint(null), null)
})

test('authorization helpers preserve safe defaults for sparse GitHub and preview data', () => {
  assert.deepEqual(expectedDevelopSnapshot('https://github.com/o/r/issues/1', {}), {
    url: 'https://github.com/o/r/issues/1',
    title: '',
    body: '',
    state: '',
    updatedAt: '',
    comments: [],
  })
  assert.deepEqual(
    expectedDevelopSnapshot('https://github.com/o/r/issues/1', {
      comments: [{ author: null, body: null }],
    }),
    {
      url: 'https://github.com/o/r/issues/1',
      title: '',
      body: '',
      state: '',
      updatedAt: '',
      comments: [{ author: 'unknown', body: '' }],
    },
  )
  assert.match(
    authorizationSummary({
      action: 'develop',
      agent: 'codex',
      url: 'https://github.com/o/r/issues/1',
      authorizationDigest: 'authorization',
      preview: { digest: 'short' },
    }),
    /issues\/1.*更新时间: 未知.*评论: 0 条.*开发基线: origin\/HEAD/s,
  )
  assert.match(
    authorizationSummary({
      action: 'merge',
      agent: null,
      url: 'https://github.com/o/r/issues/1',
      authorizationDigest: 'authorization',
      preview: { digest: 'short' },
    }),
    /PR: #\?.*分支: \?.*--merge.*清理:/s,
  )
  assert.match(
    authorizationSummary({
      action: 'resume',
      agent: 'codex',
      url: 'https://github.com/o/r/issues/1',
      authorizationDigest: 'authorization',
      preview: { digest: 'short' },
    }),
    /codex.*resume.*issues\/1/s,
  )
  assert.equal(baselineDependencyHint(undefined), null)
})
