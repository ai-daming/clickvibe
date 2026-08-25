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

test('state exposes the current task reference when its host job is terminal', async () => {
  const workflow: IssueWorkflow = {
    key: 'owner-repo-111-terminal',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: '/missing/clickvibe-task-ref-terminal',
    branch: 'clickvibe-issue-111',
    stage: 'reviewing',
    devAgent: 'codex',
    devTaskId: 'dev-1000-old',
    devSessionId: 'dev-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: 'review-3000-current',
    reviewHostJobId: 'job-review-current',
    reviewSessionId: 'review-session',
    reviewSessionAgent: 'codex',
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
  const terminalJob = {
    id: 'job-review-current',
    kind: 'clickvibe-agent',
    label: `clickvibe:${workflow.key}:review:${workflow.reviewTaskId}`,
    status: 'failed' as const,
    startedAt: 3_000,
  }
  const observed = await deriveWorkflowState(
    { jobs: { list: () => [terminalJob], get: () => terminalJob } } as never,
    workflow,
  )

  assert.equal(observed.derived.status, 'interrupted')
  assert.deepEqual(observed.derived.taskRef, { kind: 'review', taskId: 'review-3000-current' })
})
