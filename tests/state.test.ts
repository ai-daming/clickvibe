import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendLog,
  appendTaskLog,
  applyDevRunOutcome,
  clearStaleSessionId,
  readLogHistory,
  readTaskLog,
  recordSessionId,
  commitWorkflow,
  startTaskLog,
  resolveSessionForAgent,
  type IssueWorkflow,
} from '../src/infra/state.ts'

test('persistent log snapshots preserve append order without truncating history', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-log-order-'))
  process.env.HOME = tempHome
  try {
    const state = workflow()
    state.key = 'o-r-3'
    state.url = 'https://github.com/o/r/issues/3'
    state.devTaskId = 'dev-1720000000000-order'
    await commitWorkflow(state, state.revision ?? null)
    await startTaskLog(state, 'dev', state.devTaskId)
    const writes = Array.from({ length: 2100 }, (_, index) =>
      appendTaskLog(state, 'dev', state.devTaskId!, index + 1, `line-${index}`),
    )
    await Promise.all(writes)
    const lines = await readLogHistory('o-r-3', 'dev')
    assert.equal(lines.length, 2100)
    assert.equal(lines[0], 'line-0')
    assert.equal(lines[2099], 'line-2099')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a new task log generation preserves the prior run and selects the current run', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-log-reset-'))
  process.env.HOME = tempHome
  try {
    const state = workflow()
    state.key = 'o-r-4'
    state.url = 'https://github.com/o/r/issues/4'
    state.devTaskId = 'dev-1720000000000-prior'
    await commitWorkflow(state, state.revision ?? null)
    await startTaskLog(state, 'dev', state.devTaskId)
    await appendTaskLog(state, 'dev', state.devTaskId, 1, 'prior run')
    const priorTaskId = state.devTaskId
    state.devTaskId = 'dev-1720000005000-current'
    await commitWorkflow(state, state.revision ?? null)
    await startTaskLog(state, 'dev', state.devTaskId)
    await appendLog(state.key, 'dev', 'current one')
    await appendLog(state.key, 'dev', 'current two')
    assert.deepEqual(await readLogHistory(state.key, 'dev'), ['current one', 'current two'])
    assert.deepEqual((await readTaskLog(state, 'dev', priorTaskId)).lines, ['prior run'])
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

function workflow(): IssueWorkflow {
  return {
    key: 'o-r-17',
    url: 'https://github.com/o/r/issues/17',
    repoKey: 'o/r',
    worktree: '/worktrees/r-issue-17',
    branch: 'r-issue-17',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-1',
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
}

test('timed-out development keeps the captured session id for exact recovery', () => {
  const state = workflow()
  const completed = applyDevRunOutcome(state, 'timed_out', null, 'thread-123', 'codex')
  assert.equal(completed, false)
  assert.equal(state.devSessionId, 'thread-123')
  assert.equal(state.devSessionAgent, 'codex')
  assert.equal(state.devInterrupted, true)
  assert.equal(state.stage, 'developing')
  assert.equal(state.worktree, '/worktrees/r-issue-17')
})

test('stopped and failed development also keep the captured session id', () => {
  for (const [status, exitCode] of [
    ['stopped', null],
    ['failed', 2],
  ] as const) {
    const state = workflow()
    applyDevRunOutcome(state, status, exitCode, 'thread-123', 'codex')
    assert.equal(state.devSessionId, 'thread-123')
    assert.equal(state.devInterrupted, true)
  }
})

test('successful development becomes review-ready without changing its worktree', () => {
  const state = workflow()
  state.reviewResult = { passed: false, issues: ['old review'] }
  const completed = applyDevRunOutcome(state, 'done', 0, 'thread-123', 'codex')
  assert.equal(completed, true)
  assert.equal(state.stage, 'review-ready')
  assert.equal(state.devInterrupted, false)
  assert.equal(state.devSessionId, 'thread-123')
  assert.equal(state.reviewResult, null)
  assert.equal(state.worktree, '/worktrees/r-issue-17')
})

test('stale session cleanup covers dev and review without erasing a newer id', () => {
  const state = workflow()
  state.devSessionId = 'dead-dev'
  state.devSessionAgent = 'codex'
  state.reviewSessionId = 'dead-review'
  state.reviewSessionAgent = 'claude'
  assert.equal(clearStaleSessionId(state, 'dev', 'dead-dev'), true)
  assert.equal(state.devSessionId, null)
  assert.equal(state.devSessionAgent, null)
  assert.equal(clearStaleSessionId(state, 'review', 'dead-review'), true)
  assert.equal(state.reviewSessionId, null)
  assert.equal(state.reviewSessionAgent, null)

  state.reviewSessionId = 'new-review'
  state.reviewSessionAgent = 'codex'
  assert.equal(clearStaleSessionId(state, 'review', 'dead-review'), false)
  assert.equal(state.reviewSessionId, 'new-review')
  assert.equal(state.reviewSessionAgent, 'codex')
})

test('session ids are bound to their agent family and legacy ownership fails closed', () => {
  const state = workflow()
  recordSessionId(state, 'dev', 'claude-session', 'claude')
  assert.deepEqual(resolveSessionForAgent(state, 'dev', 'claude'), {
    sessionId: 'claude-session',
    invalid: false,
  })
  assert.deepEqual(resolveSessionForAgent(state, 'dev', 'codex'), {
    sessionId: null,
    invalid: true,
  })
  assert.equal(state.devSessionId, null)
  assert.equal(state.devSessionAgent, null)

  state.reviewSessionId = 'legacy-session'
  state.reviewSessionAgent = null
  assert.deepEqual(resolveSessionForAgent(state, 'review', 'codex'), {
    sessionId: null,
    invalid: true,
  })
})
