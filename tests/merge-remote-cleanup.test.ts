import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  closeRemoteGitCoordinator,
  remoteGitCoordinator,
  resetRemoteGitCoordinatorForTests,
} from '../src/infra/remote-git.ts'
import { deriveRemoteGitMetrics } from '../src/infra/remote-git-coordinator.ts'
import type { RemoteGitWriteAttempt } from '../src/infra/remote-git-contracts.ts'
import {
  commitWorkflowMetadata,
  issueKey,
  type IssueWorkflow,
  loadWorkflow,
  workflowRevision,
} from '../src/infra/state.ts'
import { cleanupRemoteBranch } from '../src/workflow/merge-remote-cleanup.ts'
import { commitWorkflowFixture } from './workflow-fixture.ts'

const execFileAsync = promisify(execFile)

function cleanupWorkflow(number: string): IssueWorkflow {
  return {
    key: issueKey('o/r', number),
    url: `https://github.com/o/r/issues/${number}`,
    repoKey: 'o/r',
    worktree: '/tmp/clickvibe-cleanup',
    branch: `clickvibe-issue-${number}`,
    stage: 'passed',
    devAgent: 'codex',
    devTaskId: null,
    devSessionId: null,
    devSessionAgent: null,
    devInterrupted: false,
    reviewAgent: 'codex',
    reviewTaskId: null,
    reviewSessionId: null,
    reviewSessionAgent: null,
    reviewResult: { passed: true, issues: [] },
    prNumber: number,
    issueState: 'OPEN',
    baseRef: 'origin/main',
    delivery: {
      status: 'cleanup-pending',
      mergedAt: '2026-09-02T00:00:00Z',
      prHead: 'a'.repeat(40),
      mergeStrategy: 'merge',
      cleanup: { worktree: true, localBranch: true, remoteBranch: false, issue: false },
    },
    updatedAt: Date.now(),
    events: [],
  }
}

test('merge cleanup persists one exact delete attempt and confirms the absent remote ref', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-merge-remote-cleanup-'))
  const previousHome = process.env.HOME
  const home = join(root, 'home')
  process.env.HOME = home
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  resetRemoteGitCoordinatorForTests()
  try {
    await mkdir(home, { recursive: true })
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    const git = (...args: string[]) => execFileAsync('git', ['-C', repo, ...args])
    await git('config', 'user.name', 'clickvibe-test')
    await git('config', 'user.email', 'clickvibe-test@example.invalid')
    await git('commit', '--allow-empty', '-m', 'base')
    await git('branch', '-M', 'main')
    await git('push', '-u', 'origin', 'main')
    const branch = 'clickvibe-issue-135'
    await git('switch', '-c', branch)
    await git('commit', '--allow-empty', '-m', 'delivery')
    const prHead = (await git('rev-parse', 'HEAD')).stdout.trim()
    await git('push', 'origin', `${prHead}:refs/heads/${branch}`)

    const workflow = {
      key: issueKey('o/r', '135'),
      url: 'https://github.com/o/r/issues/135',
      repoKey: 'o/r',
      worktree: repo,
      branch,
      stage: 'passed',
      devAgent: 'codex',
      devTaskId: null,
      devSessionId: null,
      devSessionAgent: null,
      devInterrupted: false,
      reviewAgent: 'codex',
      reviewTaskId: null,
      reviewSessionId: null,
      reviewSessionAgent: null,
      reviewResult: { passed: true, issues: [] },
      prNumber: '155',
      issueState: 'OPEN',
      baseRef: 'origin/main',
      delivery: {
        status: 'cleanup-pending',
        mergedAt: new Date().toISOString(),
        prHead,
        mergeStrategy: 'merge',
        cleanup: { worktree: true, localBranch: true, remoteBranch: false, issue: false },
      },
      updatedAt: Date.now(),
      events: [],
    } satisfies IssueWorkflow
    await commitWorkflowFixture(workflow, null)
    const active = await loadWorkflow(workflow.key)
    assert.ok(active)
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
    await cleanupRemoteBranch(ctx as never, active, {
      repoPath: repo,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repo },
      persist: async () => {
        const current = await loadWorkflow(active.key)
        if (!current) throw new Error('workflow disappeared during cleanup test')
        Object.assign(
          active,
          await commitWorkflowMetadata(current, workflowRevision(current), { delivery: active.delivery }),
        )
      },
    })

    const persisted = await loadWorkflow(active.key)
    assert.equal(persisted?.delivery?.cleanup.remoteBranch, true)
    assert.equal(persisted?.delivery?.cleanup.remoteBranchAttempt?.status, 'confirmed')
    assert.equal(persisted?.delivery?.cleanup.remoteBranchAttempt?.expectedRemoteOid, prHead)
    assert.equal((await git('ls-remote', '--heads', 'origin', `refs/heads/${branch}`)).stdout.trim(), '')
    const events = remoteGitCoordinator().lifecycleEvents()
    const metrics = deriveRemoteGitMetrics(events)
    assert.equal(events.filter((event) => event.kind === 'declared').length, 1)
    assert.deepEqual(
      events
        .filter((event) => event.kind === 'subprocess-settled')
        .map((event) => (event.kind === 'subprocess-settled' ? event.phase : '')),
      ['pre-read', 'push', 'readback'],
    )
    assert.equal(metrics.upstreamRequests, 3)
    assert.equal(metrics.invalidations, 1)
    assert.equal(metrics.writeReadbacks, 1)
  } finally {
    await closeRemoteGitCoordinator()
    resetRemoteGitCoordinatorForTests()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})

test('confirmed and prepared delete markers converge without redispatching a delete', async (t) => {
  await t.test('confirmed marker only advances the cleanup ledger', async () => {
    const workflow = cleanupWorkflow('136')
    const attempt: RemoteGitWriteAttempt = {
      attemptId: 'confirmed-delete',
      scope: { repoKey: workflow.repoKey, remote: 'origin' },
      operationKind: 'delete',
      destinationRef: `refs/heads/${workflow.branch}`,
      expectedOid: null,
      expectedRemoteOid: workflow.delivery?.prHead ?? null,
      status: 'confirmed',
      preparedAt: '2026-09-02T00:00:00Z',
    }
    if (!workflow.delivery) throw new Error('test workflow delivery missing')
    workflow.delivery.cleanup.remoteBranchAttempt = attempt
    let persists = 0
    await cleanupRemoteBranch({} as never, workflow, {
      repoPath: workflow.worktree,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
      persist: async () => {
        persists += 1
      },
    })
    assert.equal(workflow.delivery.cleanup.remoteBranch, true)
    assert.equal(persists, 1)
  })

  await t.test('prepared marker performs one readback and zero push', async () => {
    const root = await mkdtemp(join(tmpdir(), 'clickvibe-prepared-delete-'))
    const previousHome = process.env.HOME
    process.env.HOME = root
    resetRemoteGitCoordinatorForTests()
    const workflow = cleanupWorkflow('137')
    if (!workflow.delivery) throw new Error('test workflow delivery missing')
    workflow.delivery.cleanup.remoteBranchAttempt = {
      attemptId: 'prepared-delete',
      scope: { repoKey: workflow.repoKey, remote: 'origin' },
      operationKind: 'delete',
      destinationRef: `refs/heads/${workflow.branch}`,
      expectedOid: null,
      expectedRemoteOid: workflow.delivery.prHead,
      status: 'prepared',
      preparedAt: '2026-09-02T00:00:00Z',
    }
    const commands: string[] = []
    let persists = 0
    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          commands.push(spec.command)
          return { exitCode: 0, stdout: { text: '' }, stderr: { text: '' } }
        },
      },
    }
    try {
      await cleanupRemoteBranch(ctx as never, workflow, {
        repoPath: workflow.worktree,
        sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
        persist: async () => {
          persists += 1
        },
      })
      assert.equal(workflow.delivery.cleanup.remoteBranch, true)
      assert.equal(workflow.delivery.cleanup.remoteBranchAttempt?.status, 'confirmed')
      assert.equal(persists, 2)
      assert.deepEqual(commands, [`git ls-remote --heads origin 'refs/heads/${workflow.branch}'`])
      assert.equal(
        commands.some((command) => command.startsWith('git push')),
        false,
      )
    } finally {
      await closeRemoteGitCoordinator()
      resetRemoteGitCoordinatorForTests()
      if (previousHome === undefined) delete process.env.HOME
      else process.env.HOME = previousHome
      await rm(root, { recursive: true, force: true })
    }
  })
})

test('merge cleanup revalidates every delivery credential inside the coordinator lease', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-cleanup-validation-'))
  const previousHome = process.env.HOME
  process.env.HOME = root
  resetRemoteGitCoordinatorForTests()
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string }) {
        throw new Error(`unexpected remote command: ${spec.command}`)
      },
    },
  }
  const run = (workflow: IssueWorkflow) =>
    cleanupRemoteBranch(ctx as never, workflow, {
      repoPath: workflow.worktree,
      sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: workflow.worktree },
      persist: async () => {
        throw new Error('validation rejection must not persist')
      },
    })
  try {
    const missingDelivery = cleanupWorkflow('140')
    delete missingDelivery.delivery
    await assert.rejects(run(missingDelivery), /delivery 状态丢失/)

    const missingCurrent = cleanupWorkflow('141')
    await assert.rejects(run(missingCurrent), /merge delivery 已失效/)

    const currentWithoutDelivery = cleanupWorkflow('142')
    const claimantWithoutDelivery = structuredClone(currentWithoutDelivery)
    delete currentWithoutDelivery.delivery
    await commitWorkflowFixture(currentWithoutDelivery, null)
    await assert.rejects(run(claimantWithoutDelivery), /merge delivery 已失效/)

    const archived = cleanupWorkflow('143')
    const archivedClaimant = structuredClone(archived)
    if (!archived.delivery) throw new Error('test workflow delivery missing')
    archived.delivery.status = 'archived'
    await commitWorkflowFixture(archived, null)
    await assert.rejects(run(archivedClaimant), /merge delivery 已失效/)

    const changedBranch = cleanupWorkflow('144')
    const branchClaimant = structuredClone(changedBranch)
    changedBranch.branch = 'competitor-branch'
    await commitWorkflowFixture(changedBranch, null)
    await assert.rejects(run(branchClaimant), /merge cleanup 凭证已变化/)

    const changedHead = cleanupWorkflow('145')
    const headClaimant = structuredClone(changedHead)
    if (!changedHead.delivery) throw new Error('test workflow delivery missing')
    changedHead.delivery.prHead = 'b'.repeat(40)
    await commitWorkflowFixture(changedHead, null)
    await assert.rejects(run(headClaimant), /merge cleanup 凭证已变化/)

    const alreadyComplete = cleanupWorkflow('146')
    const completeClaimant = structuredClone(alreadyComplete)
    if (!alreadyComplete.delivery) throw new Error('test workflow delivery missing')
    alreadyComplete.delivery.cleanup.remoteBranch = true
    await commitWorkflowFixture(alreadyComplete, null)
    await assert.rejects(run(completeClaimant), /远端分支清理步骤已由其他执行者完成/)
  } finally {
    await closeRemoteGitCoordinator()
    resetRemoteGitCoordinatorForTests()
    if (previousHome === undefined) delete process.env.HOME
    else process.env.HOME = previousHome
    await rm(root, { recursive: true, force: true })
  }
})
