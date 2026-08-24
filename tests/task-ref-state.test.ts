import assert from 'node:assert/strict'
import test from 'node:test'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { deriveWorkflowState } from '../src/workflow/derive.ts'

test('state exposes the ownership-selected task after the persisted stage has advanced', async () => {
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: '/missing/clickvibe-task-ref-worktree',
    branch: 'clickvibe-issue-111',
    stage: 'passed',
    devAgent: 'codex',
    devTaskId: 'dev-1000-old',
    devSessionId: 'dev-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: 'review-2000-current',
    reviewSessionId: 'review-session',
    reviewSessionAgent: 'codex',
    reviewResult: { passed: true, issues: [] },
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  const observed = await deriveWorkflowState(
    {
      jobs: {
        list(): never {
          throw new Error('registry offline')
        },
        get(): never {
          throw new Error('registry offline')
        },
      },
    } as never,
    workflow,
  )

  assert.equal(observed.derived.status, 'task-unknown')
  assert.deepEqual(observed.derived.taskRef, { kind: 'review', taskId: 'review-2000-current' })
})
