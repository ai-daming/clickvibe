import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { liveTasks } from '../src/infra/runtime.ts'
import { loadWorkflow, statePath, type IssueWorkflow } from '../src/infra/state.ts'
import { syncWorktree } from '../src/workflow/sync.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

test('sync rejects malformed targets and issues without a worktree before git access', async () => {
  const invalid = await syncWorktree({} as never, undefined)
  assert.equal(invalid.ok, false)
  if (!invalid.ok) assert.match(invalid.error, /请输入形如/)

  const pull = await syncWorktree({} as never, { url: 'https://github.com/o/r/pull/1' })
  assert.equal(pull.ok, false)
  if (!pull.ok) assert.match(pull.error, /请输入形如/)

  const missing = await syncWorktree({} as never, { url: 'https://github.com/o/r/issues/999999' })
  assert.equal(missing.ok, false)
  if (!missing.ok) assert.match(missing.error, /尚无 worktree/)
})

test('concurrent sync requests serialize one workflow baseline-tip update', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-lock-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  try {
    const worktree = join(root, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = {
      key: 'o-r-9',
      url: 'https://github.com/o/r/issues/9',
      repoKey: 'o/r',
      worktree,
      branch: 'r-issue-9',
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
    await saveWorkflow(workflow)
    let active = 0
    let maxActive = 0
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          active += 1
          maxActive = Math.max(maxActive, active)
          await new Promise((resolve) => setTimeout(resolve, 5))
          active -= 1
          if (spec.command.includes('MERGE_HEAD')) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
          }
          const stdout = spec.command.includes('origin/main^{commit}')
            ? 'aaa1111'
            : spec.command === 'git rev-parse --short HEAD'
              ? 'bbb2222'
              : ''
          return { exitCode: 0, stdout: { text: stdout }, stderr: { text: '' } }
        },
      },
    }
    const results = await Promise.all([
      syncWorktree(ctx as never, { url: workflow.url }),
      syncWorktree(ctx as never, { url: workflow.url }),
    ])
    assert.equal(
      results.every((result) => result.ok),
      true,
    )
    assert.equal(maxActive, 1)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('a failed merge does not advance the durable baseline tip', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-failed-merge-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  try {
    const worktree = join(root, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = {
      key: 'o-r-10',
      url: 'https://github.com/o/r/issues/10',
      repoKey: 'o/r',
      worktree,
      branch: 'r-issue-10',
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
    await saveWorkflow(workflow)
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          if (spec.command.includes('MERGE_HEAD')) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
          }
          if (spec.command.includes('origin/main^{commit}')) {
            return { exitCode: 0, stdout: { text: 'bbb1111' }, stderr: { text: '' } }
          }
          if (spec.command.startsWith('git merge --no-edit')) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'merge failed' } }
          }
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        },
      },
    }

    const result = await syncWorktree(ctx as never, { url: workflow.url })
    assert.equal(result.ok, false)
    assert.equal((await loadWorkflow(workflow.key))?.baseRef, 'origin/main @ aaa0000')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('sync merges the sampled immutable baseline commit instead of the mutable remote ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-sampled-tip-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  try {
    const worktree = join(root, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = {
      key: 'o-r-13',
      url: 'https://github.com/o/r/issues/13',
      repoKey: 'o/r',
      worktree,
      branch: 'r-issue-13',
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
    await saveWorkflow(workflow)
    const commands: string[] = []
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          commands.push(spec.command)
          if (spec.command.includes('MERGE_HEAD')) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
          }
          if (spec.command.includes('origin/main^{commit}')) {
            return { exitCode: 0, stdout: { text: 'bbb1111' }, stderr: { text: '' } }
          }
          if (spec.command === 'git rev-parse --verify HEAD') {
            return { exitCode: 0, stdout: { text: 'before222' }, stderr: { text: '' } }
          }
          if (spec.command === 'git rev-parse --short HEAD') {
            return { exitCode: 0, stdout: { text: 'head333' }, stderr: { text: '' } }
          }
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        },
      },
    }

    const result = await syncWorktree(ctx as never, { url: workflow.url })
    assert.equal(result.ok, true)
    assert.ok(commands.includes("git merge --no-edit 'bbb1111'"))
    assert.equal(commands.includes("git merge --no-edit 'origin/main'"), false)
    assert.equal((await loadWorkflow(workflow.key))?.baseRef, 'origin/main @ bbb1111')
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('sync rejects a concurrent live agent before touching git', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-live-agent-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  try {
    const worktree = join(root, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = {
      key: 'o-r-11',
      url: 'https://github.com/o/r/issues/11',
      repoKey: 'o/r',
      worktree,
      branch: 'r-issue-11',
      stage: 'developing',
      devAgent: 'codex',
      devTaskId: 'dev-live-11',
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
    await saveWorkflow(workflow)
    liveTasks.set(workflow.devTaskId, { closed: false } as never)
    let gitCalls = 0
    const result = await syncWorktree(
      {
        shell: {
          resolve(spec: unknown) {
            return spec
          },
          async run() {
            gitCalls += 1
            return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
          },
        },
      } as never,
      { url: workflow.url },
    )
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /Agent 任务仍运行或状态未知/)
    assert.equal(gitCalls, 0)
  } finally {
    liveTasks.delete('dev-live-11')
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('sync rolls git back when baseline-tip persistence fails after merge', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-persist-failure-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  let workflowFile = ''
  try {
    const worktree = join(root, 'worktree')
    await mkdir(worktree, { recursive: true })
    const workflow = {
      key: 'o-r-12',
      url: 'https://github.com/o/r/issues/12',
      repoKey: 'o/r',
      worktree,
      branch: 'r-issue-12',
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
    await saveWorkflow(workflow)
    workflowFile = statePath(workflow)
    const commands: string[] = []
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          commands.push(spec.command)
          if (spec.command.includes('MERGE_HEAD')) {
            return { exitCode: 1, stdout: { text: '' }, stderr: { text: '' } }
          }
          if (spec.command.includes('origin/main^{commit}')) {
            return { exitCode: 0, stdout: { text: 'bbb1111' }, stderr: { text: '' } }
          }
          if (spec.command === 'git rev-parse --verify HEAD') {
            return { exitCode: 0, stdout: { text: 'before222' }, stderr: { text: '' } }
          }
          if (spec.command.startsWith('git merge --no-edit')) await chmod(dirname(workflowFile), 0o500)
          if (spec.command.startsWith('git reset --hard')) {
            await chmod(dirname(workflowFile), 0o700)
          }
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        },
      },
    }

    const result = await syncWorktree(ctx as never, { url: workflow.url })
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /持久化失败,已回滚同步提交/)
    assert.equal(commands.includes("git reset --hard 'before222'"), true)
    assert.equal((await loadWorkflow(workflow.key))?.baseRef, 'origin/main @ aaa0000')
  } finally {
    if (workflowFile) await chmod(dirname(workflowFile), 0o700).catch(() => undefined)
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
