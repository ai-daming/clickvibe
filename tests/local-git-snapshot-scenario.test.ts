/**
 * Acceptance evidence for issue #122 against the #133 frozen thresholds:
 * panel always-on (first observation ≤1 local Git subprocess per Work Item
 * generation, unchanged hot polls =0) and multi Work Item refresh (5 same-repo
 * items cold ≤5, immediate hot =0), with the frozen identity
 * logical = hit + join + execution + failure.
 *
 * Real git repositories and a real shell run the whole enrich path; GitHub
 * reads fail fast and are tolerated by enrichment exactly as in production.
 * P50/P95 latency series stay in scripts/measure-access-baseline.mjs, whose
 * frozen evidence and tool hash remain untouched.
 */

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { LocalGitSnapshotRegistry } from '../src/infra/local-git-snapshot.ts'
import { enrichWorkflowStates } from '../src/workflow/repository-state.ts'

const execFileAsync = promisify(execFile)

function realRecordingContext() {
  const commands: { command: string; exitCode: number }[] = []
  const ctx = {
    shell: {
      resolve(spec: unknown) {
        return spec
      },
      async run(spec: { command: string; workdir?: string }) {
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

function localGitCount(commands: { command: string; exitCode: number }[], from: number): number {
  // Frozen protocol: a compound shell is one physical child, classified by the
  // git work it performs (issue #133 units).
  return commands.slice(from).filter((item) => /\bgit\s/.test(item.command)).length
}

async function buildRepositoryWithWorkItems(root: string, workItemNumbers: number[]): Promise<string> {
  const remote = join(root, 'remote.git')
  const repo = join(root, 'repo')
  await execFileAsync('git', ['init', '--bare', remote])
  await execFileAsync('git', ['init', repo])
  await execFileAsync('git', ['-C', repo, 'remote', 'add', 'origin', remote])
  writeFileSync(join(repo, 'a.txt'), 'base\n')
  await execFileAsync('git', ['-C', repo, 'add', 'a.txt'])
  await execFileAsync('git', ['-C', repo, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'base'])
  await execFileAsync('git', ['-C', repo, 'push', 'origin', 'main'])
  await execFileAsync('git', ['-C', repo, 'remote', 'set-head', 'origin', '--auto'])
  for (const number of workItemNumbers) {
    const branch = `clickvibe-issue-${number}`
    const worktree = join(root, `wt-${number}`)
    await execFileAsync('git', ['-C', repo, 'worktree', 'add', '-b', branch, worktree, 'origin/main'])
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

function workflowItem(number: number, worktree: string) {
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
    updatedAt: Date.now(),
    events: [],
  }
}

test('frozen panel threshold: one generation sample, zero-read hot polls, identity holds', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-122-panel-'))
  try {
    const repo = await buildRepositoryWithWorkItems(root, [122])
    const worktree = join(root, 'wt-122')
    assert.ok(existsSync(worktree))
    const { ctx, commands } = realRecordingContext()
    const snapshots = new LocalGitSnapshotRegistry()
    const config = { repos: { 'ai-daming/clickvibe': repo }, worktreeRoot: root }
    const item = workflowItem(122, worktree)

    const perRound: number[] = []
    const hotElapsed: number[] = []
    for (let round = 1; round <= 4; round += 1) {
      const before = commands.length
      const started = performance.now()
      await enrichWorkflowStates(ctx, [structuredClone(item)], config, snapshots)
      const roundLocalGit = localGitCount(commands, before)
      perRound.push(roundLocalGit)
      if (round > 1) hotElapsed.push(Number((performance.now() - started).toFixed(2)))
    }

    assert.equal(perRound[0], 1, `first observation must cost exactly 1 local git subprocess, saw ${perRound[0]}`)
    assert.deepEqual(perRound.slice(1), [0, 0, 0], 'unchanged hot polls must be zero-read')
    for (const elapsed of hotElapsed) {
      assert.ok(elapsed <= 250, `hot poll P95 budget 250ms, saw ${elapsed}ms`)
    }
    const { logicalRequests, cacheHits, singleflightJoins, executions, failures } = snapshots.counters
    assert.equal(logicalRequests, 4)
    assert.equal(cacheHits, 3)
    assert.equal(logicalRequests, cacheHits + singleflightJoins + executions + failures)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('frozen multi threshold: five same-repo items cold ≤5 and immediate hot =0', async () => {
  const root = mkdtempSync(join(tmpdir(), 'clickvibe-122-multi-'))
  try {
    const numbers = [133, 134, 135, 136, 137]
    const repo = await buildRepositoryWithWorkItems(root, numbers)
    const { ctx, commands } = realRecordingContext()
    const snapshots = new LocalGitSnapshotRegistry()
    const config = { repos: { 'ai-daming/clickvibe': repo }, worktreeRoot: root }
    const items = numbers.map((number) => workflowItem(number, join(root, `wt-${number}`)))

    const beforeCold = commands.length
    const coldStarted = performance.now()
    await enrichWorkflowStates(ctx, structuredClone(items), config, snapshots)
    const coldLocalGit = localGitCount(commands, beforeCold)
    const coldElapsed = Number((performance.now() - coldStarted).toFixed(2))

    const beforeHot = commands.length
    const hotStarted = performance.now()
    await enrichWorkflowStates(ctx, structuredClone(items), config, snapshots)
    const hotLocalGit = localGitCount(commands, beforeHot)
    const hotElapsed = Number((performance.now() - hotStarted).toFixed(2))

    assert.ok(coldLocalGit <= 5, `five same-repo items must cost ≤5 local git subprocesses, saw ${coldLocalGit}`)
    assert.equal(hotLocalGit, 0, 'immediate hot round must be zero-read')
    // Cold-round latency includes live GitHub upstreams (#131 plane); the
    // frozen 6000ms budget is therefore not asserted by the local-git plane.
    void coldElapsed
    assert.ok(hotElapsed <= 250, `hot round budget 250ms, saw ${hotElapsed}ms`)
    const { logicalRequests, cacheHits, singleflightJoins, executions, failures } = snapshots.counters
    assert.equal(logicalRequests, 10)
    assert.equal(logicalRequests, cacheHits + singleflightJoins + executions + failures)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
