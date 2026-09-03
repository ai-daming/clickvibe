/**
 * v0.2 final acceptance harness (ADR-0013 §2, issue #137 AC6/AC7/AC8).
 *
 * Runs the #133 frozen multi-Work-Item scenario and asserts the frozen count
 * thresholds across all three access planes. Structural constraint: the ONLY
 * metric sources are the three existing derivations — the Local Git snapshot
 * registry counters, `deriveGatewayMetrics`, and `deriveRemoteGitMetrics`.
 * No fourth counting system exists in this file; the intercepted shell command
 * list is retained solely as failure evidence and never feeds an assertion.
 *
 * Threshold provenance: docs/baselines/v0.2-access-baseline.md, frozen rows
 * "Multi Work Item refresh" and "Panel enrichment always on". Counts are
 * authoritative; latency stays with the frozen reproducer (hash-guarded).
 */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'
import test from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { githubGatewayOwner, resetGithubGatewayOwnerForTests } from '../src/github/gateway-owner.ts'
import { deriveGatewayMetrics } from '../src/github/gateway-lifecycle.ts'
import { deriveRemoteGitMetrics } from '../src/infra/remote-git-lifecycle.ts'
import { remoteGitCoordinator } from '../src/infra/remote-git.ts'
import { LocalGitSnapshotRegistry } from '../src/infra/local-git-snapshot.ts'
import { enrichWorkflowStates } from '../src/workflow/repository-state.ts'

const execFileAsync = promisify(execFile)

function evidence(commands: { command: string; exitCode: number }[]): string {
  return commands.map((item) => `[exit ${item.exitCode}] ${item.command}`).join('\n')
}

function realOfflineGithubContext() {
  const commands: { command: string; exitCode: number }[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; workdir?: string }) {
        // gh is intercepted offline exactly as in the #122 frozen scenarios;
        // the gateway still records every attempted upstream.
        if (/^gh\b|\sgh\b/.test(spec.command)) {
          commands.push({ command: spec.command, exitCode: 1 })
          return { exitCode: 1, stdout: { text: '' }, stderr: { text: 'offline final-acceptance' } }
        }
        try {
          const out = await execFileAsync('/bin/sh', ['-c', spec.command], {
            cwd: spec.workdir,
            encoding: 'utf8',
            maxBuffer: 1024 * 1024,
          })
          commands.push({ command: spec.command, exitCode: 0 })
          return { exitCode: 0, stdout: { text: out.stdout }, stderr: { text: out.stderr } }
        } catch (error) {
          const detail = error as { code?: number; stdout?: string; stderr?: string }
          commands.push({ command: spec.command, exitCode: detail.code ?? 1 })
          return {
            exitCode: detail.code ?? 1,
            stdout: { text: detail.stdout ?? '' },
            stderr: { text: detail.stderr ?? '' },
          }
        }
      },
    },
  } as unknown as Context
  return { ctx, commands }
}

async function buildRepositoryWithWorkItems(root: string, numbers: number[]): Promise<string> {
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  await execFileAsync('git', ['init', '--bare', '--initial-branch=main', remote])
  await execFileAsync('git', ['init', '--initial-branch=main', repo])
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  await execFileAsync('git', ['-C', repo, 'add', 'a.txt'])
  await execFileAsync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])
  await execFileAsync('git', ['-C', repo, 'push', 'origin', 'main'])
  await execFileAsync('git', ['-C', repo, 'remote', 'set-head', 'origin', '--auto'])
  for (const number of numbers) {
    const worktree = join(root, `wt-${number}`)
    await execFileAsync('git', [
      '-C',
      repo,
      'worktree',
      'add',
      '-b',
      `clickvibe-issue-${number}`,
      worktree,
      'origin/main',
    ])
    writeFileSync(join(worktree, `n-${number}.txt`), `${number}\n`)
    await execFileAsync('git', ['-C', worktree, 'add', '.'])
    await execFileAsync('git', [
      '-C',
      worktree,
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '-m',
      `wip ${number}`,
    ])
  }
  return repo
}

function workItem(number: number, worktree: string) {
  return {
    key: `ai-daming/clickvibe#${number}`,
    url: `https://github.com/ai-daming/clickvibe/issues/${number}`,
    repoKey: 'ai-daming/clickvibe',
    worktree,
    branch: `clickvibe-issue-${number}`,
    stage: 'developing' as const,
    devAgent: 'codex' as const,
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
    issueState: 'OPEN' as const,
    baseRef: 'main',
    updatedAt: 0,
    events: [],
  }
}

test('frozen multi-work-item thresholds hold across all three access planes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-final-multi-'))
  resetGithubGatewayOwnerForTests()
  remoteGitCoordinator().clearFreshness()
  try {
    const numbers = [133, 134, 135, 136, 137]
    const repo = await buildRepositoryWithWorkItems(root, numbers)
    for (const number of numbers) assert.ok(existsSync(join(root, `wt-${number}`)))
    const { ctx, commands } = realOfflineGithubContext()
    const snapshots = new LocalGitSnapshotRegistry()
    const config = { repos: { 'ai-daming/clickvibe': repo }, worktreeRoot: root }
    const items = numbers.map((number) => workItem(number, join(root, `wt-${number}`)))

    const coldStarted = performance.now()
    await enrichWorkflowStates(ctx, structuredClone(items), config, snapshots)
    const coldElapsed = performance.now() - coldStarted
    const localCold = { ...snapshots.counters }
    const gatewayCold = deriveGatewayMetrics(githubGatewayOwner().lifecycleEvents())
    const remoteCold = deriveRemoteGitMetrics(remoteGitCoordinator().lifecycleEvents())

    const hotStarted = performance.now()
    await enrichWorkflowStates(ctx, structuredClone(items), config, snapshots)
    const hotElapsed = performance.now() - hotStarted
    const localHot = { ...snapshots.counters }
    const gatewayHot = deriveGatewayMetrics(githubGatewayOwner().lifecycleEvents())
    const remoteHot = deriveRemoteGitMetrics(remoteGitCoordinator().lifecycleEvents())

    const planes = `\nlocal-cold=${JSON.stringify(localCold)}\nlocal-hot=${JSON.stringify(localHot)}\ngateway-cold=${JSON.stringify(gatewayCold)}\ngateway-hot=${JSON.stringify(gatewayHot)}\nremote-cold=${JSON.stringify(remoteCold)}\nremote-hot=${JSON.stringify(remoteHot)}\ncommands:\n${evidence(commands)}`

    // Local Git plane (frozen row: five same-repo items cold ≤5; hot =0).
    assert.ok(
      localCold.executions <= 5,
      `cold local-git executions must be ≤5 (frozen multi threshold); saw ${localCold.executions}.${planes}`,
    )
    assert.equal(
      localHot.executions - localCold.executions,
      0,
      `immediate hot round must add zero local-git executions (frozen multi threshold).${planes}`,
    )
    assert.equal(
      localHot.logicalRequests,
      localHot.cacheHits + localHot.singleflightJoins + localHot.executions + localHot.failures,
      `local-git identity logical = hit + join + execution + failure must hold.${planes}`,
    )

    // GitHub REST plane (frozen row: ≤2 aggregate upstream pages; hot =0).
    assert.ok(
      gatewayCold.executions <= 2,
      `cold github upstream executions must be ≤2 for the one-page repo (frozen multi threshold); saw ${gatewayCold.executions}.${planes}`,
    )
    assert.equal(
      gatewayHot.executions - gatewayCold.executions,
      0,
      `immediate hot round must add zero github upstream executions (frozen multi threshold).${planes}`,
    )

    // Remote Git plane (frozen multi row counts Local Git and GitHub only;
    // the enrichment path must not start remote fetches in either round).
    assert.equal(
      remoteCold.upstreamRequests,
      0,
      `multi-work-item enrichment must not issue remote-git upstream requests cold.${planes}`,
    )
    assert.equal(
      remoteHot.upstreamRequests - remoteCold.upstreamRequests,
      0,
      `multi-work-item enrichment must not issue remote-git upstream requests hot.${planes}`,
    )

    // Latency stays descriptive (frozen reproducer owns the budgets);
    // hang-guards only, identical to the #122 scenario harness.
    assert.ok(coldElapsed <= 60_000, `cold round hang-guard 60s, saw ${coldElapsed}ms.${planes}`)
    assert.ok(hotElapsed <= 30_000, `hot round hang-guard 30s, saw ${hotElapsed}ms.${planes}`)
  } finally {
    await githubGatewayOwner()
      .close({ drainMs: 0 })
      .catch(() => undefined)
    resetGithubGatewayOwnerForTests()
    remoteGitCoordinator().clearFreshness()
    rmSync(root, { recursive: true, force: true })
  }
})
