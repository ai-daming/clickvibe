#!/usr/bin/env node

import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const DEFAULT_BASELINE_SHA = '9f841f1bc93604e8d802e3776997016140840e47'
const REPO_KEY = 'ai-daming/clickvibe'
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000
const TOOL_PATH = fileURLToPath(import.meta.url)
const SHELL_PREFIX = String.raw`(?:^|[;&|]\s*|(?:if|then|elif|else|do|!)\s+)`
const ENV_PREFIX = String.raw`(?:[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|\S*)\s+)*`
const resultMetadata = ({ ms, exitCode, killed, signal, timedOut }) => ({ ms, exitCode, killed, signal, timedOut })
function selectedBaselineSha() {
  return process.env.CLICKVIBE_ACCESS_BASELINE_SHA ?? DEFAULT_BASELINE_SHA
}
export function nearestRank(values, percentile) {
  if (values.length === 0) return null
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.max(0, Math.ceil(sorted.length * percentile) - 1)]
}

export function classifyCommand(command) {
  const git = `${SHELL_PREFIX}${ENV_PREFIX}git(?:\\s+-C\\s+(?:'[^']*'|"[^"]*"|\\S+))?`
  if (new RegExp(`${git}\\s+(?:fetch|push|ls-remote)\\b`).test(command)) return 'remoteGit'
  if (new RegExp(`${SHELL_PREFIX}${ENV_PREFIX}gh\\s+(?:api|pr|issue)\\b`).test(command)) {
    return 'githubRest'
  }
  if (new RegExp(`${git}\\b`).test(command)) return 'localGit'
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
    const result = await exec(file, args, {
      maxBuffer: 20 * 1024 * 1024,
      timeout: DEFAULT_COMMAND_TIMEOUT_MS,
      ...options,
    })
    return { ...result, exitCode: 0, ms: Number((performance.now() - started).toFixed(2)) }
  } catch (error) {
    return {
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? String(error),
      exitCode: typeof error.code === 'number' ? error.code : 1,
      killed: error.killed === true,
      signal: error.signal ?? null,
      timedOut: error.code === 'ETIMEDOUT' || (error.killed === true && error.signal === 'SIGTERM'),
      ms: Number((performance.now() - started).toFixed(2)),
    }
  }
}

async function git(args, cwd = process.cwd()) {
  const result = await runFile('git', args, { cwd })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

export async function collectEnvironment(repoPath = process.cwd(), baselineSha = selectedBaselineSha()) {
  const root = await git(['rev-parse', '--show-toplevel'], repoPath)
  const baselineCheck = await runFile('git', ['cat-file', '-e', `${baselineSha}^{commit}`], { cwd: root })
  if (baselineCheck.exitCode !== 0) {
    throw new Error(
      `accepted baseline ${baselineSha} is unavailable: ${baselineCheck.stderr.trim() || 'git cat-file failed'}`,
    )
  }
  const [head, dirty, sourceDiff, untrackedSource, ignoredSource, node, gitVersion, ghVersion, uname, toolContents] =
    await Promise.all([
      git(['rev-parse', 'HEAD'], root),
      git(['status', '--porcelain=v1'], root),
      runFile('git', ['diff', '--quiet', baselineSha, '--', ':(top)src'], { cwd: root }),
      runFile('git', ['ls-files', '--others', '--exclude-standard', '--', ':(top)src'], { cwd: root }),
      runFile('git', ['ls-files', '--others', '--ignored', '--exclude-standard', '--', ':(top)src'], { cwd: root }),
      Promise.resolve(process.version),
      git(['--version'], root),
      runFile('gh', ['--version']),
      runFile('uname', ['-srm']),
      readFile(TOOL_PATH),
    ])
  if (sourceDiff.exitCode > 1) {
    throw new Error(`cannot compare src with accepted baseline ${baselineSha}: ${sourceDiff.stderr.trim()}`)
  }
  if (untrackedSource.exitCode !== 0) {
    throw new Error(`cannot enumerate untracked src paths: ${untrackedSource.stderr.trim()}`)
  }
  if (ignoredSource.exitCode !== 0)
    throw new Error(`cannot enumerate ignored src paths: ${ignoredSource.stderr.trim()}`)
  const untrackedSourcePaths = untrackedSource.stdout.trim() === '' ? [] : untrackedSource.stdout.trim().split('\n')
  const ignoredSourcePaths = ignoredSource.stdout.trim() === '' ? [] : ignoredSource.stdout.trim().split('\n')
  const trackedSourceDiffers = sourceDiff.exitCode === 1
  if (trackedSourceDiffers || untrackedSourcePaths.length > 0 || ignoredSourcePaths.length > 0) {
    const reasons = [
      ...(trackedSourceDiffers ? ['tracked source differs'] : []),
      ...(untrackedSourcePaths.length > 0 ? ['untracked source exists'] : []),
      ...(ignoredSourcePaths.length > 0 ? ['ignored source exists'] : []),
    ]
    throw new Error(
      `src differs from accepted baseline ${baselineSha}: ${reasons.join('; ')}; refusing a mixed-source measurement`,
    )
  }
  return {
    scenario: 'environment',
    measuredAt: new Date().toISOString(),
    acceptedBaselineSha: baselineSha,
    head,
    sourceMatchesBaseline: true,
    untrackedSourcePaths,
    ignoredSourcePaths,
    dirtyPaths: dirty === '' ? [] : dirty.split('\n'),
    platform: uname.stdout.trim(),
    node,
    git: gitVersion,
    gh: {
      available: ghVersion.exitCode === 0,
      version: ghVersion.exitCode === 0 ? ghVersion.stdout.split('\n')[0] : null,
      error: ghVersion.exitCode === 0 ? null : ghVersion.stderr.trim() || 'gh --version failed',
    },
    measurementTool: {
      path: 'scripts/measure-access-baseline.mjs',
      sha256: createHash('sha256').update(toolContents).digest('hex'),
    },
  }
}

export function isExpectedProbeMiss(command) {
  const branch = "(?:clickvibe-issue-\\d+|codex/issue-\\d+(?:-[^']+)?)"
  return (
    new RegExp(`^if git show-ref .*refs/heads/${branch}.*refs/remotes/origin/${branch}.*; else exit 1; fi$`).test(
      command,
    ) || new RegExp(`git rev-parse --short '(?:origin/${branch}|MERGE_HEAD)'`).test(command)
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
          const timeoutMs = spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
          const result = await runFile('/bin/zsh', ['-c', spec.command], {
            cwd: spec.workdir ?? repoPath,
            timeout: timeoutMs,
            input: spec.stdin,
          })
          commands.push({
            command: spec.command,
            timeoutMs,
            sandboxMode: spec.sandboxPolicy?.mode ?? null,
            ...resultMetadata(result),
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
    baseRef: `origin/main @ ${selectedBaselineSha()}`,
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

export function readbackMatches(localSha, readback, expectedRef) {
  const [remoteSha, remoteRef, ...extra] = readback.trim().split(/\s+/)
  return extra.length === 0 && remoteSha === localSha && remoteRef === expectedRef
}

export async function isolatedWriteScenario() {
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
      const localShaStarted = performance.now()
      const localSha = await git(['rev-parse', 'HEAD'], worktree)
      const localShaMs = Number((performance.now() - localShaStarted).toFixed(2))
      const pushStarted = performance.now()
      await git(['push', 'origin', 'HEAD:refs/heads/issue-133'], worktree)
      const pushMs = Number((performance.now() - pushStarted).toFixed(2))
      const readbackStarted = performance.now()
      const readback = await git(['ls-remote', '--exit-code', '--heads', 'origin', 'refs/heads/issue-133'], worktree)
      const readbackMs = Number((performance.now() - readbackStarted).toFixed(2))
      const [remoteSha] = readback.split(/\s+/)
      samples.push({
        round,
        elapsedMs: Number((performance.now() - started).toFixed(2)),
        localShaMs,
        pushMs,
        readbackMs,
        localSha,
        remoteSha,
        consistent: readbackMatches(localSha, readback, 'refs/heads/issue-133'),
      })
    }
    return {
      scenario: 'isolated-key-write-readback',
      remote: 'local bare temporary repository',
      workItems: 1,
      concurrency: 1,
      roundCount: samples.length,
      samples,
      summary: {
        logicalWrites: samples.length,
        physicalSubprocesses: samples.length * 3,
        localGitSubprocesses: samples.length,
        remoteGitSubprocesses: samples.length * 2,
        remoteGitUpstreamRequests: samples.length * 2,
        writeReadbacks: samples.length,
        consistentReadbacks: samples.filter((item) => item.consistent).length,
        failures: samples.filter((item) => !item.consistent).length,
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

export function parseCoreRateLimit(result) {
  if (result.exitCode !== 0) throw new Error(result.stderr || 'gh api rate_limit failed')
  let parsed
  try {
    parsed = JSON.parse(result.stdout)
  } catch (error) {
    throw new Error(
      `gh api rate_limit returned invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  const core = parsed?.resources?.core
  if (!core || !['limit', 'used', 'remaining', 'reset'].every((field) => typeof core[field] === 'number')) {
    throw new Error('gh api rate_limit response is missing numeric resources.core fields')
  }
  return { limit: core.limit, used: core.used, remaining: core.remaining, reset: core.reset }
}

export async function rateScenario(run = runFile) {
  const commands = []
  const runGh = async (args) => {
    const result = await run('gh', args)
    commands.push({
      command: `gh ${args.join(' ')}`,
      ...resultMetadata(result),
    })
    return result
  }
  const readRate = async () => parseCoreRateLimit(await runGh(['api', 'rate_limit']))
  const before = await readRate()
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const result = await runGh(['api', `repos/${REPO_KEY}/issues/133`])
    if (result.exitCode !== 0) throw new Error(result.stderr)
    samples.push(result.ms)
  }
  const after = await readRate()
  return {
    scenario: 'github-rest-rate-sample',
    resourceBucket: 'core',
    logicalRequests: 5,
    measurementRequests: 2,
    physicalSubprocesses: commands.length,
    upstreamRequests: commands.length,
    commands,
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
    environment: async () => null,
    panel: panelScenario,
    multi: multiScenario,
    review: reviewScenario,
    'isolated-write': isolatedWriteScenario,
    rate: () => rateScenario(),
  }
  if (!Object.hasOwn(runners, scenario)) {
    throw new Error(`usage: node scripts/measure-access-baseline.mjs <${Object.keys(runners).join('|')}>`)
  }
  const repoPath = process.cwd()
  const metadata = await collectEnvironment(repoPath)
  const result = await runners[scenario](repoPath)
  process.stdout.write(`${JSON.stringify(result === null ? metadata : { ...metadata, ...result }, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${String(error instanceof Error ? error.message : error)}\n`)
    process.exitCode = 1
  })
}
