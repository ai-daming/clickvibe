import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import {
  classifyCommand,
  collectEnvironment,
  isExpectedProbeMiss,
  isolatedWriteScenario,
  nearestRank,
  parseCoreRateLimit,
  readbackMatches,
  summarizeCommands,
} from '../scripts/measure-access-baseline.mjs'

const scriptPath = join(process.cwd(), 'scripts', 'measure-access-baseline.mjs')

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()
}

async function gitFixture(withTrackedSource: boolean): Promise<{ baseline: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), 'clickvibe-access-baseline-'))
  runGit(root, 'init')
  runGit(root, 'config', 'user.name', 'Access Baseline Test')
  runGit(root, 'config', 'user.email', 'access-baseline@example.invalid')
  await writeFile(join(root, 'README.md'), 'fixture\n')
  if (withTrackedSource) {
    await mkdir(join(root, 'src'))
    await writeFile(join(root, 'src', 'index.ts'), 'export const value = 1\n')
  }
  runGit(root, 'add', '.')
  runGit(root, 'commit', '-m', 'baseline')
  return { baseline: runGit(root, 'rev-parse', 'HEAD'), root }
}

test('access baseline uses nearest-rank percentiles without inventing missing samples', () => {
  assert.equal(nearestRank([30, 10, 20, 40], 0.5), 20)
  assert.equal(nearestRank([30, 10, 20, 40], 0.95), 40)
  assert.equal(nearestRank([], 0.95), null)
})

test('access baseline keeps local, remote, GitHub and agent process costs separate', () => {
  assert.equal(classifyCommand('git status --porcelain'), 'localGit')
  assert.equal(classifyCommand("if git show-ref --verify --quiet 'refs/heads/topic'; then printf yes; fi"), 'localGit')
  assert.equal(classifyCommand('git fetch origin --prune'), 'remoteGit')
  assert.equal(classifyCommand('gh api --include repos/o/r/issues/1'), 'githubRest')
  assert.equal(classifyCommand('cd /tmp && gh api repos/o/r/issues/1'), 'githubRest')
  assert.equal(classifyCommand('GH_PAGER= gh issue view 1'), 'githubRest')
  assert.equal(classifyCommand('codex exec --json'), 'agentProcess')
  assert.equal(classifyCommand('printf done'), 'other')

  assert.deepEqual(
    summarizeCommands([
      { command: 'git status --porcelain', exitCode: 0 },
      { command: 'git fetch origin --prune', exitCode: 0 },
      { command: 'gh api --include repos/o/r/issues/1', exitCode: 1 },
      { command: 'git rev-parse MERGE_HEAD', exitCode: 128, expectedProbeMiss: true },
    ]),
    {
      physicalSubprocesses: 4,
      localGitSubprocesses: 2,
      remoteGitSubprocesses: 1,
      githubRestSubprocesses: 1,
      agentProcessSubprocesses: 0,
      failures: 1,
      expectedProbeMisses: 1,
    },
  )
})

test('access baseline separates absent-ref probes from operational failures', () => {
  assert.equal(
    isExpectedProbeMiss(
      "if git show-ref --verify --quiet 'refs/heads/clickvibe-issue-134'; then printf yes; elif git show-ref --verify --quiet 'refs/remotes/origin/clickvibe-issue-134'; then printf yes; else exit 1; fi",
    ),
    true,
  )
  assert.equal(isExpectedProbeMiss("git rev-parse --short 'origin/clickvibe-issue-134'"), true)
  assert.equal(isExpectedProbeMiss("git rev-parse --short 'MERGE_HEAD'"), true)
  assert.equal(isExpectedProbeMiss("git rev-parse --short 'origin/main'"), false)
  assert.equal(isExpectedProbeMiss('git status --porcelain'), false)
})

test('access baseline guard is rooted at the repository and rejects tracked source drift from a subdirectory', async () => {
  const fixture = await gitFixture(true)
  try {
    await writeFile(join(fixture.root, 'src', 'index.ts'), 'export const value = 2\n')
    const nested = join(fixture.root, 'scripts')
    await mkdir(nested)
    await assert.rejects(
      collectEnvironment(nested, fixture.baseline),
      /src differs from accepted baseline.*tracked source differs/,
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('access baseline guard rejects untracked source even when HEAD equals the baseline', async () => {
  const fixture = await gitFixture(false)
  try {
    await mkdir(join(fixture.root, 'src'))
    await writeFile(join(fixture.root, 'src', 'untracked.ts'), 'export const untracked = true\n')
    await assert.rejects(
      collectEnvironment(fixture.root, fixture.baseline),
      /src differs from accepted baseline.*untracked source exists/,
    )
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('access baseline guard accepts a clean source tree and records tool provenance', async () => {
  const fixture = await gitFixture(true)
  try {
    const result = await collectEnvironment(fixture.root, fixture.baseline)
    assert.equal(result.head, fixture.baseline)
    assert.equal(result.sourceMatchesBaseline, true)
    assert.deepEqual(result.untrackedSourcePaths, [])
    assert.match(result.measurementTool.sha256, /^[0-9a-f]{64}$/)
  } finally {
    await rm(fixture.root, { recursive: true, force: true })
  }
})

test('access baseline readback compares the authoritative remote tip with the intended local SHA', () => {
  const localSha = 'a'.repeat(40)
  assert.equal(readbackMatches(localSha, `${localSha}\trefs/heads/issue-133`, 'refs/heads/issue-133'), true)
  assert.equal(readbackMatches(localSha, `${'b'.repeat(40)}\trefs/heads/issue-133`, 'refs/heads/issue-133'), false)
  assert.equal(readbackMatches('a'.repeat(64), `${'a'.repeat(64)} refs/heads/issue-133`, 'refs/heads/issue-133'), true)
})

test('access baseline isolated write performs strict equality readback in a real temporary repository', async () => {
  const result = await isolatedWriteScenario()
  assert.equal(result.summary.consistentReadbacks, 10)
  assert.equal(result.summary.failures, 0)
  assert.equal(
    result.samples.every((sample) => sample.localSha === sample.remoteSha && sample.consistent),
    true,
  )
})

test('access baseline rate parsing preserves the original command failure and rejects malformed shapes', () => {
  assert.throws(
    () => parseCoreRateLimit({ exitCode: 1, stdout: '', stderr: 'authentication required' }),
    /authentication required/,
  )
  assert.throws(() => parseCoreRateLimit({ exitCode: 0, stdout: '{}', stderr: '' }), /resources\.core/)
  assert.deepEqual(
    parseCoreRateLimit({
      exitCode: 0,
      stdout: JSON.stringify({ resources: { core: { limit: 5000, used: 12, remaining: 4988, reset: 42 } } }),
      stderr: '',
    }),
    { limit: 5000, used: 12, remaining: 4988, reset: 42 },
  )
})

test('access baseline CLI rejects inherited object properties as scenario names', () => {
  const result = spawnSync(process.execPath, [scriptPath, 'constructor'], { cwd: process.cwd(), encoding: 'utf8' })
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /usage:/)
})

test('committed access baseline evidence names its curation and retains every raw command', async () => {
  const curatedPath = join(process.cwd(), 'docs', 'baselines', 'v0.2-access-baseline-evidence.json')
  const curated = JSON.parse(await readFile(curatedPath, 'utf8'))
  assert.equal(curated.artifactType, 'curated-summary')
  const rawPath = join(dirname(curatedPath), curated.rawEvidence.path)
  const records = (await readFile(rawPath, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
  assert.equal(records.length, 6)
  assert.deepEqual(
    records.map((record) => record.scenario ?? 'environment'),
    [
      'environment',
      'panel-always-on',
      'multi-work-item-refresh',
      'review-dense-preflight',
      'isolated-key-write-readback',
      'github-rest-rate-sample',
    ],
  )
  assert.equal(
    records.every((record) => record.measurementTool.sha256 === curated.rawEvidence.measurementToolSha256),
    true,
  )
  assert.equal(
    createHash('sha256')
      .update(await readFile(scriptPath))
      .digest('hex'),
    curated.rawEvidence.measurementToolSha256,
  )
  for (const record of records.filter((item) => Array.isArray(item.commands))) {
    assert.equal(record.commands.length, record.summary.physicalSubprocesses)
  }
  for (const scenario of curated.scenarios.filter((item) => item.summary)) {
    assert.deepEqual(scenario.summary, records[scenario.rawRecordLine - 1].summary)
  }
})
