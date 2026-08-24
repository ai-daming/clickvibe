import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadWorkflow, type IssueWorkflow, saveWorkflow } from '../src/infra/state.ts'
import { finalizeDevRun } from '../src/workflow/dev-completion.ts'

function workflow(): IssueWorkflow {
  return {
    key: 'o-r-106',
    url: 'https://github.com/o/r/issues/106',
    repoKey: 'o/r',
    worktree: '/worktrees/r-issue-106',
    branch: 'r-issue-106',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-106',
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: { passed: false, issues: ['fixed'] },
    prNumber: '105',
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc',
    updatedAt: 1,
    events: [],
  }
}

test('successful dev completion is durable before slow delivery work begins', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-completion-'))
  process.env.HOME = tempHome
  try {
    const current = workflow()
    await saveWorkflow(current)
    let deliveryStarted = false
    const completed = await finalizeDevRun(current, current.devTaskId!, 'done', 0, 'session-106', 'codex', async () => {
      deliveryStarted = true
      const visible = await loadWorkflow(current.key)
      assert.equal(visible?.stage, 'review-ready')
      assert.equal(visible?.devInterrupted, false)
      assert.equal(visible?.reviewResult, null)
    })

    assert.equal(completed, true)
    assert.equal(deliveryStarted, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
