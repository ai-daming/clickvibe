import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { liveTasks } from '../src/infra/runtime.ts'
import { type IssueWorkflow, issueKey, loadWorkflow, saveWorkflow } from '../src/infra/state.ts'
import { resumeDevelop } from '../src/workflow/resume.ts'
import { startReview } from '../src/workflow/review-flow.ts'
import { stopTask } from '../src/workflow/task-api.ts'
import { createFakeJobs } from './fake-jobs.ts'

function included(body: unknown, status = 200): string {
  return [`HTTP/2.0 ${status} ${status === 200 ? 'OK' : 'Error'}`, '', JSON.stringify(body)].join('\n')
}

function issueResponse(url: string): Record<string, unknown> {
  return {
    number: 111,
    html_url: url,
    title: 'task generation race',
    body: '## 目标\n守住任务代次\n## 验收标准\n- [ ] 不允许旧回调覆盖新任务\n## 依赖\n无',
    state: 'open',
    user: { login: 'owner' },
    created_at: '2026-08-24T00:00:00Z',
    updated_at: '2026-08-24T00:00:00Z',
    closed_at: null,
    labels: [],
  }
}

function processHarness() {
  let settle!: () => void
  const done = new Promise<void>((resolve) => {
    settle = resolve
  })
  const handle = {
    status: 'running',
    exitCode: null as number | null,
    done,
    readOutput: () => ({ delta: '', lossy: false }),
    kill: () => true,
  }
  return { handle, settle }
}

function context(
  url: string,
  process: ReturnType<typeof processHarness>,
  onCommand?: (command: string) => Promise<void>,
) {
  return {
    jobs: createFakeJobs(),
    shell: {
      resolve: (spec: unknown) => spec,
      run: async (spec: { command: string }) => {
        const command = spec.command
        await onCommand?.(command)
        if (command.startsWith('gh api ')) {
          const body =
            command.includes('repos/owner/repo/issues/111') && !/comments|timeline/.test(command)
              ? issueResponse(url)
              : []
          return { exitCode: 0, stdout: { text: included(body) }, stderr: { text: '' } }
        }
        if (command === 'git rev-parse --short HEAD') {
          return { exitCode: 0, stdout: { text: 'abcdef1' }, stderr: { text: '' } }
        }
        if (command.includes('MERGE_HEAD')) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
        }
        if (command.startsWith('git rev-list --left-right --count')) {
          return { exitCode: 0, stdout: { text: '0 0' }, stderr: { text: '' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
      start: () => process.handle,
    },
  }
}

function commandBarrier(prefix: string) {
  let entered!: () => void
  let release!: () => void
  const waitUntilEntered = new Promise<void>((resolve) => {
    entered = resolve
  })
  const blocked = new Promise<void>((resolve) => {
    release = resolve
  })
  return {
    waitUntilEntered,
    release,
    onCommand: async (command: string) => {
      if (!command.startsWith(prefix)) return
      entered()
      await blocked
    },
  }
}

function workflow(worktree: string, stage: IssueWorkflow['stage']): IssueWorkflow {
  return {
    key: issueKey('owner/repo', '111'),
    url: 'https://github.com/owner/repo/issues/111',
    repoKey: 'owner/repo',
    worktree,
    branch: 'clickvibe-issue-111',
    stage,
    devAgent: 'codex',
    devTaskId: 'dev-1000-previous',
    devSessionId: 'dev-session',
    devSessionAgent: 'codex',
    devInterrupted: stage === 'developing',
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: null,
    prNumber: null,
    issueState: 'OPEN',
    baseRef: 'origin/main @ 82e55b2',
    updatedAt: Date.now(),
    events: [],
  }
}

async function waitForClosed(taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (liveTasks.get(taskId)?.closed) return
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error(`task ${taskId} did not close`)
}

async function waitForWorkflow(predicate: (workflow: IssueWorkflow | null) => boolean): Promise<IssueWorkflow> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const current = await loadWorkflow(issueKey('owner/repo', '111'))
    if (predicate(current) && current) return current
    await new Promise<void>((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('workflow did not reach the expected state')
}

test('a stopped review cannot overwrite a newer review generation when its process exits late', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-generation-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const worktree = join(tempHome, 'worktree')
  const processRun = processHarness()
  const ctx = context('https://github.com/owner/repo/issues/111', processRun)
  let retiredTaskId: string | null = null
  try {
    await mkdir(worktree, { recursive: true })
    await saveWorkflow(workflow(worktree, 'review-ready'))
    const started = await startReview(ctx as never, {
      url: 'https://github.com/owner/repo/issues/111',
      agent: 'codex',
    })
    assert.equal(started.ok, true)
    if (!started.ok) throw new Error(started.error)
    retiredTaskId = started.taskId
    assert.deepEqual(await stopTask(ctx as never, { taskId: retiredTaskId }), {
      ok: true,
      taskId: retiredTaskId,
      stopped: true,
    })

    const next = await waitForWorkflow(
      (current) => current?.reviewTaskId === retiredTaskId && current.stage === 'review-ready',
    )
    next.reviewTaskId = 'review-9000-current'
    next.reviewHostJobId = 'job-review-current'
    next.stage = 'reviewing'
    await saveWorkflow(next)

    processRun.handle.exitCode = 1
    processRun.settle()
    await waitForClosed(retiredTaskId)
    const persisted = await loadWorkflow(next.key)
    assert.equal(persisted?.reviewTaskId, 'review-9000-current')
    assert.equal(persisted?.stage, 'reviewing')
  } finally {
    if (retiredTaskId) liveTasks.delete(retiredTaskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a stopped resume cannot mark a newer development generation interrupted when its process exits late', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-generation-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const worktree = join(tempHome, 'worktree')
  const processRun = processHarness()
  const ctx = context('https://github.com/owner/repo/issues/111', processRun)
  let retiredTaskId: string | null = null
  try {
    await mkdir(worktree, { recursive: true })
    await saveWorkflow(workflow(worktree, 'developing'))
    const started = await resumeDevelop(ctx as never, { url: 'https://github.com/owner/repo/issues/111' })
    assert.equal(started.ok, true)
    if (!started.ok) throw new Error(started.error)
    retiredTaskId = started.taskId
    assert.deepEqual(await stopTask(ctx as never, { taskId: retiredTaskId }), {
      ok: true,
      taskId: retiredTaskId,
      stopped: true,
    })

    const next = await waitForWorkflow(
      (current) => current?.devTaskId === retiredTaskId && current.devInterrupted === true,
    )
    next.devTaskId = 'dev-9000-current'
    next.devHostJobId = 'job-dev-current'
    next.devInterrupted = false
    next.stage = 'developing'
    await saveWorkflow(next)

    processRun.handle.exitCode = 1
    processRun.settle()
    await waitForClosed(retiredTaskId)
    const persisted = await loadWorkflow(next.key)
    assert.equal(persisted?.devTaskId, 'dev-9000-current')
    assert.equal(persisted?.devInterrupted, false)
    assert.equal(persisted?.stage, 'developing')
  } finally {
    if (retiredTaskId) liveTasks.delete(retiredTaskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('an obsolete review parse failure cannot reset a newer review generation', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-review-parse-generation-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const worktree = join(tempHome, 'worktree')
  const processRun = processHarness()
  const ctx = context('https://github.com/owner/repo/issues/111', processRun)
  let retiredTaskId: string | null = null
  try {
    await mkdir(worktree, { recursive: true })
    await saveWorkflow(workflow(worktree, 'review-ready'))
    const started = await startReview(ctx as never, {
      url: 'https://github.com/owner/repo/issues/111',
      agent: 'codex',
    })
    assert.equal(started.ok, true)
    if (!started.ok) throw new Error(started.error)
    retiredTaskId = started.taskId

    const next = await loadWorkflow(issueKey('owner/repo', '111'))
    assert.ok(next)
    next.reviewTaskId = 'review-9100-current'
    next.reviewHostJobId = 'job-review-current'
    next.reviewResult = { passed: true, issues: [] }
    next.stage = 'reviewing'
    await saveWorkflow(next)

    processRun.handle.exitCode = 0
    processRun.settle()
    await waitForClosed(retiredTaskId)
    const persisted = await loadWorkflow(next.key)
    assert.equal(persisted?.reviewTaskId, 'review-9100-current')
    assert.deepEqual(persisted?.reviewResult, { passed: true, issues: [] })
    assert.equal(persisted?.stage, 'reviewing')
  } finally {
    if (retiredTaskId) liveTasks.delete(retiredTaskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})

test('a completed dev publication cannot overwrite a review generation started while publishing', async () => {
  const tempHome = await mkdtemp(join(tmpdir(), 'clickvibe-dev-publication-generation-'))
  const previousHome = process.env.HOME
  process.env.HOME = tempHome
  const worktree = join(tempHome, 'worktree')
  const processRun = processHarness()
  const publication = commandBarrier('gh issue comment ')
  const ctx = context('https://github.com/owner/repo/issues/111', processRun, publication.onCommand)
  let retiredTaskId: string | null = null
  try {
    await mkdir(worktree, { recursive: true })
    await saveWorkflow(workflow(worktree, 'developing'))
    const started = await resumeDevelop(ctx as never, { url: 'https://github.com/owner/repo/issues/111' })
    assert.equal(started.ok, true)
    if (!started.ok) throw new Error(started.error)
    retiredTaskId = started.taskId

    processRun.handle.exitCode = 0
    processRun.settle()
    await publication.waitUntilEntered
    const next = await waitForWorkflow(
      (current) => current?.devTaskId === retiredTaskId && current.stage === 'review-ready',
    )
    next.reviewTaskId = 'review-9200-current'
    next.reviewHostJobId = 'job-review-current'
    next.stage = 'reviewing'
    await saveWorkflow(next)
    publication.release()

    await waitForClosed(retiredTaskId)
    const persisted = await loadWorkflow(next.key)
    assert.equal(persisted?.reviewTaskId, 'review-9200-current')
    assert.equal(persisted?.stage, 'reviewing')
  } finally {
    publication.release()
    if (retiredTaskId) liveTasks.delete(retiredTaskId)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(tempHome, { recursive: true, force: true })
  }
})
