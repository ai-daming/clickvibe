import assert from 'node:assert/strict'
import test from 'node:test'
import { mapComments, mapIssueDetail, mapPrDetail } from '../src/github/reads.ts'

test('REST detail mappers preserve safe defaults for sparse issue records', () => {
  assert.deepEqual(mapComments([{ user: null, body: null }]), [
    { author: { login: 'unknown' }, createdAt: '', updatedAt: '', body: '' },
  ])
  assert.deepEqual(
    mapComments([{ user: { login: 'owner' }, body: 'note', created_at: 'created', updated_at: 'updated' }]),
    [{ author: { login: 'owner' }, createdAt: 'created', updatedAt: 'updated', body: 'note' }],
  )
  const mapped = mapIssueDetail(
    { number: 1, title: 'sparse', state: 'open', html_url: 'https://github.com/o/r/issues/1' },
    [],
  )
  assert.deepEqual(mapped, {
    number: 1,
    title: 'sparse',
    state: 'OPEN',
    stateReason: null,
    author: { login: 'unknown' },
    createdAt: '',
    updatedAt: '',
    closedAt: null,
    body: '',
    url: 'https://github.com/o/r/issues/1',
    labels: [],
    assignees: [],
    milestone: null,
    comments: [],
    reactionGroups: [],
    isPinned: false,
  })
})

test('REST issue mapper retains labels, assignees, milestone and audit fields', () => {
  const mapped = mapIssueDetail(
    {
      number: 2,
      title: 'full',
      state: 'closed',
      state_reason: 'completed',
      user: { login: 'author' },
      created_at: 'created',
      updated_at: 'updated',
      closed_at: 'closed',
      body: 'body',
      html_url: 'https://github.com/o/r/issues/2',
      labels: [{}, { name: 'bug', color: 'red' }],
      assignees: [{}, { login: 'owner' }],
      milestone: {},
    },
    [{ user: { login: 'commenter' }, body: 'comment' }],
  )
  assert.deepEqual(mapped.labels, [
    { name: '', color: undefined },
    { name: 'bug', color: 'red' },
  ])
  assert.deepEqual(mapped.assignees, [{ login: '' }, { login: 'owner' }])
  assert.deepEqual(mapped.milestone, { title: '', number: undefined })
  assert.equal(mapped.stateReason, 'completed')
})

test('REST PR mapper covers merged/open state, mergeability and request variants', () => {
  const base = {
    number: 3,
    title: 'PR',
    state: 'open',
    html_url: 'https://github.com/o/r/pull/3',
  }
  const sparse = mapPrDetail(base, [], [], {})
  assert.equal(sparse.state, 'OPEN')
  assert.equal(sparse.mergedAt, null)
  assert.equal(sparse.additions, 0)
  assert.equal(sparse.deletions, 0)
  assert.equal(sparse.changedFiles, 0)
  assert.deepEqual(sparse.commits, [])
  assert.equal(sparse.isDraft, false)
  assert.equal(sparse.mergeable, 'UNKNOWN')
  assert.equal(sparse.mergeStateStatus, 'UNKNOWN')
  assert.equal(sparse.baseRefName, '')
  assert.equal(sparse.headRefName, '')
  assert.deepEqual(sparse.reviewRequests, [])

  const merged = mapPrDetail(
    {
      ...base,
      state: 'closed',
      merged_at: 'merged',
      additions: 4,
      deletions: 2,
      changed_files: 3,
      commits: 2,
      draft: true,
      mergeable: true,
      mergeable_state: 'clean',
      base: { ref: 'release' },
      head: { ref: 'feature' },
    },
    [],
    [{ user: null, body: null, state: 'approved', submitted_at: null }],
    { users: [{}, { login: 'reviewer' }], teams: [{ slug: 'platform' }, { name: 'core' }] },
  )
  assert.equal(merged.state, 'MERGED')
  assert.equal((merged.commits as unknown[]).length, 2)
  assert.equal(merged.mergeable, 'MERGEABLE')
  assert.deepEqual(merged.reviewRequests, [
    { login: '' },
    { login: 'reviewer' },
    { name: 'platform' },
    { name: 'core' },
  ])
  assert.deepEqual(merged.reviews, [{ author: { login: 'unknown' }, body: '', state: 'APPROVED', submittedAt: null }])

  const conflicting = mapPrDetail({ ...base, mergeable: false, commits: -3 }, [], [], { users: [], teams: [] })
  assert.equal(conflicting.mergeable, 'CONFLICTING')
  assert.deepEqual(conflicting.commits, [])
})
