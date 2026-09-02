import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { createGithubGatewayOwner } from '../src/github/gateway-owner.ts'
import { deriveGatewayMetrics } from '../src/github/gateway-lifecycle.ts'
import { GithubRestReader } from '../src/github/rest.ts'
import { createRemoteGitCoordinator, deriveRemoteGitMetrics } from '../src/infra/remote-git-coordinator.ts'

const execFileAsync = promisify(execFile)

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void
  const promise = new Promise<void>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('#133 review-dense keeps Remote Git at 1+2 joins, GitHub at most 9 and total upstream at most 10', async () => {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-review-dense-'))
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  const remoteOwner = createRemoteGitCoordinator()
  const githubOwner = createGithubGatewayOwner()
  const fetchEntered = deferred()
  const releaseFetch = deferred()
  const githubCommands: string[] = []
  try {
    await execFileAsync('git', ['init', '--bare', remote])
    await execFileAsync('git', ['clone', remote, repo])
    await execFileAsync('git', ['-C', repo, 'config', 'user.name', 'clickvibe-test'])
    await execFileAsync('git', ['-C', repo, 'config', 'user.email', 'clickvibe-test@example.invalid'])
    await execFileAsync('git', ['-C', repo, 'commit', '--allow-empty', '-m', 'base'])
    await execFileAsync('git', ['-C', repo, 'branch', '-M', 'main'])
    await execFileAsync('git', ['-C', repo, 'push', '-u', 'origin', 'main'])

    const ctx = {
      shell: {
        resolve(spec: unknown) {
          return spec
        },
        async run(spec: { command: string }) {
          githubCommands.push(spec.command)
          const body = spec.command.includes('/reviews')
            ? []
            : [
                {
                  number: githubCommands.length,
                  state: 'open',
                  merged_at: null,
                  updated_at: '2026-09-02T00:00:00Z',
                  head: { ref: 'review', sha: 'a'.repeat(40) },
                  base: { ref: 'main', sha: 'b'.repeat(40) },
                },
              ]
          return {
            exitCode: 0,
            stdout: {
              text: [
                'HTTP/1.1 200 OK',
                'x-ratelimit-resource: core',
                'x-ratelimit-limit: 5000',
                'x-ratelimit-remaining: 4999',
                'x-ratelimit-used: 1',
                'x-ratelimit-reset: 4102444800',
                '',
                JSON.stringify(body),
              ].join('\n'),
            },
            stderr: { text: '' },
          }
        },
      },
    }
    const github = new GithubRestReader(ctx as never, { owner: githubOwner, minimumIntervalMs: 0 })
    let physicalFetches = 0
    const githubPrFact = async (workItem: number) => {
      const [pr] = await github.json<Array<{ number: number }>>(
        `repos/o/review-dense/pulls?state=all&head=o%3Areview-${workItem}&per_page=1`,
      )
      await github.json(`repos/o/review-dense/pulls/${pr.number}/reviews`)
    }
    const reviewPreflight = (workItem: number) =>
      Promise.all([
        remoteOwner.fetch({
          scope: { repoKey: 'o/review-dense', remote: 'origin' },
          prune: true,
          execute: async () => {
            physicalFetches += 1
            fetchEntered.resolve()
            await releaseFetch.promise
            return (await execFileAsync('git', ['-C', repo, 'fetch', 'origin', '--prune'])).stdout
          },
          invalidate: () => undefined,
          readback: async () =>
            (
              await execFileAsync('git', [
                '-C',
                repo,
                'for-each-ref',
                '--format=%(refname) %(objectname)',
                'refs/remotes/origin',
              ])
            ).stdout,
        }),
        githubPrFact(workItem),
      ])

    const reviews = [reviewPreflight(1), reviewPreflight(2), reviewPreflight(3)]
    await fetchEntered.promise
    await new Promise<void>((resolve) => setImmediate(resolve))
    releaseFetch.resolve()
    await Promise.all(reviews)

    const remoteMetrics = deriveRemoteGitMetrics(remoteOwner.lifecycleEvents())
    const githubMetrics = deriveGatewayMetrics(githubOwner.lifecycleEvents())
    assert.equal(physicalFetches, 1)
    assert.equal(remoteMetrics.upstreamRequests, 1)
    assert.equal(remoteMetrics.singleflightJoins, 2)
    assert.equal(githubMetrics.logicalRequests, 6)
    assert.equal(githubMetrics.executions, 6)
    assert.equal(githubMetrics.failures, 0)
    assert.equal(githubMetrics.upstreamRequests, githubCommands.length)
    assert.equal(githubMetrics.upstreamRequests, 6)
    assert.ok(githubMetrics.upstreamRequests <= 9, `GitHub upstream=${githubMetrics.upstreamRequests}`)
    assert.ok(
      remoteMetrics.upstreamRequests + githubMetrics.upstreamRequests <= 10,
      `total upstream=${remoteMetrics.upstreamRequests + githubMetrics.upstreamRequests}`,
    )
  } finally {
    releaseFetch.resolve()
    await remoteOwner.close()
    await githubOwner.close({ drainMs: 50 })
    await rm(root, { recursive: true, force: true })
  }
})
