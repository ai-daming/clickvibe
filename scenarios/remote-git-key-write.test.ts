/**
 * Isolated #133 key Remote Git write gate. This file intentionally lives
 * outside tests/*.test.ts so the latency series does not compete with the
 * parallel unit suite. CI runs it as a dedicated, concurrency-one step.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
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

test('#133 isolated key write meets count, ordering, equality and P95 thresholds', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-remote-git-write-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const coordinator = createRemoteGitCoordinator()
  const durations: number[] = []
  let invalidations = 0
  try {
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['init', repo])
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'clickvibe-test'])
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'clickvibe-test@example.invalid'])
    await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote])

    for (let round = 1; round <= 10; round += 1) {
      await execFileAsync('git', ['-C', repo, 'commit', '--allow-empty', '-m', `round ${round}`])
      const expectedOid = (await execFileAsync('git', ['-C', repo, 'rev-parse', 'HEAD'])).stdout.trim()
      const attempt: RemoteGitWriteAttempt = {
        attemptId: `threshold-${round}`,
        scope: { repoKey: 'o/key-write-threshold', remote: 'origin' },
        operationKind: 'push',
        destinationRef: 'refs/heads/threshold',
        expectedOid,
        expectedRemoteOid: null,
        status: 'prepared',
        preparedAt: new Date().toISOString(),
      }
      const startedAt = performance.now()
      const outcome = await coordinator.push({
        scope: attempt.scope,
        validate: async () => attempt,
        persistAttempt: async () => undefined,
        execute: async (plan) => {
          const result = await execFileAsync('git', [
            '-C',
            repo,
            'push',
            'origin',
            `${plan.expectedOid}:${plan.destinationRef}`,
          ])
          return result.stdout
        },
        invalidate: () => {
          invalidations += 1
        },
        readback: async (plan) => {
          const result = await execFileAsync('git', ['-C', repo, 'ls-remote', '--heads', 'origin', plan.destinationRef])
          return result.stdout.trim().split(/\s+/)[0] || null
        },
        settleAttempt: async () => undefined,
      })
      durations.push(performance.now() - startedAt)
      assert.equal(outcome.outcome, 'confirmed')
    }

    const p95 = durations.toSorted((left, right) => left - right)[Math.ceil(durations.length * 0.95) - 1]
    context.diagnostic(`key Remote Git write local-bare P95=${p95.toFixed(2)}ms`)
    assert.ok(p95 <= 93, `key Remote Git write P95 ${p95.toFixed(2)}ms exceeded 93ms`)

    const events = coordinator.lifecycleEvents()
    const metrics = deriveRemoteGitMetrics(events)
    assert.equal(metrics.logicalRequests, 10)
    assert.equal(metrics.executions, 10)
    assert.equal(metrics.upstreamRequests, 20)
    assert.equal(metrics.invalidations, 10)
    assert.equal(metrics.writeReadbacks, 10)
    assert.equal(invalidations, 10)
    for (const requestId of new Set(events.map((event) => event.requestId))) {
      const phases = events.filter((event) => event.requestId === requestId).map((event) => event.kind)
      assert.ok(phases.indexOf('invalidated') < phases.indexOf('readback-settled'))
      assert.ok(phases.indexOf('readback-settled') < phases.indexOf('terminal'))
    }
  } finally {
    await coordinator.close()
    await rm(root, { recursive: true, force: true })
  }
})
