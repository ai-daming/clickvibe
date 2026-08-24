import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { loadWorkflow, saveWorkflow } from '../src/infra/state.ts'
import { stopTask } from '../src/workflow/task-api.ts'

test('stop API turns a pre-restart legacy task into a recoverable interruption', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-stop-legacy-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: tempHome,
    branch: 'clickvibe-issue-111',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-1-legacy',
    devSessionId: 'legacy-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: null,
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  try {
    await saveWorkflow(workflow)
    const result = await stopTask(
      {
        jobs: {
          list: () => [],
          get: () => {
            throw new Error('not used')
          },
        },
      } as never,
      { taskId: workflow.devTaskId },
    )
    assert.deepEqual(result, { ok: true, taskId: 'dev-1-legacy', stopped: false })
    const recovered = await loadWorkflow(workflow.key)
    assert.equal(recovered?.stage, 'developing')
    assert.equal(recovered?.devInterrupted, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
