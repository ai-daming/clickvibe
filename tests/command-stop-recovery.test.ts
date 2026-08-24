import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { issueKey, loadWorkflow, saveWorkflow, type IssueWorkflow } from '../src/infra/state.ts'
import { handleCommand } from '../src/workflow/handlers.ts'

const request = {
  socket: { remoteAddress: '127.0.0.1' },
  headers: {
    host: '127.0.0.1:3080',
    origin: 'http://127.0.0.1:3080',
    'x-clickvibe-request': '1',
  },
} as unknown as IncomingMessage

function workflowFixture(key: string, home: string): IssueWorkflow {
  return {
    key,
    url: 'https://github.com/o/r/issues/111',
    repoKey: 'o/r',
    worktree: join(home, 'worktree'),
    branch: 'clickvibe-issue-111',
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-1000-legacy',
    devSessionId: 'legacy-dev-session',
    devSessionAgent: 'codex',
    devInterrupted: false,
    reviewAgent: 'codex',
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
}

async function runCommand(
  payload: Record<string, unknown>,
  ctx: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const result = await handleCommand(ctx as never, request, payload)
  return { status: result.status, body: result.body as Record<string, unknown> }
}

test('stop command explicitly confirms task-unknown dev and review through the shared stop action', async () => {
  const previousHome = process.env.HOME
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-cmd-stop-unknown-'))
  process.env.HOME = tempHome
  try {
    await mkdir(join(tempHome, '.clickvibe'), { recursive: true })
    await writeFile(join(tempHome, '.clickvibe', 'config.yaml'), `repos:\n  o/r: ${join(tempHome, 'repo')}\n`)
    const key = issueKey('o/r', '111')
    await saveWorkflow(workflowFixture(key, tempHome))

    const preview = await runCommand({ command: 'stop #111' })
    assert.equal(preview.status, 200, JSON.stringify(preview.body))
    assert.equal(preview.body.needsConfirmation, true)
    assert.match(String(preview.body.text), /无法确认旧任务生死/)
    assert.equal((preview.body.confirmation as { confirmedStopped?: boolean }).confirmedStopped, true)
    assert.equal((await loadWorkflow(key))?.devInterrupted, false)

    const confirmed = await runCommand({ command: 'stop #111', confirmedStopped: true })
    assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body))
    assert.equal(confirmed.body.taskId, 'dev-1000-legacy')
    const recovered = await loadWorkflow(key)
    assert.equal(recovered?.devInterrupted, true)

    if (!recovered) throw new Error('workflow missing after development confirmation')
    recovered.stage = 'reviewing'
    recovered.reviewTaskId = 'review-2000-legacy'
    await saveWorkflow(recovered)
    const reviewPreview = await runCommand({ command: 'stop #111' })
    assert.equal(reviewPreview.body.needsConfirmation, true)
    assert.equal(reviewPreview.body.taskId, 'review-2000-legacy')
    const reviewConfirmed = await runCommand({ command: 'stop #111', confirmedStopped: true })
    assert.equal(reviewConfirmed.status, 200, JSON.stringify(reviewConfirmed.body))
    assert.equal((await loadWorkflow(key))?.stage, 'review-ready')

    const settling = await loadWorkflow(key)
    if (!settling) throw new Error('workflow missing before stage-advanced recovery')
    settling.stage = 'review-ready'
    settling.devTaskId = 'dev-3000-settling'
    settling.devHostJobId = 'host-dev-3000'
    settling.devInterrupted = false
    await saveWorkflow(settling)
    const registryOffline = {
      jobs: {
        list(): never {
          throw new Error('registry offline')
        },
        get(): never {
          throw new Error('registry offline')
        },
      },
    }
    const settlingPreview = await runCommand({ command: 'stop #111' }, registryOffline)
    assert.equal(settlingPreview.status, 200, JSON.stringify(settlingPreview.body))
    assert.equal(settlingPreview.body.needsConfirmation, true)
    assert.equal(settlingPreview.body.taskId, 'dev-3000-settling')
    const settlingConfirmed = await runCommand({ command: 'stop #111', confirmedStopped: true }, registryOffline)
    assert.equal(settlingConfirmed.status, 200, JSON.stringify(settlingConfirmed.body))
    assert.equal(settlingConfirmed.body.taskId, 'dev-3000-settling')
    assert.equal((await loadWorkflow(key))?.devInterrupted, true)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
