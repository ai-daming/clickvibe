import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  createRemoteGitCoordinator,
  deriveRemoteGitMetrics,
  type RemoteGitWriteAttempt,
} from '../src/infra/remote-git-coordinator.ts'

const execFileAsync = promisify(execFile)

interface RepositoryFixture {
  remote: string
  repo: string
  cleanup(): Promise<void>
}

async function repositoryFixture(label: string): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), `clickvibe-remote-delete-${label}-`))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['clone', remote, repo])
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'clickvibe-test'])
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'clickvibe-test@example.invalid'])
  await execFileAsync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base'])
  await execFileAsync('git', ['-C', repo, 'branch', '-M', 'main'])
  await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'main'])
  return { remote, repo, cleanup: () => rm(root, { recursive: true, force: true }) }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function commit(repo: string, message: string): Promise<string> {
  await execFileAsync('git', ['-C', repo, 'commit', '--allow-empty', '-m', message])
  return (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
}

async function updateRemote(remote: string, ref: string, oid: string | null): Promise<void> {
  await execFileAsync('git', [`--git-dir=${remote}`, 'update-ref', ...(oid === null ? ['-d', ref] : [ref, oid])])
}

async function seedRemoteObject(repo: string, oid: string): Promise<void> {
  await execFileAsync('git', ['-C', repo, 'push', 'origin', `${oid}:refs/heads/object-seed`])
}

async function remoteOid(repo: string, ref: string): Promise<string | null> {
  const result = await execFileAsync('git', ['-C', repo, 'ls-remote', '--heads', 'origin', ref])
  return result.stdout.trim().split(/\s+/)[0] || null
}

async function deleteWithLease(repo: string, attempt: RemoteGitWriteAttempt): Promise<string> {
  const lease = `--force-with-lease=${attempt.destinationRef}:${attempt.expectedRemoteOid}`
  const result = await execFileAsync('git', ['-C', repo, 'push', lease, 'origin', `:${attempt.destinationRef}`])
  return result.stdout
}

test('initially absent cleanup ref is confirmed by one pre-read with zero marker, push and invalidation', async () => {
  const fixture = await repositoryFixture('absent')
  const coordinator = createRemoteGitCoordinator()
  const destinationRef = 'refs/heads/cleanup'
  const candidateOid = (await execFileAsync('git', ['-C', fixture.repo, 'rev-parse', 'HEAD'])).stdout.trim()
  let markers = 0
  let pushes = 0
  let invalidations = 0
  let settlements = 0
  try {
    const outcome = await coordinator.deleteRemoteBranchIfPresent({
      scope: { repoKey: 'o/absent', remote: 'origin' },
      validate: async () => ({ destinationRef, expectedRemoteOid: candidateOid }),
      preRead: () => remoteOid(fixture.repo, destinationRef),
      persistAttempt: async () => {
        markers += 1
      },
      execute: async (attempt) => {
        pushes += 1
        return deleteWithLease(fixture.repo, attempt)
      },
      invalidate: () => {
        invalidations += 1
      },
      readback: (attempt) => remoteOid(fixture.repo, attempt.destinationRef),
      settleAttempt: async () => {
        settlements += 1
      },
    })

    assert.equal(outcome.outcome, 'confirmed')
    assert.equal(markers, 0)
    assert.equal(pushes, 0)
    assert.equal(invalidations, 0)
    assert.equal(settlements, 0)
    const metrics = deriveRemoteGitMetrics(coordinator.lifecycleEvents())
    assert.equal(metrics.logicalRequests, 1)
    assert.equal(metrics.executions, 1)
    assert.equal(metrics.upstreamRequests, 1)
    assert.equal(metrics.writeReadbacks, 0)
    const phases = coordinator
      .lifecycleEvents()
      .filter((event) => event.kind === 'subprocess-settled')
      .map((event) => (event.kind === 'subprocess-settled' ? event.phase : ''))
    assert.deepEqual(phases, ['pre-read'])
    const terminal = coordinator.lifecycleEvents().find((event) => event.kind === 'terminal')
    assert.equal(terminal?.kind === 'terminal' ? terminal.attemptId : 'missing', undefined)
  } finally {
    await coordinator.close()
    await fixture.cleanup()
  }
})

test('different-OID rebuild between pre-read and delete is preserved by the exact lease', async () => {
  const fixture = await repositoryFixture('different-oid')
  const coordinator = createRemoteGitCoordinator()
  const destinationRef = 'refs/heads/cleanup'
  const candidateOid = await commit(fixture.repo, 'candidate')
  const competingOid = await commit(fixture.repo, 'competitor')
  await seedRemoteObject(fixture.repo, competingOid)
  await updateRemote(fixture.remote, destinationRef, candidateOid)
  const enteredPush = deferred()
  const releasePush = deferred()
  const persisted: RemoteGitWriteAttempt[] = []
  const settled: RemoteGitWriteAttempt[] = []
  let invalidations = 0
  try {
    const deletion = coordinator.deleteRemoteBranchIfPresent({
      scope: { repoKey: 'o/different', remote: 'origin' },
      validate: async () => ({ destinationRef, expectedRemoteOid: candidateOid }),
      preRead: () => remoteOid(fixture.repo, destinationRef),
      persistAttempt: async (attempt) => {
        persisted.push(attempt)
      },
      execute: async (attempt) => {
        enteredPush.resolve()
        await releasePush.promise
        return deleteWithLease(fixture.repo, attempt)
      },
      invalidate: () => {
        invalidations += 1
      },
      readback: (attempt) => remoteOid(fixture.repo, attempt.destinationRef),
      settleAttempt: async (attempt) => {
        settled.push(attempt)
      },
    })

    await enteredPush.promise
    await updateRemote(fixture.remote, destinationRef, competingOid)
    releasePush.resolve()
    const outcome = await deletion

    assert.equal(outcome.outcome, 'unknown')
    assert.equal(await remoteOid(fixture.repo, destinationRef), competingOid)
    assert.equal(persisted.length, 1)
    assert.equal(persisted[0].status, 'prepared')
    assert.equal(settled[0].status, 'unknown')
    assert.equal(invalidations, 1)
    const terminal = coordinator.lifecycleEvents().find((event) => event.kind === 'terminal')
    assert.equal(terminal?.kind === 'terminal' ? terminal.attemptId : null, persisted[0].attemptId)
  } finally {
    releasePush.resolve()
    await coordinator.close()
    await fixture.cleanup()
  }
})

test('same-OID delete and rebuild stays inside the accepted ref identity boundary', async () => {
  const fixture = await repositoryFixture('same-oid')
  const coordinator = createRemoteGitCoordinator()
  const destinationRef = 'refs/heads/cleanup'
  const candidateOid = await commit(fixture.repo, 'candidate')
  await seedRemoteObject(fixture.repo, candidateOid)
  await updateRemote(fixture.remote, destinationRef, candidateOid)
  const enteredPush = deferred()
  const releasePush = deferred()
  const settled: RemoteGitWriteAttempt[] = []
  try {
    const deletion = coordinator.deleteRemoteBranchIfPresent({
      scope: { repoKey: 'o/same', remote: 'origin' },
      validate: async () => ({ destinationRef, expectedRemoteOid: candidateOid }),
      preRead: () => remoteOid(fixture.repo, destinationRef),
      persistAttempt: async () => undefined,
      execute: async (attempt) => {
        enteredPush.resolve()
        await releasePush.promise
        return deleteWithLease(fixture.repo, attempt)
      },
      invalidate: () => undefined,
      readback: (attempt) => remoteOid(fixture.repo, attempt.destinationRef),
      settleAttempt: async (attempt) => {
        settled.push(attempt)
      },
    })

    await enteredPush.promise
    await updateRemote(fixture.remote, destinationRef, null)
    await updateRemote(fixture.remote, destinationRef, candidateOid)
    releasePush.resolve()
    const outcome = await deletion

    assert.equal(outcome.outcome, 'confirmed')
    assert.equal(await remoteOid(fixture.repo, destinationRef), null)
    assert.equal(settled[0].status, 'confirmed')
  } finally {
    releasePush.resolve()
    await coordinator.close()
    await fixture.cleanup()
  }
})

test('prepared cleanup delete recovers by readback without a second receive', async () => {
  const fixture = await repositoryFixture('recovery')
  const firstOwner = createRemoteGitCoordinator()
  const destinationRef = 'refs/heads/cleanup'
  const candidateOid = await commit(fixture.repo, 'candidate')
  await seedRemoteObject(fixture.repo, candidateOid)
  await updateRemote(fixture.remote, destinationRef, candidateOid)
  const counterPath = join(fixture.remote, 'delete-receives')
  const hookPath = join(fixture.remote, 'hooks', 'pre-receive')
  await writeFile(hookPath, `#!/bin/sh\nprintf 'delete\\n' >> '${counterPath}'\n`)
  await chmod(hookPath, 0o755)
  const attempt: RemoteGitWriteAttempt = {
    attemptId: 'cleanup-recovery',
    scope: { repoKey: 'o/recovery-delete', remote: 'origin' },
    operationKind: 'delete',
    destinationRef,
    expectedOid: null,
    expectedRemoteOid: candidateOid,
    status: 'prepared',
    preparedAt: new Date().toISOString(),
  }
  try {
    await deleteWithLease(fixture.repo, attempt)
    assert.equal((await readFile(counterPath, 'utf8')).trim().split('\n').length, 1)
    await firstOwner.close()

    const restarted = createRemoteGitCoordinator()
    let settled: RemoteGitWriteAttempt | null = null
    const outcome = await restarted.recoverPush({
      attempt,
      readback: (plan) => remoteOid(fixture.repo, plan.destinationRef),
      settleAttempt: async (value) => {
        settled = value
      },
    })
    assert.equal(outcome.outcome, 'confirmed')
    assert.equal(settled?.status, 'confirmed')
    assert.equal((await readFile(counterPath, 'utf8')).trim().split('\n').length, 1)
    assert.equal(
      restarted.lifecycleEvents().filter((event) => event.kind === 'subprocess-settled' && event.phase === 'push')
        .length,
      0,
    )
    await restarted.close()
  } finally {
    await firstOwner.close()
    await fixture.cleanup()
  }
})

test('delete boundary failures remain zero-write or conservatively unknown', async (t) => {
  const oid = 'c'.repeat(40)
  const destinationRef = 'refs/heads/cleanup'
  const baseInput = () => ({
    scope: { repoKey: 'o/delete-failures', remote: 'origin' },
    validate: async () => ({ destinationRef, expectedRemoteOid: oid }),
    preRead: async () => oid,
    persistAttempt: async () => undefined,
    execute: async () => 'deleted',
    invalidate: () => undefined,
    readback: async () => null,
    settleAttempt: async () => undefined,
  })

  await t.test('validation failure dispatches no subprocess', async () => {
    const coordinator = createRemoteGitCoordinator()
    try {
      const outcome = await coordinator.deleteRemoteBranchIfPresent({
        ...baseInput(),
        validate: async () => {
          throw new Error('stale cleanup credential')
        },
      })
      assert.equal(outcome.outcome, 'failed')
      assert.match(outcome.error ?? '', /stale cleanup credential/)
      assert.equal(
        coordinator.lifecycleEvents().some((event) => event.kind === 'subprocess-settled'),
        false,
      )
    } finally {
      await coordinator.close()
    }
  })

  await t.test('pre-read failure is unknown with no marker or write', async () => {
    const coordinator = createRemoteGitCoordinator()
    let markers = 0
    try {
      const outcome = await coordinator.deleteRemoteBranchIfPresent({
        ...baseInput(),
        preRead: async () => {
          throw new Error('remote unavailable')
        },
        persistAttempt: async () => {
          markers += 1
        },
      })
      assert.equal(outcome.outcome, 'unknown')
      assert.equal(markers, 0)
    } finally {
      await coordinator.close()
    }
  })

  await t.test('pre-read OID mismatch is a failed zero-write decision', async () => {
    const coordinator = createRemoteGitCoordinator()
    let writes = 0
    try {
      const outcome = await coordinator.deleteRemoteBranchIfPresent({
        ...baseInput(),
        preRead: async () => 'd'.repeat(40),
        execute: async () => {
          writes += 1
          return ''
        },
      })
      assert.equal(outcome.outcome, 'failed')
      assert.match(outcome.error ?? '', /远端 ref 已变化/)
      assert.equal(writes, 0)
    } finally {
      await coordinator.close()
    }
  })

  await t.test('marker persistence failure dispatches no write', async () => {
    const coordinator = createRemoteGitCoordinator()
    let writes = 0
    try {
      const outcome = await coordinator.deleteRemoteBranchIfPresent({
        ...baseInput(),
        persistAttempt: async () => {
          throw new Error('marker disk failure')
        },
        execute: async () => {
          writes += 1
          return ''
        },
      })
      assert.equal(outcome.outcome, 'failed')
      assert.match(outcome.error ?? '', /marker disk failure/)
      assert.equal(writes, 0)
    } finally {
      await coordinator.close()
    }
  })

  await t.test('readback failure settles unknown', async () => {
    const coordinator = createRemoteGitCoordinator()
    let settled: RemoteGitWriteAttempt | null = null
    try {
      const outcome = await coordinator.deleteRemoteBranchIfPresent({
        ...baseInput(),
        readback: async () => {
          throw new Error('readback unavailable')
        },
        settleAttempt: async (attempt) => {
          settled = attempt
        },
      })
      assert.equal(outcome.outcome, 'unknown')
      assert.equal(settled?.status, 'unknown')
      assert.match(settled?.diagnosticRef ?? '', /readback unavailable/)
    } finally {
      await coordinator.close()
    }
  })

  await t.test('settlement persistence failure remains unknown', async () => {
    const coordinator = createRemoteGitCoordinator()
    try {
      const outcome = await coordinator.deleteRemoteBranchIfPresent({
        ...baseInput(),
        settleAttempt: async () => {
          throw new Error('settlement disk failure')
        },
      })
      assert.equal(outcome.outcome, 'unknown')
      assert.match(outcome.error ?? '', /settlement disk failure/)
      assert.ok(outcome.attemptId)
    } finally {
      await coordinator.close()
    }
  })

  await t.test('queue timeout is converted to a terminal unknown', async () => {
    const coordinator = createRemoteGitCoordinator({ queueTimeoutMs: 5 })
    const entered = deferred()
    const release = deferred()
    const blocker = coordinator.fetch({
      scope: { repoKey: 'o/delete-failures', remote: 'origin' },
      prune: true,
      execute: async () => {
        entered.resolve()
        await release.promise
        return ''
      },
      invalidate: () => undefined,
      readback: async () => '',
    })
    try {
      await entered.promise
      const outcome = await coordinator.deleteRemoteBranchIfPresent(baseInput())
      assert.equal(outcome.outcome, 'unknown')
      assert.match(outcome.error ?? '', /排队超过/)
    } finally {
      release.resolve()
      await blocker
      await coordinator.close()
    }
  })
})
