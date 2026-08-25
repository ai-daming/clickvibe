import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { pushTaskLine } from '../src/agent/task-supervisor.ts'
import { LineLog } from '../src/infra/develop-core.ts'
import { type LiveTask, liveTasks, liveWaiters } from '../src/infra/runtime.ts'
import { loadWorkflow, startTaskLog, type IssueWorkflow } from '../src/infra/state.ts'
import { getTaskHistory, handleStream, pollDevelop, resolveHistoryTarget, stopTask } from '../src/workflow/task-api.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

function liveTask(overrides: Partial<LiveTask> = {}): LiveTask {
  return {
    taskId: 'dev-direct',
    workflowKey: 'o-r-1',
    workflow: workflow('o-r-1'),
    kind: 'dev',
    agent: 'codex',
    log: new LineLog(20),
    rawLog: new LineLog(20),
    rawCursor: 0,
    closed: false,
    status: 'running',
    exitCode: null,
    sessionId: null,
    ...overrides,
  }
}

function workflow(key: string): IssueWorkflow {
  return {
    key,
    url: `https://github.com/o/r/issues/${key.split('-').at(-1)}`,
    repoKey: 'o/r',
    worktree: '/tmp/worktree',
    branch: `${key}-branch`,
    stage: 'reviewing',
    devAgent: 'codex',
    devTaskId: 'dev-stored',
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: 'review-stored',
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ abc123',
    updatedAt: 0,
    events: [],
  }
}

function fakeStream(taskId: string, options: { cursor?: string; lastEventId?: string | string[] } = {}) {
  const req = new EventEmitter() as IncomingMessage
  req.url = `/stream?taskId=${taskId}${options.cursor === undefined ? '' : `&cursor=${options.cursor}`}`
  req.headers = options.lastEventId === undefined ? {} : { 'last-event-id': options.lastEventId }
  const writes: string[] = []
  let ended = false
  const res = {
    writeHead() {
      return this
    },
    write(value: string) {
      writes.push(value)
      return true
    },
    end(value?: string) {
      if (value) writes.push(value)
      ended = true
      return this
    },
  } as unknown as ServerResponse
  return { req, res, writes, ended: () => ended }
}

test('poll and history resolve live, persisted and invalid task targets', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-task-api-'))
  process.env.HOME = home
  const live = liveTask()
  liveTasks.set(live.taskId, live)
  try {
    pushTaskLine(live, '[clickvibe] ready')
    assert.match(((await pollDevelop(undefined)) as { error: string }).error, /未知任务/)
    const first = await pollDevelop({ taskId: live.taskId, cursor: 'invalid' })
    assert.equal(first.ok, true)
    if (first.ok) {
      assert.deepEqual(first.delta, ['[clickvibe] ready'])
      assert.equal(first.done, false)
    }
    assert.deepEqual(await resolveHistoryTarget(live.taskId, '', ''), {
      taskId: live.taskId,
      key: live.workflowKey,
      kind: 'dev',
      live,
      workflow: live.workflow,
    })

    await mkdir(join(home, '.clickvibe'), { recursive: true })
    const stored = workflow('o-r-2')
    await saveWorkflow(stored)
    await startTaskLog(stored, 'review', 'review-stored')
    const reviewTarget = await resolveHistoryTarget('review-stored', '', '')
    assert.equal(reviewTarget?.kind, 'review')
    assert.equal(reviewTarget?.live, null)
    assert.equal(await resolveHistoryTarget('missing', '', ''), null)
    assert.equal(await resolveHistoryTarget('', '../bad', 'dev'), null)
    assert.equal(await resolveHistoryTarget('', stored.key, 'other'), null)
    assert.equal(await resolveHistoryTarget('', 'o-r-missing', 'dev'), null)
    const byKey = await resolveHistoryTarget('', stored.key, 'dev')
    assert.equal(byKey?.taskId, 'dev-stored')

    const req = { url: '/history' } as IncomingMessage
    assert.deepEqual(await getTaskHistory(req), { ok: false, error: '找不到对应任务历史' })
  } finally {
    liveTasks.delete(live.taskId)
    liveWaiters.delete(live.taskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})

test('stream flushes closed tasks, rejects truncated cursors and cleans open waiters', () => {
  const closed = liveTask({ taskId: 'closed-direct', closed: true, status: 'done', exitCode: 0 })
  closed.log.appendLine('[clickvibe] complete')
  liveTasks.set(closed.taskId, closed)
  const closedStream = fakeStream(closed.taskId, { cursor: '-1', lastEventId: ['invalid'] })
  handleStream(closedStream.req, closedStream.res)
  assert.equal(closedStream.ended(), true)
  assert.match(closedStream.writes.join(''), /complete/)
  assert.match(closedStream.writes.join(''), /__done/)

  const truncated = liveTask({ taskId: 'truncated-direct', log: new LineLog(1) })
  truncated.log.appendLine('first')
  truncated.log.appendLine('second')
  liveTasks.set(truncated.taskId, truncated)
  const truncatedStream = fakeStream(truncated.taskId)
  handleStream(truncatedStream.req, truncatedStream.res)
  assert.equal(truncatedStream.ended(), true)
  assert.match(truncatedStream.writes.join(''), /__historyRequired/)

  const open = liveTask({ taskId: 'open-direct' })
  liveTasks.set(open.taskId, open)
  const openStream = fakeStream(open.taskId, { lastEventId: '0' })
  handleStream(openStream.req, openStream.res)
  assert.equal(openStream.ended(), false)
  assert.equal(liveWaiters.get(open.taskId)?.size, 1)
  openStream.req.emit('close')
  assert.equal(liveWaiters.has(open.taskId), false)

  for (const task of [closed, truncated, open]) liveTasks.delete(task.taskId)
})

test('stop handles closed, process-backed and process-less tasks and persists stage recovery', async () => {
  const previousHome = process.env.HOME
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-stop-task-'))
  process.env.HOME = home
  try {
    assert.match((stopTask(undefined) as { error: string }).error, /未知任务/)
    const closed = liveTask({ taskId: 'already-closed', closed: true, status: 'done' })
    liveTasks.set(closed.taskId, closed)
    assert.deepEqual(stopTask({ taskId: closed.taskId }), { ok: true, taskId: closed.taskId, stopped: false })

    const devWorkflow = workflow('o-r-3')
    await saveWorkflow(devWorkflow)
    let killed = 0
    const running = liveTask({
      taskId: 'running-process',
      workflowKey: devWorkflow.key,
      process: {
        kill: () => {
          killed += 1
          return killed === 1
        },
      } as LiveTask['process'],
    })
    liveTasks.set(running.taskId, running)
    assert.deepEqual(stopTask({ taskId: running.taskId }), { ok: true, taskId: running.taskId, stopped: true })
    assert.equal(killed, 1)

    const reviewWorkflow = workflow('o-r-4')
    await saveWorkflow(reviewWorkflow)
    const processless = liveTask({ taskId: 'processless-review', workflowKey: reviewWorkflow.key, kind: 'review' })
    liveTasks.set(processless.taskId, processless)
    assert.deepEqual(stopTask({ taskId: processless.taskId }), {
      ok: true,
      taskId: processless.taskId,
      stopped: false,
    })
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal((await loadWorkflow(devWorkflow.key))?.devInterrupted, true)
    assert.equal((await loadWorkflow(reviewWorkflow.key))?.stage, 'review-ready')

    for (const task of [closed, running, processless]) {
      if (task.cleanup) clearTimeout(task.cleanup)
      liveTasks.delete(task.taskId)
      liveWaiters.delete(task.taskId)
    }
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(home, { recursive: true, force: true })
  }
})
