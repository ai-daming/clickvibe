#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const BASELINE_SHA = '9f841f1bc93604e8d802e3776997016140840e47'
const REPO_KEY = 'ai-daming/clickvibe'

export function nearestRank(values, percentile) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]
}

export function classifyCommand(command) {
  if (/(?:^|[;&|]\s*)git\s+(?:fetch|push|ls-remote)\b/.test(command)) return 'remoteGit'
  if (/^gh\s+(?:api|pr|issue)\b/.test(command)) return 'githubRest'
  if (/(?:^|[;&|]\s*)git\b/.test(command)) return 'localGit'
  if (/^(?:codex|claude)\b/.test(command)) return 'agentProcess'
  return 'other'
}

export function summarizeCommands(commands) {
  const count = (kind) => commands.filter((item) => classifyCommand(item.command) === kind).length
  return {
    physicalSubprocesses: commands.length,
    localGitSubprocesses: count('localGit'),
    remoteGitSubprocesses: count('remoteGit'),
    githubRestSubprocesses: count('githubRest'),
    agentProcessSubprocesses: count('agentProcess'),
    failures: commands.filter((item) => item.exitCode !== 0 && !item.expectedProbeMiss).length,
    expectedProbeMisses: commands.filter((item) => item.exitCode !== 0 && item.expectedProbeMiss).length,
  }
}

async function runFile(file, args, options = {}) {
  const started = performance.now()
  try {
    const result = await exec(file, args, { maxBuffer: 20 * 1024 * 1024, ...options })
    return { ...result, exitCode: 0, ms: Number((performance.now() - started).toFixed(2)) }
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
      exitCode: typeof error.code === 'number' ? error.code : 1,
      ms: Number((performance.now() - started).toFixed(2)),
    }
  }
}

async function git(args, cwd = process.cwd()) {
  const result = await runFile('git', args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

async function environment() {
  const [head, dirty, sourceDiff, node, gitVersion, ghVersion, uname] = await Promise.all([
    git(['rev-parse', 'HEAD']),
    git(['status', '--porcelain=v1']),
    runFile('git', ['diff', '--quiet', BASELINE_SHA, '--', 'src']),
    Promise.resolve(process.version),
    git(['--version']),
    runFile('gh', ['--version']),
    runFile('uname', ['-srm']),
  ])
  if (head !== BASELINE_SHA && sourceDiff.exitCode !== 0) {
    throw new Error(`src differs from accepted baseline ${BASELINE_SHA}; refusing a mixed-source measurement`)
  }
  return {
    measuredAt: new Date().toISOString(),
    acceptedBaselineSha: BASELINE_SHA,
    head,
    sourceMatchesBaseline: sourceDiff.exitCode === 0,
    dirtyPaths: dirty === '' ? [] : dirty.split('\n'),
    platform: uname.stdout.trim(),
    node,
    git: gitVersion,
    gh: ghVersion.stdout.split('\n')[0],
  }
}

export function isExpectedProbeMiss(command) {
  return (
    /^if git show-ref .*; else exit 1; fi$/.test(command) ||
    /git rev-parse --short '(?:origin\/[^']+|MERGE_HEAD)'/.test(command)
  )
}

function instrumentedContext(repoPath) {
  const commands = []
  return {
    commands,
    ctx: {
      shell: {
        resolve(spec) {
          return spec
        },
        async run(spec) {
          const result = await runFile('/bin/zsh', ['-lc', spec.command], {
            cwd: spec.workdir ?? repoPath,
            timeout: spec.timeoutMs,
            input: spec.stdin,
          })
          commands.push({
            command: spec.command,
            ms: result.ms,
            exitCode: result.exitCode,
            ...(result.exitCode !== 0 && isExpectedProbeMiss(spec.command) ? { expectedProbeMiss: true } : {}),
          })
          return {
            exitCode: result.exitCode,
            stdout: { text: result.stdout },
            stderr: { text: result.stderr },
          }
        },
      },
    },
  }
}

function workflow(number, repoPath, branch = `clickvibe-issue-${number}`) {
  return {
    key: `ai-daming-clickvibe-${number}`,
    url: `https://github.com/${REPO_KEY}/issues/${number}`,
    repoKey: REPO_KEY,
    worktree: repoPath,
    branch,
    stage: 'idle',
    devAgent: null,
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
    baseRef: `origin/main @ ${BASELINE_SHA}`,
    updatedAt: Date.now(),
    events: [],
  }
}

async function panelScenario(repoPath) {
  const { enrichWorkflowStates } = await import('../src/index.ts')
  const { ctx, commands } = instrumentedContext(repoPath)
  const item = workflow(133, repoPath, 'codex/issue-133-access-baseline')
  const rounds = []
  for (let round = 1; round <= 4; round += 1) {
    const before = commands.length
    const started = performance.now()
    const result = await enrichWorkflowStates(ctx, [structuredClone(item)], {
      repos: { [REPO_KEY]: repoPath },
      worktreeRoot: '/tmp',
    })
    rounds.push({
      round,
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      physicalSubprocesses: commands.length - before,
      ok: result.length === 1,
    })
    if (round < 4) await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return scenarioResult('panel-always-on', { workItems: 1, concurrency: 1, pollIntervalMs: 5_000 }, rounds, commands)
}

async function multiScenario(repoPath) {
  const { enrichWorkflowStates } = await import('../src/index.ts')
  const { ctx, commands } = instrumentedContext(repoPath)
  const items = [133, 134, 135, 136, 137].map((number) => workflow(number, repoPath))
  const rounds = []
  for (let round = 1; round <= 2; round += 1) {
    const before = commands.length
    const started = performance.now()
    const result = await enrichWorkflowStates(ctx, structuredClone(items), {
      repos: { [REPO_KEY]: repoPath },
      worktreeRoot: '/tmp',
    })
    rounds.push({
      round,
      elapsedMs: Number((performance.now() - started).toFixed(2)),
      physicalSubprocesses: commands.length - before,
      ok: result.length === items.length,
    })
  }
  return scenarioResult(
    'multi-work-item-refresh',
    { workItems: 5, concurrency: 5, pollIntervalMs: 0 },
    rounds,
    commands,
  )
}

async function reviewScenario(repoPath) {
  const [{ fetchIssue }, { readWorktreeHead, runCommand }] = await Promise.all([
    import('../src/github/issue.ts'),
    import('../src/infra/runtime.ts'),
  ])
  const { ctx, commands } = instrumentedContext(repoPath)
  const samples = await Promise.all(
    [122, 131, 135].map(async (number) => {
      const started = performance.now()
      const [issue, fetchOk, head] = await Promise.all([
        fetchIssue(ctx, { url: `https://github.com/${REPO_KEY}/issues/${number}`, forceRefresh: true }),
        runCommand(ctx, 'git fetch origin --prune', {
          workdir: repoPath,
          timeoutMs: 60_000,
          sandboxPolicy: { mode: 'danger-full-access', workspaceRoot: repoPath },
        }).then(
          () => true,
          () => false,
        ),
        readWorktreeHead(ctx, repoPath),
      ])
      return {
        issue: number,
        elapsedMs: Number((performance.now() - started).toFixed(2)),
        issueOk: issue.ok,
        fetchOk,
        headKnown: head !== null,
      }
    }),
  )
  return {
    scenario: 'review-dense-preflight',
    workItems: 3,
    concurrency: 3,
    roundCount: 1,
    cacheState: 'force refresh; repository aggregate may singleflight',
    samples,
    summary: {
      logicalPreflights: 3,
      ...summarizeCommands(commands),
      upstreamRequests: commands.filter((item) => ['remoteGit', 'githubRest'].includes(classifyCommand(item.command)))
        .length,
      p50Ms: nearestRank(
        samples.map((item) => item.elapsedMs),
        0.5,
      ),
      p95Ms: nearestRank(
        samples.map((item) => item.elapsedMs),
        0.95,
      ),
    },
    commands,
  }
}

function scenarioResult(name, parameters, rounds, commands) {
  return {
    scenario: name,
    ...parameters,
    roundCount: rounds.length,
    cacheState: 'cold first round; hot later rounds inside current 30s resource TTL',
    rounds,
    summary: {
      logicalScenarioRequests: rounds.length,
      ...summarizeCommands(commands),
      upstreamRequests: commands.filter((item) => ['remoteGit', 'githubRest'].includes(classifyCommand(item.command)))
        .length,
      p50Ms: nearestRank(
        rounds.map((item) => item.elapsedMs),
        0.5,
      ),
      p95Ms: nearestRank(
        rounds.map((item) => item.elapsedMs),
        0.95,
      ),
    },
    commands,
  }
}

async function isolatedWriteScenario() {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-133-write-'))
  const bare = join(root, 'remote.git')
  const worktree = join(root, 'work')
  try {
    await git(['init', '--bare', bare], root)
    await git(['init', worktree], root)
    await git(['config', 'user.name', 'ClickVibe Baseline'], worktree)
    await git(['config', 'user.email', 'baseline@example.invalid'], worktree)
    await git(['remote', 'add', 'origin', bare], worktree)
    const samples = []
    for (let round = 1; round <= 10; round += 1) {
      await writeFile(join(worktree, 'sample.txt'), String(round))
      await git(['add', 'sample.txt'], worktree)
      await git(['commit', '-m', `sample ${round}`], worktree)
      const started = performance.now()
      const pushStarted = performance.now()
      await git(['push', 'origin', 'HEAD:refs/heads/issue-133'], worktree)
      const pushMs = Number((performance.now() - pushStarted).toFixed(2))
      const readbackStarted = performance.now()
      const readback = await git(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/issue-133'], worktree)
      const readbackMs = Number((performance.now() - readbackStarted).toFixed(2))
      samples.push({
        round,
        elapsedMs: Number((performance.now() - started).toFixed(2)),
        pushMs,
        readbackMs,
        consistent: /^[0-9a-f]{40}\s+refs\/heads\/issue-133$/.test(readback),
      })
    }
    return {
      scenario: 'isolated-key-write-readback',
      remote: 'local bare temporary repository',
      workItems: 1,
      concurrency: 1,
      roundCount: 10,
      samples,
      summary: {
        logicalWrites: 10,
        physicalSubprocesses: 20,
        remoteGitUpstreamRequests: 20,
        writeReadbacks: 10,
        consistentReadbacks: samples.filter((item) => item.consistent).length,
        failures: 0,
        p50Ms: nearestRank(
          samples.map((item) => item.elapsedMs),
          0.5,
        ),
        p95Ms: nearestRank(
          samples.map((item) => item.elapsedMs),
          0.95,
        ),
      },
      githubWriteLatency: 'unknown: no dedicated test repository; production writes prohibited',
    }
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

async function rateScenario() {
  const readRate = async () => JSON.parse((await runFile('gh', ['api', 'rate_limit'])).stdout).resources.core
  const before = await readRate()
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const result = await runFile('gh', ['api', `repos/${REPO_KEY}/issues/133`])
    if (result.exitCode !== 0) throw new Error(result.stderr)
    samples.push(result.ms)
  }
  const after = await readRate()
  return {
    scenario: 'github-rest-rate-sample',
    resourceBucket: 'core',
    logicalRequests: 5,
    physicalSubprocesses: 5,
    upstreamRequests: 5,
    samplesMs: samples,
    p50Ms: nearestRank(samples, 0.5),
    p95Ms: nearestRank(samples, 0.95),
    rateLimit: {
      before: { limit: before.limit, used: before.used, remaining: before.remaining, reset: before.reset },
      after: { limit: after.limit, used: after.used, remaining: after.remaining, reset: after.reset },
      observedUsedDelta: after.used - before.used,
      contaminated: true,
      reason: 'same credential may have concurrent traffic; snapshots are not transactionally isolated',
    },
  }
}

async function main() {
  const scenario = process.argv[2]
  const runners = {
    environment: async () => ({}),
    panel: panelScenario,
    multi: multiScenario,
    review: reviewScenario,
    'isolated-write': isolatedWriteScenario,
    rate: rateScenario,
  }
  if (!(scenario in runners)) {
    throw new Error(`usage: node scripts/measure-access-baseline.mjs <${Object.keys(runners).join('|')}>`)
  }
  const repoPath = process.cwd()
  const metadata = await environment()
  const result = await runners[scenario](repoPath)
  process.stdout.write(`${JSON.stringify({ ...metadata, ...result }, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`)
    process.exitCode = 1
  })
}
