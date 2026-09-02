import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import {
  createRemoteGitCoordinator,
  deriveRemoteGitMetrics,
  RemoteGitClosedError,
  type RemoteGitWriteAttempt,
} from '../src/infra/remote-git-coordinator.ts'

const execFileAsync = promisify(execFile)

interface RepositoryFixture {
  remote: string
  repo: string
  cleanup(): Promise<void>
}

async function repositoryFixture(label: string): Promise<RepositoryFixture> {
  const root = await mkdtemp(join(tmpdir(), `clickvibe-remote-coordinator-${label}-`))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['clone', remote, repo])
  await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'clickvibe-test'])
  await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'clickvibe-test@example.invalid'])
  await execFileAsync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base'])
  await execFileAsync('git', ['-C', repo, 'branch', '-M', 'main'])
  await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'main'])
  await execFileAsync('git', [`--git-dir=${remote}`, 'symbolic-ref', 'HEAD', 'refs/heads/main'])
  return {
    remote,
    repo,
    cleanup: () => rm(root, { recursive: true, force: true }),
  }
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

async function fetchRemote(repo: string): Promise<string> {
  const result = await execFileAsync('git', ['-C', repo, 'fetch', 'origin', '--prune'])
  return result.stdout
}

async function readRemoteTrackingRefs(repo: string): Promise<string> {
  const result = await execFileAsync('git', [
    '-C',
    repo,
    'for-each-ref',
    '--format=%(refname) %(objectname)',
    'refs/remotes/origin',
  ])
  return result.stdout.trim()
}

async function readRemoteOid(repo: string, ref: string): Promise<string | null> {
  const result = await execFileAsync('git', ['-C', repo, 'ls-remote', '--heads', 'origin', ref])
  const oid = result.stdout.trim().split(/\s+/)[0]
  return oid || null
}

test('#133 review-dense: three compatible fetches count one upstream command and two joins', async () => {
  const fixture = await repositoryFixture('singleflight')
  const coordinator = createRemoteGitCoordinator()
  const entered = deferred()
  const release = deferred()
  let physicalFetches = 0
  let invalidations = 0
  try {
    const run = () =>
      coordinator.fetch({
        scope: { repoKey: 'o/singleflight', remote: 'origin' },
        prune: true,
        execute: async () => {
          physicalFetches += 1
          entered.resolve()
          await release.promise
          return fetchRemote(fixture.repo)
        },
        invalidate: () => {
          invalidations += 1
        },
        readback: () => readRemoteTrackingRefs(fixture.repo),
      })

    const first = run()
    await entered.promise
    const second = run()
    const third = run()
    release.resolve()
    const outcomes = await Promise.all([first, second, third])

    assert.equal(physicalFetches, 1)
    assert.equal(invalidations, 1)
    assert.ok(outcomes.every((outcome) => outcome.outcome === 'confirmed'))
    assert.deepEqual(
      outcomes.map((outcome) => outcome.flightId),
      [outcomes[0].flightId, outcomes[0].flightId, outcomes[0].flightId],
    )
    const metrics = deriveRemoteGitMetrics(coordinator.lifecycleEvents())
    assert.equal(metrics.logicalRequests, 3)
    assert.equal(metrics.upstreamRequests, 1)
    assert.equal(metrics.singleflightJoins, 2)
    assert.equal(metrics.executions, 1)
    assert.equal(metrics.failures, 0)
    assert.equal(metrics.unknowns, 0)
    assert.equal(metrics.invalidations, 1)
    assert.equal(metrics.writeReadbacks, 0)
  } finally {
    await coordinator.close()
    await fixture.cleanup()
  }
})

test('compatible ls-remote reads singleflight without entering the mutation queue', async () => {
  const fixture = await repositoryFixture('ls-remote')
  const coordinator = createRemoteGitCoordinator()
  const entered = deferred()
  const release = deferred()
  let physicalReads = 0
  try {
    const run = () =>
      coordinator.lsRemote({
        scope: { repoKey: 'o/ls-remote', remote: 'origin' },
        query: 'refs/heads/main',
        execute: async () => {
          physicalReads += 1
          entered.resolve()
          await release.promise
          return (await execFileAsync('git', ['-C', fixture.repo, 'ls-remote', '--heads', 'origin', 'refs/heads/main']))
            .stdout
        },
      })
    const first = run()
    await entered.promise
    const second = run()
    release.resolve()
    const outcomes = await Promise.all([first, second])
    assert.equal(physicalReads, 1)
    assert.ok(outcomes.every((outcome) => outcome.outcome === 'confirmed'))
    assert.equal(deriveRemoteGitMetrics(coordinator.lifecycleEvents()).singleflightJoins, 1)
  } finally {
    await coordinator.close()
    await fixture.cleanup()
  }
})

test('same-scope push waits for fetch while another repository fetch proceeds', async () => {
  const firstRepo = await repositoryFixture('scope-a')
  const secondRepo = await repositoryFixture('scope-b')
  const coordinator = createRemoteGitCoordinator()
  const fetchAEntered = deferred()
  const releaseFetchA = deferred()
  const order: string[] = []
  try {
    await execFileAsync('git', ['-C', firstRepo.repo, 'commit', '--allow-empty', '-m', 'feature'])
    const expectedOid = (await execFileAsync('git', ['-C', firstRepo.repo, 'rev-parse', 'HEAD'])).stdout.trim()
    const attempt: RemoteGitWriteAttempt = {
      attemptId: 'attempt-a',
      scope: { repoKey: 'o/a', remote: 'origin' },
      operationKind: 'push',
      destinationRef: 'refs/heads/feature',
      expectedOid,
      expectedRemoteOid: null,
      status: 'prepared',
      preparedAt: new Date().toISOString(),
    }

    const fetchA = coordinator.fetch({
      scope: { repoKey: 'o/a', remote: 'origin' },
      prune: true,
      execute: async () => {
        order.push('fetch-a-start')
        fetchAEntered.resolve()
        await releaseFetchA.promise
        const output = await fetchRemote(firstRepo.repo)
        order.push('fetch-a-end')
        return output
      },
      invalidate: () => undefined,
      readback: () => readRemoteTrackingRefs(firstRepo.repo),
    })
    await fetchAEntered.promise

    const pushA = coordinator.push({
      scope: attempt.scope,
      validate: async () => attempt,
      persistAttempt: async () => undefined,
      execute: async (plan) => {
        order.push('push-a')
        const result = await execFileAsync('git', [
          '-C',
          firstRepo.repo,
          'push',
          'origin',
          `${plan.expectedOid}:${plan.destinationRef}`,
        ])
        return result.stdout
      },
      invalidate: () => undefined,
      readback: (plan) => readRemoteOid(firstRepo.repo, plan.destinationRef),
      settleAttempt: async () => undefined,
    })

    let fetchBFinished = false
    const fetchB = coordinator
      .fetch({
        scope: { repoKey: 'o/b', remote: 'origin' },
        prune: true,
        execute: () => fetchRemote(secondRepo.repo),
        invalidate: () => undefined,
        readback: () => readRemoteTrackingRefs(secondRepo.repo),
      })
      .then(() => {
        fetchBFinished = true
      })

    await fetchB
    assert.equal(fetchBFinished, true)
    assert.deepEqual(order, ['fetch-a-start'])
    releaseFetchA.resolve()
    const [, pushOutcome] = await Promise.all([fetchA, pushA])
    assert.equal(pushOutcome.outcome, 'confirmed')
    assert.deepEqual(order, ['fetch-a-start', 'fetch-a-end', 'push-a'])
  } finally {
    releaseFetchA.resolve()
    await coordinator.close()
    await Promise.all([firstRepo.cleanup(), secondRepo.cleanup()])
  }
})

test('push persists before one dispatch and restart recovery performs readback only', async () => {
  const fixture = await repositoryFixture('recovery')
  const markerPath = join(fixture.repo, '.git', 'remote-attempt.json')
  const firstOwner = createRemoteGitCoordinator()
  let dispatches = 0
  let readbacks = 0
  try {
    await execFileAsync('git', ['-C', fixture.repo, 'commit', '--allow-empty', '-m', 'recoverable'])
    const expectedOid = (await execFileAsync('git', ['-C', fixture.repo, 'rev-parse', 'HEAD'])).stdout.trim()
    const attempt: RemoteGitWriteAttempt = {
      attemptId: 'attempt-recovery',
      scope: { repoKey: 'o/recovery', remote: 'origin' },
      operationKind: 'push',
      destinationRef: 'refs/heads/recovery',
      expectedOid,
      expectedRemoteOid: null,
      status: 'prepared',
      preparedAt: new Date().toISOString(),
    }
    const first = await firstOwner.push({
      scope: attempt.scope,
      validate: async () => attempt,
      persistAttempt: async (prepared) => {
        await writeFile(markerPath, JSON.stringify(prepared))
      },
      execute: async (plan) => {
        assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).status, 'prepared')
        dispatches += 1
        await execFileAsync('git', ['-C', fixture.repo, 'push', 'origin', `${plan.expectedOid}:${plan.destinationRef}`])
        return 'response intentionally ignored by the confirmation predicate'
      },
      invalidate: () => undefined,
      readback: async (plan) => {
        readbacks += 1
        return readRemoteOid(fixture.repo, plan.destinationRef)
      },
      settleAttempt: async (settled) => {
        await writeFile(markerPath, JSON.stringify(settled))
      },
    })
    assert.equal(first.outcome, 'confirmed')
    assert.equal(dispatches, 1)
    assert.equal(readbacks, 1)

    const surviving = JSON.parse(await readFile(markerPath, 'utf8')) as RemoteGitWriteAttempt
    surviving.status = 'prepared'
    await writeFile(markerPath, JSON.stringify(surviving))
    await firstOwner.close()

    const restarted = createRemoteGitCoordinator()
    const recovered = await restarted.recoverPush({
      attempt: JSON.parse(await readFile(markerPath, 'utf8')) as RemoteGitWriteAttempt,
      readback: async (plan) => {
        readbacks += 1
        return readRemoteOid(fixture.repo, plan.destinationRef)
      },
      settleAttempt: async (settled) => {
        await writeFile(markerPath, JSON.stringify(settled))
      },
    })
    assert.equal(recovered.outcome, 'confirmed')
    assert.equal(dispatches, 1)
    assert.equal(readbacks, 2)
    assert.equal(JSON.parse(await readFile(markerPath, 'utf8')).status, 'confirmed')
    const metrics = deriveRemoteGitMetrics(restarted.lifecycleEvents())
    assert.equal(metrics.upstreamRequests, 1)
    assert.equal(metrics.executions, 0)
    assert.equal(metrics.writeReadbacks, 1)
    await restarted.close()
  } finally {
    await firstOwner.close()
    await fixture.cleanup()
  }
})

test('close is bounded, interrupts queued work before dispatch, and fences late terminal results', async () => {
  const coordinator = createRemoteGitCoordinator({ closeWaitMs: 10 })
  const entered = deferred()
  const release = deferred()
  let pushDispatches = 0
  const fetch = coordinator.fetch({
    scope: { repoKey: 'o/close', remote: 'origin' },
    prune: true,
    execute: async () => {
      entered.resolve()
      await release.promise
      return ''
    },
    invalidate: () => undefined,
    readback: async () => '',
  })
  await entered.promise
  const push = coordinator.push({
    scope: { repoKey: 'o/close', remote: 'origin' },
    validate: async () => ({
      attemptId: 'queued-close',
      scope: { repoKey: 'o/close', remote: 'origin' },
      operationKind: 'push',
      destinationRef: 'refs/heads/main',
      expectedOid: 'a'.repeat(40),
      expectedRemoteOid: null,
      status: 'prepared',
      preparedAt: new Date().toISOString(),
    }),
    persistAttempt: async () => undefined,
    execute: async () => {
      pushDispatches += 1
      return ''
    },
    invalidate: () => undefined,
    readback: async () => 'a'.repeat(40),
    settleAttempt: async () => undefined,
  })
  const startedAt = Date.now()
  await coordinator.close()
  assert.ok(Date.now() - startedAt < 100)
  assert.equal((await push).outcome, 'interrupted')
  assert.equal(pushDispatches, 0)
  release.resolve()
  await fetch
  const events = coordinator.lifecycleEvents()
  const terminals = events.filter((event) => event.kind === 'terminal')
  assert.equal(terminals.length, 2)
  assert.ok(terminals.every((event) => event.outcome === 'interrupted'))
  assert.equal(events.filter((event) => event.kind === 'late-result').length, 2)
  await assert.rejects(
    coordinator.lsRemote({
      scope: { repoKey: 'o/close', remote: 'origin' },
      query: 'refs/heads/main',
      execute: async () => '',
    }),
    RemoteGitClosedError,
  )
})

test('a queued push revalidates its credential inside the scope lock and rejects with zero dispatch', async () => {
  const coordinator = createRemoteGitCoordinator()
  const entered = deferred()
  const release = deferred()
  let credentialCurrent = true
  let dispatches = 0
  const blocker = coordinator.fetch({
    scope: { repoKey: 'o/credential', remote: 'origin' },
    prune: true,
    execute: async () => {
      entered.resolve()
      await release.promise
      return ''
    },
    invalidate: () => undefined,
    readback: async () => '',
  })
  await entered.promise
  const push = coordinator.push({
    scope: { repoKey: 'o/credential', remote: 'origin' },
    validate: async () => {
      if (!credentialCurrent) throw new Error('workflow revision changed while queued')
      return {
        attemptId: 'must-not-persist',
        scope: { repoKey: 'o/credential', remote: 'origin' },
        operationKind: 'push',
        destinationRef: 'refs/heads/main',
        expectedOid: 'a'.repeat(40),
        expectedRemoteOid: null,
        status: 'prepared',
        preparedAt: new Date().toISOString(),
      }
    },
    persistAttempt: async () => assert.fail('expired credential must not persist a marker'),
    execute: async () => {
      dispatches += 1
      return ''
    },
    invalidate: () => undefined,
    readback: async () => null,
    settleAttempt: async () => undefined,
  })
  credentialCurrent = false
  release.resolve()
  await blocker
  const outcome = await push
  assert.equal(outcome.outcome, 'failed')
  assert.match(outcome.error ?? '', /revision changed/)
  assert.equal(dispatches, 0)
  await coordinator.close()
})
