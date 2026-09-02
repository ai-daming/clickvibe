import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createLiveTask, finishTask } from '../src/agent/task-supervisor.ts'
import {
  commitWorkflowMetadata,
  issueKey,
  loadWorkflow,
  type IssueWorkflow,
  WorkflowConflictError,
} from '../src/infra/state.ts'
import { workflowTaskExpectation } from '../src/infra/task-ownership.ts'
import { restoreBaseBranch } from '../src/workflow/baseline-restore.ts'
import { recordDevDelivery } from '../src/workflow/dev-delivery.ts'
import { syncWorktree } from '../src/workflow/sync.ts'
import { establishTaskClaim } from '../src/workflow/task-claim.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const execFileAsync = promisify(execFile)
const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

function realShellCtx() {
  return {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; workdir?: string }) {
        if (spec.command.startsWith('gh ')) {
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        }
        try {
          const out = await execFileAsync('/bin/sh', ['-c', spec.command], { cwd: spec.workdir, encoding: 'utf8' })
          return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
        } catch (error) {
          const detail = error as { code?: number; stdout?: string; stderr?: string }
          return {
            exitCode: detail.code ?? 1,
            stdout: { text: detail.stdout ?? '' },
            stderr: { text: detail.stderr ?? '' },
          }
        }
      },
    },
  }
}

test('authorized recovery recreates only the frozen missing base branch at its frozen commit', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-base-'))
  const home = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'main base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('switch', '-c', 'release/deleted')
    await git('commit', '--allow-empty', '-m', 'release base')
    const frozen = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', '-u', 'origin', 'release/deleted')
    await git('push', 'origin', '--delete', 'release/deleted')
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
    )
    await saveWorkflow({
      key: issueKey('o/r', '60'),
      url: 'https://github.com/o/r/issues/60',
      repoKey: 'o/r',
      worktree: join(root, 'worktrees', 'repo', 'repo-issue-60'),
      branch: 'repo-issue-60',
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
      baseRef: `origin/release/deleted @ ${frozen}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow)

    const restored = await restoreBaseBranch(realShellCtx() as never, {
      url: 'https://github.com/o/r/issues/60',
      restoreTarget: { branch: 'release/deleted', hash: frozen },
    })
    assert.deepEqual(restored, { ok: true, baseBranch: 'release/deleted', baseHash: frozen })
    const remoteHash = (
      await execFileAsync('git', [`--git-dir=${remote}`, 'rev-parse', 'refs/heads/release/deleted'])
    ).stdout.trim()
    assert.equal(remoteHash, frozen)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('restore rejects an authorization made stale by a queued baseline-tip mutation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-stale-authorization-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const previousHome = process.env.HOME
  process.env.HOME = home
  let releaseFetch = () => undefined
  const fetchReleased = new Promise<void>((resolve) => {
    releaseFetch = resolve
  })
  let markFetchStarted = () => undefined
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve
  })
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command === 'git fetch origin --prune') {
          markFetchStarted()
          await fetchReleased
        }
        if (spec.command.startsWith('git rev-parse --verify refs/remotes/origin/')) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'missing' } }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
    },
  }
  const workflow = {
    key: issueKey('o/r', '63'),
    url: 'https://github.com/o/r/issues/63',
    repoKey: 'o/r',
    worktree: join(root, 'worktree'),
    branch: 'repo-issue-63',
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
    baseRef: 'origin/release/deleted @ aaa1111',
    updatedAt: 0,
    events: [],
  } satisfies IssueWorkflow
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
    )
    await saveWorkflow(workflow)

    await commitWorkflowMetadata(workflow, workflow.revision ?? null, {
      baseRef: 'origin/release/deleted @ bbb2222',
    })
    const restoring = restoreBaseBranch(ctx as never, {
      url: workflow.url,
      restoreTarget: { branch: 'release/deleted', hash: 'aaa1111' },
    })
    releaseFetch()

    const restored = await restoring
    assert.equal(restored.ok, false)
    if (!restored.ok) assert.match(restored.error, /目标已变化/)
    assert.equal((await loadWorkflow(workflow.key))?.baseRef, 'origin/release/deleted @ bbb2222')
    assert.equal(
      commands.some((command) => command.startsWith('git push ')),
      false,
    )
  } finally {
    releaseFetch()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('restore holds the workflow lock through the remote push', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-lock-scope-'))
  const home = join(root, 'home')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const frozen = 'a'.repeat(40)
  let pushed = false
  let releaseFetch = () => undefined
  const fetchReleased = new Promise<void>((resolve) => {
    releaseFetch = resolve
  })
  let markFetchStarted = () => undefined
  const fetchStarted = new Promise<void>((resolve) => {
    markFetchStarted = resolve
  })
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        if (spec.command === 'git fetch origin --prune') {
          markFetchStarted()
          await fetchReleased
        }
        if (spec.command.startsWith('git rev-parse --verify refs/remotes/origin/')) {
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'missing' } }
        }
        if (spec.command.startsWith('git rev-parse --verify')) {
          return { exitCode: 0, stdout: { text: frozen }, stderr: { text: '' } }
        }
        if (spec.command.startsWith('git push ')) pushed = true
        if (spec.command.startsWith('git ls-remote --heads')) {
          return {
            exitCode: 0,
            stdout: { text: pushed ? `${frozen}\trefs/heads/release/deleted\n` : '' },
            stderr: { text: '' },
          }
        }
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
    },
  }
  const workflow = {
    key: issueKey('o/r', '64'),
    url: 'https://github.com/o/r/issues/64',
    repoKey: 'o/r',
    worktree: join(root, 'worktree'),
    branch: 'repo-issue-64',
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
    baseRef: `origin/release/deleted @ ${frozen}`,
    updatedAt: 0,
    events: [],
  } satisfies IssueWorkflow
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${join(root, 'repo')}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
    )
    await saveWorkflow(workflow)

    const restoring = restoreBaseBranch(ctx as never, {
      url: workflow.url,
      restoreTarget: { branch: 'release/deleted', hash: frozen },
    })
    await fetchStarted
    const mutation = commitWorkflowMetadata(workflow, workflow.revision ?? null, { issueState: 'CLOSED' })
    const race = await Promise.race([
      mutation.then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 20)),
    ])
    assert.equal(race, 'waiting')
    releaseFetch()

    assert.equal((await restoring).ok, true)
    await assert.rejects(mutation, WorkflowConflictError)
    const current = await loadWorkflow(workflow.key)
    assert.ok(current)
    await commitWorkflowMetadata(current, current.revision ?? null, { issueState: 'CLOSED' })
    assert.equal((await loadWorkflow(workflow.key))?.issueState, 'CLOSED')
  } finally {
    releaseFetch()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('sync advances the durable baseline tip before a deleted branch is restored', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-advanced-base-'))
  const home = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktree')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'main base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('switch', '-c', 'release/deleted')
    await git('commit', '--allow-empty', '-m', 'release A')
    const initial = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', '-u', 'origin', 'release/deleted')
    await git('fetch', 'origin', '--prune')
    await git('worktree', 'add', '-b', 'repo-issue-61', worktree, 'origin/release/deleted')
    await wt('commit', '--allow-empty', '-m', 'feature work')
    await git('commit', '--allow-empty', '-m', 'release B')
    const latest = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', 'origin', 'release/deleted')
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
    )
    const workflow = {
      key: issueKey('o/r', '61'),
      url: 'https://github.com/o/r/issues/61',
      repoKey: 'o/r',
      worktree,
      branch: 'repo-issue-61',
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
      baseRef: `origin/release/deleted @ ${initial}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await saveWorkflow(workflow)

    const synced = await syncWorktree(realShellCtx() as never, { url: workflow.url })
    assert.equal(synced.ok, true)
    assert.equal((await loadWorkflow(workflow.key))?.baseRef, `origin/release/deleted @ ${latest}`)
    await git('push', 'origin', '--delete', 'release/deleted')

    const restored = await restoreBaseBranch(realShellCtx() as never, {
      url: workflow.url,
      restoreTarget: { branch: 'release/deleted', hash: latest },
    })
    assert.deepEqual(restored, { ok: true, baseBranch: 'release/deleted', baseHash: latest })
    const remoteHash = (
      await execFileAsync('git', [`--git-dir=${remote}`, 'rev-parse', 'refs/heads/release/deleted'])
    ).stdout.trim()
    assert.equal(remoteHash, latest)
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('a resolved baseline merge conflict advances the durable tip before restore', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-resolved-conflict-'))
  const home = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const worktree = join(root, 'worktree')
  const previousHome = process.env.HOME
  process.env.HOME = home
  const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
  const wt = (...args: string[]) => execFileAsync('git', ['-C', worktree, ...args])
  try {
    await mkdir(join(home, '.clickvibe'), { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await writeFile(join(repo, 'shared.txt'), 'main\n')
    await git('add', 'shared.txt')
    await git('commit', '-m', 'main base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('switch', '-c', 'release/conflict')
    await writeFile(join(repo, 'shared.txt'), 'release A\n')
    await git('commit', '-am', 'release A')
    const initial = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', '-u', 'origin', 'release/conflict')
    await git('worktree', 'add', '-b', 'repo-issue-62', worktree, 'origin/release/conflict')
    await writeFile(join(worktree, 'shared.txt'), 'feature\n')
    await wt('commit', '-am', 'feature work')
    await writeFile(join(repo, 'shared.txt'), 'release B\n')
    await git('commit', '-am', 'release B')
    const latest = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', 'origin', 'release/conflict')
    await writeFile(
      join(home, '.clickvibe', 'config.yaml'),
      ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
    )
    const item = {
      key: issueKey('o/r', '62'),
      url: 'https://github.com/o/r/issues/62',
      repoKey: 'o/r',
      worktree,
      branch: 'repo-issue-62',
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
      baseRef: `origin/release/conflict @ ${initial}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await saveWorkflow(item)

    const conflicted = await syncWorktree(realShellCtx() as never, { url: item.url })
    assert.equal(conflicted.ok, false)
    if (!conflicted.ok) assert.equal(conflicted.conflict, true)
    assert.equal((await loadWorkflow(item.key))?.baseRef, `origin/release/conflict @ ${initial}`)

    await writeFile(join(worktree, 'shared.txt'), 'resolved\n')
    await wt('add', 'shared.txt')
    await wt('commit', '-m', 'resolve baseline conflict')
    const head = (await wt('rev-parse', 'HEAD')).stdout.trim()
    const reloaded = await loadWorkflow(item.key)
    assert.ok(reloaded)
    const live = createLiveTask('dev-62-resolve', reloaded, 'dev', 'codex', null)
    const claim = await establishTaskClaim(
      reloaded,
      live,
      { kind: 'dev', taskId: live.taskId, agent: 'codex', hostJobId: 'job-62-resolve' },
      workflowTaskExpectation(reloaded),
    )
    assert.equal(claim.ok && claim.claimed, true)
    await recordDevDelivery(realShellCtx() as never, reloaded, 'codex', head, [], 'resume', live)
    finishTask(live, 'done', 0)
    assert.equal((await loadWorkflow(item.key))?.baseRef, `origin/release/conflict @ ${latest}`)

    await git('push', 'origin', '--delete', 'release/conflict')
    const restored = await restoreBaseBranch(realShellCtx() as never, {
      url: item.url,
      restoreTarget: { branch: 'release/conflict', hash: latest },
    })
    assert.deepEqual(restored, { ok: true, baseBranch: 'release/conflict', baseHash: latest })
  } finally {
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
