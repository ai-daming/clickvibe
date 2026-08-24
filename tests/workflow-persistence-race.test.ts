import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  type IssueWorkflow,
  loadWorkflow,
  saveWorkflowForTask,
  saveWorkflowStrict,
  statePath,
} from '../src/infra/state.ts'

function workflow(taskId: string, marker: string): IssueWorkflow {
  return {
    key: 'owner/repo/issue-111',
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree: '/tmp/clickvibe-issue-111',
    branch: 'clickvibe-issue-111',
    stage: 'reviewing',
    devAgent: 'codex',
    devTaskId: 'dev-1000-previous',
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: taskId,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: '114',
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: 0,
    events: [{ kind: 'note', at: marker, note: marker.repeat(64 * 1024) }],
  }
}

test('credentialed workflow writes cannot cross the successor commit or expose partial JSON', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-cas-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    for (let round = 0; round < 100; round += 1) {
      const oldTaskId = `review-${1000 + round}-old`
      const nextTaskId = `review-${9000 + round}-current`
      const initial = workflow(oldTaskId, 'initial')
      await saveWorkflowStrict(initial)

      const stale = structuredClone(initial)
      stale.stage = 'review-ready'
      stale.events[0].note = 'stale'.repeat(64 * 1024)
      const successor = workflow(nextTaskId, 'successor')
      if (round % 2 === 0) {
        const staleWrite = saveWorkflowForTask(stale, { kind: 'review', taskId: oldTaskId })
        await new Promise<void>((resolve) => setTimeout(resolve, round % 4))
        await Promise.all([staleWrite, saveWorkflowStrict(successor)])
      } else {
        await saveWorkflowStrict(successor)
        assert.equal(await saveWorkflowForTask(stale, { kind: 'review', taskId: oldTaskId }), false)
      }

      const raw = await readFile(statePath(successor), 'utf8')
      assert.doesNotThrow(() => JSON.parse(raw), `round ${round} exposed partial workflow JSON`)
      const persisted = await loadWorkflow(successor.key)
      assert.equal(persisted?.reviewTaskId, nextTaskId, `round ${round} let the stale task overwrite its successor`)
      assert.equal(persisted?.stage, 'reviewing')
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
