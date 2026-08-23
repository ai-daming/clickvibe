import assert from 'node:assert/strict'
import test from 'node:test'
import { authorizationSummary, expectedDevelopSnapshot } from '../src/client/dev-authorization.ts'

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
