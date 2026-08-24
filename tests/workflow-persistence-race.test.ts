import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import test from 'node:test'
import { type IssueWorkflow, loadWorkflow, saveWorkflow, statePath, WorkflowConflictError } from '../src/infra/state.ts'
import { observeTaskOwnership, taskLaunchDecision } from '../src/infra/task-ownership.ts'
import { stopTask } from '../src/workflow/task-api.ts'

const workerSource = `
import { createInterface } from 'node:readline'
import { claimWorkflowTask, saveWorkflow, saveWorkflowForTask, WorkflowConflictError } from './src/infra/state.ts'
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
    const saved = input.claim
      ? (await claimWorkflowTask(input.workflow, input.claim, input.expectedRevision), true)
      : input.credential
      ? await saveWorkflowForTask(input.workflow, input.credential, input.expectedRevision)
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
        child.stdin.write(`${JSON.stringify({ workflow, credential, expectedRevision: workflow.revision ?? null })}\n`)
      }),
    claim: (workflow: IssueWorkflow, claim: { kind: 'dev'; taskId: string; agent: 'codex'; hostJobId: string }) =>
      new Promise<boolean>((resolve) => {
        responses.push((response) => resolve(Boolean(response.saved)))
        child.stdin.write(`${JSON.stringify({ workflow, claim, expectedRevision: workflow.revision ?? null })}\n`)
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

test('task credential and commit are indivisible across host processes', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-cas-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const staleWorker = await startWorker(tempHome)
  const successorWorker = await startWorker(tempHome)
  try {
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
      assert.doesNotThrow(() => JSON.parse(raw), `round ${round} exposed partial workflow JSON`)
      const persisted = await loadWorkflow(initial.key)
      assert.equal(persisted?.reviewTaskId, nextTaskId, `round ${round} let the stale host overwrite its successor`)
      assert.equal(persisted?.stage, 'reviewing')
    }
    const recovered = workflow('review-9999-before', 'recovered', 9999)
    await saveWorkflow(recovered, null)
    recovered.reviewTaskId = 'review-9999-recovered'
    await writeFile(`${statePath(recovered)}.lock`, JSON.stringify({ pid: 2_147_483_647, token: 'dead-host' }))
    await saveWorkflow(recovered, recovered.revision ?? 0)
    assert.equal((await loadWorkflow(recovered.key))?.reviewTaskId, recovered.reviewTaskId)
  } finally {
    staleWorker.process.stdin.end()
    successorWorker.process.stdin.end()
    await Promise.all([once(staleWorker.process, 'exit'), once(successorWorker.process, 'exit')])
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a stale resume controller cannot replace the current host reservation', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-resume-cas-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const slowController = await startWorker(tempHome)
  const currentController = await startWorker(tempHome)
  try {
    for (let round = 0; round < 100; round += 1) {
      const initial = workflow(`review-${round}-previous`, 'initial', 2000 + round)
      initial.stage = 'review-ready'
      await saveWorkflow(initial, null)

      const slowTaskId = `dev-${1000 + round}-slow`
      const slow = structuredClone(initial)

      const currentTaskId = `dev-${9000 + round}-current`
      const currentHostJobId = `job-${9000 + round}-current`
      const current = structuredClone(initial)

      assert.equal(
        await currentController.claim(current, {
          kind: 'dev',
          taskId: currentTaskId,
          agent: 'codex',
          hostJobId: currentHostJobId,
        }),
        true,
      )
      assert.equal(
        await slowController.claim(slow, {
          kind: 'dev',
          taskId: slowTaskId,
          agent: 'codex',
          hostJobId: `job-${1000 + round}-slow`,
        }),
        false,
      )

      const persisted = await loadWorkflow(initial.key)
      assert.ok(persisted)
      const jobs = {
        list: () => [
          {
            id: currentHostJobId,
            kind: 'clickvibe',
            label: `clickvibe:${initial.key}:dev:${currentTaskId}`,
            status: 'running' as const,
            startedAt: Date.now(),
          },
        ],
        get: () => {
          throw new Error('unknown job')
        },
      }
      const ownership = observeTaskOwnership({ jobs }, persisted, () => false)
      assert.equal(ownership.state, 'running', `round ${round} hid the current host reservation`)
      assert.equal(ownership.state === 'running' ? ownership.taskId : null, currentTaskId)
      assert.equal(taskLaunchDecision(ownership).allowed, false)

      if (round === 99) {
        const staleConfirmation = await stopTask({ jobs } as never, {
          taskId: slowTaskId,
          confirmedStopped: true,
        })
        assert.deepEqual(staleConfirmation, { ok: false, error: `未知任务 ${slowTaskId}` })
        const afterConfirmation = await loadWorkflow(initial.key)
        assert.ok(afterConfirmation)
        assert.equal(taskLaunchDecision(observeTaskOwnership({ jobs }, afterConfirmation, () => false)).allowed, false)
      }
    }
  } finally {
    slowController.process.stdin.end()
    currentController.process.stdin.end()
    await Promise.all([once(slowController.process, 'exit'), once(currentController.process, 'exit')])
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('two host processes running resumeDevelop launch only the winning generation', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-real-resume-cas-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const firstController = await startWorker(tempHome)
  const secondController = await startWorker(tempHome)
  try {
    for (let round = 0; round < 20; round += 1) {
      const initial = workflow(`review-${round}-previous`, 'initial', 3000 + round)
      initial.stage = 'developing'
      initial.worktree = tempHome
      initial.branch = `issue-${3000 + round}`
      initial.devAgent = 'codex'
      initial.devTaskId = `dev-${round}-interrupted`
      initial.devSessionId = null
      initial.devSessionAgent = null
      initial.devInterrupted = true
      initial.reviewTaskId = null
      initial.prNumber = null
      await saveWorkflow(initial, null)

      const [first, second] = await Promise.all([
        firstController.resume(initial.url),
        secondController.resume(initial.url),
      ])
      assert.equal(first.agentStarts + second.agentStarts, 1, `round ${round} launched more than one Agent`)
      assert.equal(
        Number(first.result.ok) + Number(second.result.ok),
        1,
        `round ${round} did not reject the stale controller`,
      )

      const persisted = await loadWorkflow(initial.key)
      assert.ok(persisted?.devTaskId)
      assert.ok(persisted.devHostJobId)
      assert.equal(persisted.stage, 'developing')
      const jobs = {
        list: () => [
          {
            id: persisted.devHostJobId!,
            kind: 'clickvibe',
            label: `clickvibe:${initial.key}:dev:${persisted.devTaskId}`,
            status: 'running' as const,
            startedAt: Date.now(),
          },
        ],
        get: () => {
          throw new Error('unknown job')
        },
      }
      assert.equal(observeTaskOwnership({ jobs }, persisted, () => false).state, 'running')
      assert.equal(taskLaunchDecision(observeTaskOwnership({ jobs }, persisted, () => false)).allowed, false)
    }
  } finally {
    const firstExit = once(firstController.process, 'exit')
    const secondExit = once(secondController.process, 'exit')
    firstController.process.kill()
    secondController.process.kill()
    await Promise.all([firstExit, secondExit])
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('revision conflict is distinct from corrupted persistence', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-workflow-errors-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  try {
    const current = workflow('review-5000-current', 'current', 5000)
    await saveWorkflow(current, null)

    const stale = structuredClone(current)
    stale.revision = 0
    await assert.rejects(() => saveWorkflow(stale, 0), WorkflowConflictError)

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
