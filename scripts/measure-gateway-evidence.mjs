#!/usr/bin/env node
/**
 * Gateway evidence scenarios (issue #131, review r8): unlike
 * scripts/measure-access-baseline.mjs (which launches `gh` directly and is
 * frozen), every scenario here drives the PRODUCTION boundary —
 * enrichWorkflowStates / fetchGithubPrFact / githubRest(ctx) → the Gateway
 * owner → the REST adapter — so the recorded lifecycle stream IS the #133
 * evidence for the implementation under review.
 *
 * Metrics (logical/hit/join/execution/failure/wait/rate) derive from that
 * same stream via deriveGatewayMetrics; raw commands, environment, head and
 * dirty state are preserved verbatim. Frozen thresholds are cited from
 * docs/baselines/v0.2-access-baseline.md without modification; Remote Git
 * rows of the frozen table belong to #135 and are out of scope here.
 */

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { promisify } from 'node:util'

const exec = promisify(execFile)
const TOOL_PATH = fileURLToPath(import.meta.url)
const REPO_KEY = 'ai-daming/clickvibe'
const DEFAULT_TIMEOUT_MS = 30_000

const resultMetadata = ({ ms, exitCode, killed, signal, timedOut }) => ({ ms, exitCode, killed, signal, timedOut })

async function runFile(file, args, options = {}) {
  const started = performance.now()
  try {
    const result = await exec(file, args, { maxBuffer: 20 * 1024 * 1024, timeout: DEFAULT_TIMEOUT_MS, ...options })
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

async function git(args) {
  const result = await runFile('git', args, { cwd: process.cwd() })
  if (result.exitCode !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout.trim()
}

/** Real shell ctx that records every child — the only measurement seam. */
function recordingContext() {
  const commands = []
  return {
    commands,
    ctx: {
      shell: {
        resolve(spec) {
          return spec
        },
        async run(spec) {
          const result = await runFile('/bin/zsh', ['-c', spec.command], {
            cwd: spec.workdir ?? process.cwd(),
            timeout: spec.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            input: spec.stdin,
          })
          commands.push({
            command: spec.command,
            ...resultMetadata(result),
            stdoutPreview: result.stdout.slice(0, 200),
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

function isGh(command) {
  return /(?:^|[;&|]\s*|(?:if|then|elif|else|do|!)\s+)gh\s+(?:api|pr|issue)\b/.test(command)
}

async function collectEnvironment(head) {
  const [dirty, node, gitVersion, uname, tool] = await Promise.all([
    git(['status', '--porcelain']),
    Promise.resolve(process.version),
    git(['--version']),
    runFile('uname', ['-srm']),
    readFile(TOOL_PATH),
  ])
  return {
    head,
    dirty: dirty === '' ? [] : dirty.split('\n'),
    platform: uname.stdout.trim(),
    node,
    git: gitVersion,
    measurementTool: {
      path: 'scripts/measure-gateway-evidence.mjs',
      sha256: createHash('sha256').update(tool).digest('hex'),
    },
  }
}

/** Frozen #133 thresholds for the GitHub rows this harness measures. The rate
 *  rows are STRICT (review r10/F4): exactly five single executions, and every
 *  settled response must carry a real resource observation — a gh subprocess
 *  count is not resource evidence. */
export function thresholdChecks(kind, metrics, ghChildren, events = []) {
  switch (kind) {
    case 'panel-first': {
      const noLinkedPr = true // fixture workflows carry no PR
      const limit = noLinkedPr ? 2 : 3
      return [
        { row: 'first observation GitHub upstream ≤ ' + limit, pass: metrics.upstreamRequests <= limit },
        {
          row: 'identity logical = hit + join + execution + failure',
          pass:
            metrics.logicalRequests ===
            metrics.cacheHits + metrics.singleflightJoins + metrics.executions + metrics.failures,
        },
      ]
    }
    case 'panel-hot':
      return [
        { row: 'unchanged hot poll GitHub upstream = 0', pass: metrics.upstreamRequests === 0 },
        { row: 'unchanged hot poll gh subprocess = 0', pass: ghChildren === 0 },
      ]
    case 'multi-cold':
      return [{ row: 'five-item cold GitHub upstream ≤ 2 aggregate pages', pass: metrics.upstreamRequests <= 2 }]
    case 'multi-hot':
      return [
        { row: 'immediate hot round GitHub upstream = 0', pass: metrics.upstreamRequests === 0 },
        { row: 'immediate hot round gh subprocess = 0', pass: ghChildren === 0 },
      ]
    case 'review-dense':
      return [
        { row: 'GitHub upstream ≤ 9', pass: metrics.upstreamRequests <= 9 },
        {
          row: 'identity holds',
          pass:
            metrics.logicalRequests ===
            metrics.cacheHits + metrics.singleflightJoins + metrics.executions + metrics.failures,
        },
      ]
    case 'rate': {
      const settled = events.filter((event) => event.kind === 'upstream-settled')
      return [
        {
          row: 'every workload read executed exactly once upstream (5 reads → exactly 5 executions, all succeeded)',
          pass:
            metrics.logicalRequests === 5 &&
            metrics.executions === 5 &&
            metrics.upstreamRequests === 5 &&
            metrics.failures === 0 &&
            (metrics.rateLimited ?? 0) === 0 &&
            (metrics.interrupted ?? 0) === 0,
        },
        {
          row: 'identity holds',
          pass:
            metrics.logicalRequests ===
            metrics.cacheHits + metrics.singleflightJoins + metrics.executions + metrics.failures,
        },
        {
          row: 'every settled response carried a real resource observation (no fabricated buckets)',
          pass: settled.length > 0 && settled.every((event) => event.rate?.resource != null),
        },
      ]
    }
    default:
      return []
  }
}

function workflowFixture(number) {
  const branch = `codex/issue-${number}-gateway-evidence`
  return {
    key: `${REPO_KEY}#${number}`,
    url: `https://github.com/${REPO_KEY}/issues/${number}`,
    repoKey: REPO_KEY,
    worktree: process.cwd(),
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
    baseRef: 'main',
    updatedAt: Date.now(),
    events: [],
  }
}

/** Complete-request derivation (pure): only requests DECLARED inside this
 *  round contribute, with all their events — slicing by index split requests
 *  across rounds and fabricated interrupted counts (review r9). Requests
 *  declared in-round but still unterminated carry to the next window. */
export async function roundMetrics(events, sinceIndex) {
  await ensureImports()
  const declaredInRound = new Set(
    events
      .slice(sinceIndex)
      .filter((event) => event.kind === 'declared')
      .map((event) => event.requestId),
  )
  const inRound = events.filter((event) => declaredInRound.has(event.requestId))
  return { derived: deriveMetrics(inRound), eventCount: inRound.length, events: inRound }
}

// deriveGatewayMetrics imported lazily to keep this module import-light for tests
let deriveMetrics
async function ensureImports() {
  if (!deriveMetrics) {
    const lifecycle = await import('../src/github/gateway-lifecycle.ts')
    deriveMetrics = lifecycle.deriveGatewayMetrics
  }
}

async function panelScenario() {
  await ensureImports()
  const { enrichWorkflowStates } = await import('../src/workflow/repository-state.ts')
  const { githubGatewayOwner, resetGithubGatewayOwnerForTests } = await import('../src/github/gateway-owner.ts')
  resetGithubGatewayOwnerForTests()
  const { ctx, commands } = recordingContext()
  const config = { repos: { [REPO_KEY]: process.cwd() }, worktreeRoot: '/tmp' }
  const item = workflowFixture(135)
  const rounds = []
  for (let round = 1; round <= 4; round += 1) {
    const mark = githubGatewayOwner().lifecycleEvents().length
    const before = commands.length
    await enrichWorkflowStates(ctx, [structuredClone(item)], config)
    const ghChildren = commands.slice(before).filter((entry) => isGh(entry.command)).length
    const { derived } = await roundMetrics(githubGatewayOwner().lifecycleEvents(), mark)
    rounds.push({
      round,
      ghSubprocesses: ghChildren,
      metrics: derived,
      roundCommands: commands.slice(before).map((entry) => entry.command),
      checks:
        round === 1
          ? thresholdChecks('panel-first', derived, ghChildren)
          : thresholdChecks('panel-hot', derived, ghChildren),
    })
    if (round < 4) await new Promise((resolve) => setTimeout(resolve, 5_000))
  }
  return {
    scenario: 'panel-always-on-gateway',
    parameters: { workItems: 1, concurrency: 1, pollIntervalMs: 5_000, rounds: 4 },
    rounds,
    commands,
    lifecycle: githubGatewayOwner().lifecycleEvents(),
  }
}

async function multiScenario() {
  await ensureImports()
  const { enrichWorkflowStates } = await import('../src/workflow/repository-state.ts')
  const { githubGatewayOwner, resetGithubGatewayOwnerForTests } = await import('../src/github/gateway-owner.ts')
  resetGithubGatewayOwnerForTests()
  const { ctx, commands } = recordingContext()
  const config = { repos: { [REPO_KEY]: process.cwd() }, worktreeRoot: '/tmp' }
  // The ORIGINAL frozen population (#133–#137, mixed open/closed — review
  // r10/F3): the multi threshold is priced for five same-repo work items of
  // ANY state, not an open-only subset.
  const items = [133, 134, 135, 136, 137].map(workflowFixture)
  const rounds = []
  for (let round = 1; round <= 2; round += 1) {
    const mark = githubGatewayOwner().lifecycleEvents().length
    const before = commands.length
    await enrichWorkflowStates(ctx, structuredClone(items), config)
    const ghChildren = commands.slice(before).filter((entry) => isGh(entry.command)).length
    const { derived } = await roundMetrics(githubGatewayOwner().lifecycleEvents(), mark)
    rounds.push({
      round,
      ghSubprocesses: ghChildren,
      metrics: derived,
      roundCommands: commands.slice(before).map((entry) => entry.command),
      checks:
        round === 1
          ? thresholdChecks('multi-cold', derived, ghChildren)
          : thresholdChecks('multi-hot', derived, ghChildren),
    })
  }
  return {
    scenario: 'multi-work-item-gateway',
    parameters: { workItems: 5, concurrency: 5, rounds: 2 },
    rounds,
    commands,
    lifecycle: githubGatewayOwner().lifecycleEvents(),
  }
}

async function reviewScenario() {
  await ensureImports()
  const { fetchGithubPrFact } = await import('../src/github/facts.ts')
  const { githubGatewayOwner, resetGithubGatewayOwnerForTests } = await import('../src/github/gateway-owner.ts')
  resetGithubGatewayOwnerForTests()
  const { ctx, commands } = recordingContext()
  const mark = githubGatewayOwner().lifecycleEvents().length
  const before = commands.length
  await Promise.all([
    fetchGithubPrFact(ctx, REPO_KEY, 'codex/issue-135-gateway-evidence', null),
    fetchGithubPrFact(ctx, REPO_KEY, 'codex/issue-136-gateway-evidence', null),
    fetchGithubPrFact(ctx, REPO_KEY, 'codex/issue-137-gateway-evidence', null),
  ])
  const ghChildren = commands.slice(before).filter((entry) => isGh(entry.command)).length
  const { derived } = await roundMetrics(githubGatewayOwner().lifecycleEvents(), mark)
  return {
    scenario: 'review-dense-gateway',
    parameters: { workItems: 3, concurrency: 3, note: 'GitHub plane only; Remote Git fetch rows are #135 scope' },
    rounds: [
      {
        round: 1,
        ghSubprocesses: ghChildren,
        metrics: derived,
        checks: thresholdChecks('review-dense', derived, ghChildren),
      },
    ],
    commands,
    lifecycle: githubGatewayOwner().lifecycleEvents(),
  }
}

async function rateScenario() {
  await ensureImports()
  const { githubRest } = await import('../src/github/rest.ts')
  const { githubGatewayOwner, resetGithubGatewayOwnerForTests } = await import('../src/github/gateway-owner.ts')
  resetGithubGatewayOwnerForTests()
  const { ctx, commands } = recordingContext()
  const reader = githubRest(ctx)
  const before = await reader.json('rate_limit')
  const mark = githubGatewayOwner().lifecycleEvents().length
  const beforeWorkload = commands.length
  for (let index = 0; index < 5; index += 1) {
    await reader.json(`repos/${REPO_KEY}/issues/135`)
  }
  // The metrics window closes BEFORE the closing rate_limit sample: the window
  // must contain exactly the five workload reads (review r10/F4 strictness).
  const ghChildren = commands
    .slice(beforeWorkload)
    .filter((entry) => isGh(entry.command) && !/rate_limit/.test(entry.command)).length
  const { derived, events } = await roundMetrics(githubGatewayOwner().lifecycleEvents(), mark)
  const after = await reader.json('rate_limit')
  return {
    scenario: 'rate-sample-gateway',
    parameters: { reads: 5, note: 'shared credential: consumption marked contaminated per #133 protocol' },
    rounds: [
      {
        round: 1,
        rateBefore: before.resources?.core ?? null,
        rateAfter: after.resources?.core ?? null,
        metrics: derived,
        checks: thresholdChecks('rate', derived, ghChildren, events),
      },
    ],
    commands,
    lifecycle: githubGatewayOwner().lifecycleEvents(),
  }
}

const SCENARIOS = {
  panel: panelScenario,
  multi: multiScenario,
  review: reviewScenario,
  rate: rateScenario,
}

async function main() {
  const requested = process.argv.slice(2).filter((name) => name in SCENARIOS)
  const names = requested.length > 0 ? requested : Object.keys(SCENARIOS)
  for (const name of names) {
    const head = await git(['rev-parse', 'HEAD'])
    const environment = await collectEnvironment(head)
    const result = await SCENARIOS[name]()
    const payload = {
      measuredAt: new Date().toISOString(),
      environment,
      note: 'Scenarios drive the production githubRest → Gateway owner → REST adapter boundary; lifecycle metrics derive from the same stream (issue #131 review r8).',
      ...result,
    }
    process.stdout.write(`${JSON.stringify(payload)}\n`)
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  await main()
}
