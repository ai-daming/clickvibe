import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { commitWorkflowMetadata, issueKey, loadWorkflow, type IssueWorkflow } from '../src/infra/state.ts'
import { restoreBaseBranch } from '../src/workflow/baseline-restore.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const saveWorkflow = (workflow: IssueWorkflow) => commitWorkflowFixture(workflow, workflow.revision ?? null)

function sharedWorkflow(root: string, number: string, hash: string, updatedAt: number): IssueWorkflow {
  return {
    key: issueKey('o/r', number),
    url: `https://github.com/o/r/issues/${number}`,
    repoKey: 'o/r',
    worktree: join(root, 'worktrees', `repo-issue-${number}`),
    branch: `repo-issue-${number}`,
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
    baseRef: `origin/release/shared @ ${hash}`,
    updatedAt,
    events: [],
  }
}

async function sharedFixture() {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-restore-shared-baseline-'))
  const home = join(root, 'home')
  const repo = join(root, 'repo')
  const previousHome = process.env.HOME
  process.env.HOME = home
  await mkdir(join(home, '.clickvibe'), { recursive: true })
  await mkdir(repo, { recursive: true })
  await writeFile(
    join(home, '.clickvibe', 'config.yaml'),
    ['repos:', `  o/r: ${repo}`, `worktreeRoot: ${join(root, 'worktrees')}`, ''].join('\n'),
  )
  const older = sharedWorkflow(root, '1', 'aaa1111', 1)
  const latest = sharedWorkflow(root, '2', 'bbb2222', 2)
  await saveWorkflow(older)
  await saveWorkflow(latest)
  return {
    older,
    latest,
    async cleanup() {
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(root, { recursive: true, force: true })
    },
  }
}

function ancestorResult(command: string) {
  const reversed = command.includes("'bbb2222^{commit}' 'aaa1111^{commit}'")
  return { exitCode: reversed ? 1 : 0, stdout: { text: '' }, stderr: { text: reversed ? 'no' : '' } }
}

test('restore rejects an older shared-baseline authorization recorded by another workflow', async () => {
  const fixture = await sharedFixture()
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('merge-base --is-ancestor')) return ancestorResult(spec.command)
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
    },
  }
  try {
    const restored = await restoreBaseBranch(ctx as never, {
      url: fixture.older.url,
      restoreTarget: { branch: 'release/shared', hash: 'aaa1111' },
    })
    assert.equal(restored.ok, false)
    if (!restored.ok) assert.match(restored.error, /目标已变化/)
    assert.equal(
      commands.some((command) => command.startsWith('git push ')),
      false,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('restore includes an archived workflow when selecting the latest shared baseline tip', async () => {
  const fixture = await sharedFixture()
  fixture.latest.delivery = {
    status: 'archived',
    mergedAt: '2026-08-23T00:00:00Z',
    prHead: 'feature222',
    mergeStrategy: 'merge',
    cleanup: { worktree: true, localBranch: true, remoteBranch: true, issue: true },
  }
  await saveWorkflow(fixture.latest)
  const commands: string[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        commands.push(spec.command)
        if (spec.command.includes('merge-base --is-ancestor')) return ancestorResult(spec.command)
        return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
      },
    },
  }
  try {
    const restored = await restoreBaseBranch(ctx as never, {
      url: fixture.older.url,
      restoreTarget: { branch: 'release/shared', hash: 'aaa1111' },
    })
    assert.equal(restored.ok, false)
    if (!restored.ok) assert.match(restored.error, /目标已变化/)
    assert.equal(
      commands.some((command) => command.startsWith('git push ')),
      false,
    )
  } finally {
    await fixture.cleanup()
  }
})

test('restore holds every workflow sharing the baseline until the exact push finishes', async () => {
  const fixture = await sharedFixture()
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
        if (spec.command.includes('merge-base --is-ancestor')) return ancestorResult(spec.command)
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
  try {
    const restoring = restoreBaseBranch(ctx as never, {
      url: fixture.older.url,
      restoreTarget: { branch: 'release/shared', hash: 'bbb2222' },
    })
    await fetchStarted
    const mutation = commitWorkflowMetadata(fixture.latest, fixture.latest.revision ?? null, { issueState: 'CLOSED' })
    const race = await Promise.race([
      mutation.then(() => 'completed'),
      new Promise((resolve) => setTimeout(() => resolve('waiting'), 20)),
    ])
    assert.equal(race, 'waiting')
    releaseFetch()
    assert.equal((await restoring).ok, true)
    await mutation
    assert.equal((await loadWorkflow(fixture.latest.key))?.issueState, 'CLOSED')
  } finally {
    releaseFetch()
    await fixture.cleanup()
  }
})
