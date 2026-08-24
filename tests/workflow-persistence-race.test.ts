import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { finishTask, waitForTaskPersistence } from '../src/agent/task-supervisor.ts'
import { LineLog } from '../src/infra/develop-core.ts'
import { LineBuffer } from '../src/infra/line-buffer.ts'
import type { LiveTask } from '../src/infra/runtime.ts'
import {
  claimWorkflowTask,
  type IssueWorkflow,
  loadWorkflow,
  mutateWorkflowForTask,
  saveWorkflow,
  saveWorkflowForTask,
  statePath,
  WorkflowConflictError,
  type WorkflowTaskLease,
} from '../src/infra/state.ts'
import { observeTaskOwnership, workflowTaskExpectation } from '../src/infra/task-ownership.ts'
import { establishTaskClaim } from '../src/workflow/task-claim.ts'

const workerSource = `
import { createInterface } from 'node:readline'
import { saveWorkflow, saveWorkflowForTask, WorkflowConflictError } from './src/infra/state.ts'
import { resumeDevelop } from './src/workflow/resume.ts'
let agentStarts = 0
let jobSequence = 0
const jobs = []
const included = (body) => 'HTTP/2.0 200 OK\\n\\n' + JSON.stringify(body)
const ctx = {
  jobs: {
    list: () => jobs,
    get: (id) => jobs.find((job) => job.id === id),
    start: (spec) => {
      const id = 'job-' + process.pid + '-' + (++jobSequence)
      jobs.push({ id, kind: spec.kind, label: spec.label, status: 'running', startedAt: Date.now() })
      return id
    },
    kill: () => 'requested',
  },
  shell: {
    resolve: (spec) => spec,
    run: async (spec) => {
      const command = spec.command
      const issueNumber = command.match(/\\/issues\\/(\\d+)/)?.[1] ?? '0'
      const issue = {
        number: Number(issueNumber),
        html_url: 'https://github.com/owner/repo/issues/' + issueNumber,
        title: 'resume race', body: '', state: 'open',
        user: { login: 'owner' }, created_at: '', updated_at: '2026-08-24T00:00:00Z',
      }
      const body = /\\/issues\\?state=all/.test(command) ? [issue]
        : /\\/issues\\/\\d+\\/(?:comments|timeline)/.test(command) ? []
        : /\\/issues\\/\\d+/.test(command) ? issue : []
      return { exitCode: 0, stdout: { text: command.startsWith('gh api ') ? included(body) : '' }, stderr: { text: '' } }
    },
    start: () => {
      agentStarts += 1
      return { status: 'running', exitCode: null, done: new Promise(() => {}), readOutput: () => ({ delta: '', lossy: false }), kill: () => true }
    },
  },
}
console.log('ready')
for await (const line of createInterface({ input: process.stdin })) {
  const input = JSON.parse(line)
  try {
    if (input.resume) {
      const before = agentStarts
      const result = await resumeDevelop(ctx, { url: input.resume })
      console.log(JSON.stringify({ result, agentStarts: agentStarts - before }))
      continue
    }
    const saved = input.credential
      ? (await saveWorkflowForTask(input.workflow, input.credential, input.expectedRevision)).status === 'committed'
      : (await saveWorkflow(input.workflow, input.expectedRevision), true)
    console.log(JSON.stringify({ saved }))
  } catch (error) {
    console.log(JSON.stringify(error instanceof WorkflowConflictError
      ? { saved: false }
      : { error: String(error instanceof Error ? error.message : error) }))
  }
}
`

async function startWorker(home: string) {
  const child = spawn(process.execPath, ['--input-type=module', '--eval', workerSource], {
    cwd: process.cwd(),
    env: { ...process.env, HOME: home },
  })
  const responses: Array<(response: { saved?: boolean; result?: unknown; agentStarts?: number }) => void> = []
  const output = createInterface({ input: child.stdout })
  child.stderr.resume()
  await once(output, 'line')
  output.on('line', (line) => {
    responses.shift()?.(JSON.parse(line) as { saved?: boolean; result?: unknown; agentStarts?: number })
  })
  return {
    process: child,
    run: (workflow: IssueWorkflow, credential?: { kind: 'review'; taskId: string }) =>
      new Promise<boolean>((resolve) => {
        responses.push((response) => resolve(Boolean(response.saved)))
        child.stdin.write(
          `${JSON.stringify({
            workflow,
            credential: credential ? { ...credential, taskStateRevision: workflow.taskStateRevision ?? 0 } : undefined,
            expectedRevision: workflow.revision ?? null,
            expectedTaskStateRevision: workflow.taskStateRevision ?? 0,
          })}\n`,
        )
      }),
    resume: (url: string) =>
      new Promise<{ result: { ok: boolean; taskId?: string; error?: string }; agentStarts: number }>((resolve) => {
        responses.push((response) => resolve(response as never))
        child.stdin.write(`${JSON.stringify({ resume: url })}\n`)
      }),
  }
}

function workflow(taskId: string, marker: string, issueNumber: number): IssueWorkflow {
  return {
    key: `owner/repo/issue-${issueNumber}`,
    url: `https://github.com/owner/repo/issues/${issueNumber}`,
    repoKey: 'owner/repo',
    stage: 'reviewing',
    devTaskId: 'dev-1000-previous',
    reviewTaskId: taskId,
    updatedAt: 0,
    events: [{ kind: 'note', at: marker, note: marker.repeat(64 * 1024) }],
  } as IssueWorkflow
}

function testLease(
  workflow: Pick<IssueWorkflow, 'taskStateRevision'>,
  kind: 'dev' | 'review',
  taskId: string,
): WorkflowTaskLease {
  return { kind, taskId, taskStateRevision: workflow.taskStateRevision ?? 0 } as WorkflowTaskLease
}

test('cross-process task writes and resume claims preserve the winning generation', async (t) => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-cas-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const staleWorker = await startWorker(tempHome)
  const successorWorker = await startWorker(tempHome)
  try {
    await t.test('a stale task writer cannot replace its successor', async () => {
      for (let round = 0; round < 100; round += 1) {
        const oldTaskId = `review-${1000 + round}-old`
        const nextTaskId = `review-${9000 + round}-current`
        const initial = workflow(oldTaskId, 'initial', 1000 + round)
        await saveWorkflow(initial, null)
        const stale = structuredClone(initial)
        stale.stage = 'review-ready'
        stale.events[0].note = 'stale'.repeat(64 * 1024)
        const successor = workflow(nextTaskId, 'successor', 1000 + round)
        successor.revision = initial.revision
        assert.equal(await successorWorker.run(successor), true)
        assert.equal(await staleWorker.run(stale, { kind: 'review', taskId: oldTaskId }), false)
        const raw = await readFile(statePath(initial), 'utf8')
        assert.doesNotThrow(() => JSON.parse(raw))
        const persisted = await loadWorkflow(initial.key)
        assert.equal(persisted?.reviewTaskId, nextTaskId, `round ${round} let the stale host overwrite its successor`)
        assert.equal(persisted?.stage, 'reviewing')
      }
    })
    await t.test('competing resume controllers launch only the winner', async () => {
      for (let round = 0; round < 20; round += 1) {
        const initial = workflow(`review-${round}-previous`, 'initial', 3000 + round)
        Object.assign(initial, {
          stage: 'developing',
          worktree: tempHome,
          branch: `issue-${3000 + round}`,
          devAgent: 'codex',
          devTaskId: `dev-${round}-interrupted`,
          devSessionId: null,
          devSessionAgent: null,
          devInterrupted: true,
          reviewTaskId: null,
          prNumber: null,
        })
        await saveWorkflow(initial, null)
        const [first, second] = await Promise.all([
          staleWorker.resume(initial.url),
          successorWorker.resume(initial.url),
        ])
        const persisted = (await loadWorkflow(initial.key))!
        assert.equal(
          first.agentStarts + second.agentStarts,
          1,
          `round ${round} launched ${first.agentStarts + second.agentStarts} Agents: ${JSON.stringify({
            first,
            second,
            persisted: {
              stage: persisted.stage,
              devTaskId: persisted.devTaskId,
              devHostJobId: persisted.devHostJobId,
              devInterrupted: persisted.devInterrupted,
              revision: persisted.revision,
              taskStateRevision: persisted.taskStateRevision,
            },
          })}`,
        )
        const successful = [first, second].filter((entry) => entry.result.ok)
        assert.ok(successful.length >= 1, `round ${round} rejected both controllers`)
        assert.ok(
          successful.every((entry) => entry.result.taskId === persisted.devTaskId),
          `round ${round} returned a non-winning task: ${JSON.stringify({ first, second })}`,
        )
        assert.ok(persisted.devTaskId && persisted.devHostJobId)
        const job = {
          id: persisted.devHostJobId!,
          kind: 'clickvibe',
          label: `clickvibe:${initial.key}:dev:${persisted.devTaskId}`,
          status: 'running' as const,
          startedAt: Date.now(),
        }
        assert.equal(
          observeTaskOwnership({ jobs: { list: () => [job], get: () => job } }, persisted, () => false).state,
          'running',
        )
      }
    })
    const recovered = workflow('review-9999-before', 'recovered', 9999)
    await saveWorkflow(recovered, null)
    recovered.reviewTaskId = 'review-9999-recovered'
    await writeFile(`${statePath(recovered)}.lock`, JSON.stringify({ pid: 2_147_483_647, token: 'dead-host' }))
    await saveWorkflow(recovered, recovered.revision ?? 0)
    assert.equal((await loadWorkflow(recovered.key))?.reviewTaskId, recovered.reviewTaskId)
  } finally {
    const exits = [once(staleWorker.process, 'exit'), once(successorWorker.process, 'exit')]
    staleWorker.process.kill()
    successorWorker.process.kill()
    await Promise.all(exits)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('persistence keeps revision, capability, claim and I/O outcomes distinct', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-errors-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    const current = workflow('review-5000-current', 'current', 5000)
    await saveWorkflow(current, null)

    const stale = structuredClone(current)
    stale.revision = 0
    await assert.rejects(() => saveWorkflow(stale, 0), WorkflowConflictError)

    current.prNumber = '5000'
    await saveWorkflow(current, current.revision ?? 0)
    assert.deepEqual(
      await saveWorkflowForTask(stale, testLease(stale, 'review', stale.reviewTaskId!), stale.revision ?? 0),
      {
        status: 'revision-conflict',
        currentRevision: current.revision,
        currentTaskStateRevision: current.taskStateRevision,
      },
    )
    const successor = structuredClone(current)
    successor.reviewTaskId = 'review-7000-successor'
    await saveWorkflow(successor, successor.revision ?? 0)
    assert.deepEqual(
      await saveWorkflowForTask(stale, testLease(stale, 'review', stale.reviewTaskId!), current.revision ?? 0),
      {
        status: 'ownership-lost',
        currentRevision: successor.revision,
        currentTaskStateRevision: successor.taskStateRevision,
      },
    )

    const claimant = workflow('review-8100-interrupted', 'claim', 8100)
    claimant.stage = 'review-ready'
    await saveWorkflow(claimant, null)
    await assert.rejects(
      () =>
        claimWorkflowTask(
          claimant,
          { kind: 'review', taskId: 'invalid', agent: 'codex', hostJobId: null as never },
          claimant.revision ?? 0,
          workflowTaskExpectation(claimant),
        ),
      /hostJobId/,
    )
    const staleClaim = structuredClone(claimant)
    claimant.prNumber = '8100'
    await saveWorkflow(claimant, claimant.revision ?? 0)
    const claim = { kind: 'review' as const, taskId: 'review-9100-new', agent: 'codex' as const, hostJobId: 'job-9100' }
    const expectation = workflowTaskExpectation(staleClaim)
    const conflict = await claimWorkflowTask(staleClaim, claim, staleClaim.revision ?? 0, expectation)
    assert.deepEqual(conflict, {
      status: 'revision-conflict',
      currentRevision: claimant.revision,
      currentTaskStateRevision: claimant.taskStateRevision,
    })
    assert.equal(
      (await claimWorkflowTask(staleClaim, claim, conflict.currentRevision, expectation)).status,
      'committed',
    )
    assert.deepEqual(
      (({ reviewTaskId, reviewHostJobId, prNumber }) => ({ reviewTaskId, reviewHostJobId, prNumber }))(
        (await loadWorkflow(claimant.key))!,
      ),
      { reviewTaskId: claim.taskId, reviewHostJobId: claim.hostJobId, prNumber: '8100' },
    )

    await writeFile(statePath(current), '{broken json')
    await assert.rejects(
      () => saveWorkflow(current, current.revision ?? 0),
      (error: unknown) => error instanceof SyntaxError,
    )
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a completed task rejects late claim and stop intents from its previous lifecycle state', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-task-state-revision-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const running = workflow('review-unused', 'task-state', 8200)
  Object.assign(running, {
    stage: 'developing',
    devAgent: 'codex',
    devTaskId: 'dev-8200-running',
    devHostJobId: 'job-8200-running',
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewTaskId: null,
  })
  let losingTask: LiveTask | null = null
  try {
    await saveWorkflow(running, null)
    const staleClaim = structuredClone(running)
    const claimExpectation = workflowTaskExpectation(staleClaim)
    const staleStop = structuredClone(running)
    const completion = await mutateWorkflowForTask(
      running,
      testLease(running, 'dev', running.devTaskId!),
      (current) => {
        current.stage = 'review-ready'
        current.devSessionId = 'session-8200-completed'
        current.devSessionAgent = 'codex'
        current.devInterrupted = false
      },
    )
    assert.equal(completion.status, 'committed')
    assert.equal(running.taskStateRevision, 1)

    losingTask = {
      taskId: 'dev-9200-late-claim',
      workflowKey: running.key,
      workflow: staleClaim,
      kind: 'dev',
      agent: 'codex',
      startedAt: Date.now(),
      log: new LineLog(10),
      rawLog: new LineBuffer(),
      closed: false,
      status: 'running',
      exitCode: null,
      sessionId: null,
      workflowLease: null,
    }
    assert.deepEqual(
      await establishTaskClaim(
        staleClaim,
        losingTask,
        {
          kind: 'dev',
          taskId: losingTask.taskId,
          agent: 'codex',
          hostJobId: 'job-9200-late-claim',
          resetSession: true,
        },
        claimExpectation,
      ),
      { ok: true, claimed: false, taskId: 'dev-8200-running' },
    )
    assert.equal(losingTask.closed, true)
    assert.equal(losingTask.status, 'stopped')
    assert.equal(losingTask.sessionId, null)

    const lateStop = await mutateWorkflowForTask(
      staleStop,
      testLease(staleStop, 'dev', staleStop.devTaskId!),
      (current) => {
        current.stage = 'developing'
        current.devInterrupted = true
      },
    )
    assert.equal(lateStop.status, 'ownership-lost')
    const persisted = (await loadWorkflow(running.key))!
    assert.equal(persisted.stage, 'review-ready')
    assert.equal(persisted.devInterrupted, false)
    assert.equal(persisted.devTaskId, 'dev-8200-running')
    assert.equal(persisted.devHostJobId, 'job-8200-running')
    assert.equal(persisted.devSessionId, 'session-8200-completed')
    assert.equal(persisted.taskStateRevision, 1)
  } finally {
    if (losingTask) {
      if (losingTask.cleanup) clearTimeout(losingTask.cleanup)
      await waitForTaskPersistence(losingTask)
    }
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
