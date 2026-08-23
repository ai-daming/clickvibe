import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { loadWorkflow, saveWorkflowStrict, type IssueWorkflow } from '../src/infra/state.ts'
import { mutateWorkflowStrict } from '../src/infra/workflow-mutation.ts'
import { withWorkflowLock } from '../src/infra/workflow-lock.ts'

test('a queued workflow mutation reloads state instead of overwriting a newer baseline tip', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-mutation-'))
  const previousHome = process.env.HOME
  process.env.HOME = home
  try {
    const workflow = {
      key: 'o-r-11',
      url: 'https://github.com/o/r/issues/11',
      repoKey: 'o/r',
      worktree: join(home, 'worktree'),
      branch: 'r-issue-11',
      stage: 'review-ready',
      devAgent: 'codex',
      devTaskId: null,
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
      baseRef: 'origin/main @ aaa0000',
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await saveWorkflowStrict(workflow)

    const advancing = withWorkflowLock(workflow.key, async () => {
      const current = await loadWorkflow(workflow.key)
      assert.ok(current)
      current.baseRef = 'origin/main @ bbb1111'
      await new Promise((resolve) => setTimeout(resolve, 10))
      await saveWorkflowStrict(current)
    })
    const reviewing = mutateWorkflowStrict(workflow.key, (current) => {
      current.stage = 'reviewing'
      current.reviewTaskId = 'review-1'
    })
    await Promise.all([advancing, reviewing])

    const saved = await loadWorkflow(workflow.key)
    assert.equal(saved?.baseRef, 'origin/main @ bbb1111')
    assert.equal(saved?.stage, 'reviewing')
    assert.equal(saved?.reviewTaskId, 'review-1')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
