import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import {
  closeRemoteGitCoordinator,
  remoteGitCoordinator,
  resetRemoteGitCoordinatorForTests,
} from '../src/infra/remote-git.ts'
import type { IssueWorkflow } from '../src/infra/state.ts'
import { createPullRequest } from '../src/workflow/create-pr.ts'
import { syncWorktree } from '../src/workflow/sync.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const execFileAsync = promisify(execFile)

test('sync credential expires inside the remote lock when the real worktree HEAD changes while queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-sync-expired-head-'))
  const previousHome = process.env.HOME
  process.env.HOME = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  let releaseBlocker = () => undefined
  const blockerReleased = new Promise<void>((resolve) => {
    releaseBlocker = resolve
  })
  let markBlockerEntered = () => undefined
  const blockerEntered = new Promise<void>((resolve) => {
    markBlockerEntered = resolve
  })
  let blocker: Promise<unknown> | null = null
  resetRemoteGitCoordinatorForTests()
  try {
    await mkdir(process.env.HOME, { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('switch', '-c', 'repo-issue-14')
    const baseOid = (await git('rev-parse', 'HEAD')).stdout.trim()
    const workflow = {
      key: 'o-r-14',
      url: 'https://github.com/o/r/issues/14',
      repoKey: 'o/r',
      worktree: repo,
      branch: 'repo-issue-14',
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
      baseRef: `origin/main @ ${baseOid}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    let candidateCaptured = false
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string; workdir?: string }) {
          try {
            const output = await execFileAsync('/bin/sh', ['-c', spec.command], {
              cwd: spec.workdir,
              encoding: 'utf8',
            })
            if (spec.command === 'git rev-parse --verify HEAD^{commit}' && !candidateCaptured) {
              candidateCaptured = true
              blocker = remoteGitCoordinator().fetch({
                scope: { repoKey: workflow.repoKey, remote: 'origin' },
                prune: false,
                execute: async () => {
                  markBlockerEntered()
                  await blockerReleased
                  return (await git('fetch', 'origin')).stdout
                },
                invalidate: () => undefined,
                readback: async () => (await git('for-each-ref', 'refs/remotes/origin')).stdout,
              })
            }
            return { exitCode: 0, stdout: { text: output.stdout }, stderr: { text: output.stderr } }
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
    const syncing = syncWorktree(ctx as never, { url: workflow.url })
    await blockerEntered
    while (true) {
      const events = remoteGitCoordinator().lifecycleEvents()
      const pushRequests = new Set(
        events
          .filter((event) => event.kind === 'declared' && event.operation === 'push')
          .map((event) => event.requestId),
      )
      if (events.some((event) => event.kind === 'queued' && pushRequests.has(event.requestId))) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await git('commit', '--allow-empty', '-m', 'external queued mutation')
    releaseBlocker()
    const result = await syncing
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /HEAD/)
    await blocker
    const remoteFeature = await git('ls-remote', '--heads', 'origin', 'refs/heads/repo-issue-14')
    assert.equal(remoteFeature.stdout.trim(), '')
  } finally {
    releaseBlocker()
    await closeRemoteGitCoordinator()
    resetRemoteGitCoordinatorForTests()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('PR push credential expires inside the remote lock when HEAD changes while queued', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-pr-push-expired-head-'))
  const previousHome = process.env.HOME
  process.env.HOME = join(root, 'home')
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  let releaseBlocker = () => undefined
  const blockerReleased = new Promise<void>((resolve) => {
    releaseBlocker = resolve
  })
  let markBlockerEntered = () => undefined
  const blockerEntered = new Promise<void>((resolve) => {
    markBlockerEntered = resolve
  })
  let blocker: Promise<unknown> | null = null
  let githubWrites = 0
  resetRemoteGitCoordinatorForTests()
  resetGithubGatewayOwnerForTests()
  try {
    await mkdir(process.env.HOME, { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    await git('switch', '-c', 'repo-issue-15')
    const baseOid = (await git('rev-parse', 'HEAD')).stdout.trim()
    const workflow = {
      key: 'o-r-15',
      url: 'https://github.com/o/r/issues/15',
      repoKey: 'o/r',
      worktree: repo,
      branch: 'repo-issue-15',
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
      baseRef: `origin/main @ ${baseOid}`,
      updatedAt: 0,
      events: [],
    } satisfies IssueWorkflow
    await commitWorkflowFixture(workflow, workflow.revision ?? null)
    let candidateCaptured = false
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string; workdir?: string }) {
          if (spec.command.startsWith('gh ')) {
            if (spec.command.includes('--method')) githubWrites += 1
            return { exitCode: 0, stdout: { text: 'HTTP/2.0 200 OK\n\n[]' }, stderr: { text: '' } }
          }
          try {
            const output = await execFileAsync('/bin/sh', ['-c', spec.command], {
              cwd: spec.workdir,
              encoding: 'utf8',
            })
            if (spec.command === 'git rev-parse --verify HEAD^{commit}' && !candidateCaptured) {
              candidateCaptured = true
              blocker = remoteGitCoordinator().fetch({
                scope: { repoKey: workflow.repoKey, remote: 'origin' },
                prune: false,
                execute: async () => {
                  markBlockerEntered()
                  await blockerReleased
                  return (await git('fetch', 'origin')).stdout
                },
                invalidate: () => undefined,
                readback: async () => (await git('for-each-ref', 'refs/remotes/origin')).stdout,
              })
            }
            return { exitCode: 0, stdout: { text: output.stdout }, stderr: { text: output.stderr } }
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

    const creating = createPullRequest(ctx as never, { url: workflow.url })
    await blockerEntered
    while (true) {
      const events = remoteGitCoordinator().lifecycleEvents()
      const pushRequests = new Set(
        events
          .filter((event) => event.kind === 'declared' && event.operation === 'push')
          .map((event) => event.requestId),
      )
      if (events.some((event) => event.kind === 'queued' && pushRequests.has(event.requestId))) break
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    await git('commit', '--allow-empty', '-m', 'external queued mutation')
    releaseBlocker()
    const result = await creating
    assert.equal(result.ok, false)
    if (!result.ok) assert.match(result.error, /HEAD/)
    await blocker
    const remoteFeature = await git('ls-remote', '--heads', 'origin', 'refs/heads/repo-issue-15')
    assert.equal(remoteFeature.stdout.trim(), '')
    assert.equal(githubWrites, 0)
  } finally {
    releaseBlocker()
    await closeRemoteGitCoordinator()
    resetRemoteGitCoordinatorForTests()
    resetGithubGatewayOwnerForTests()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
