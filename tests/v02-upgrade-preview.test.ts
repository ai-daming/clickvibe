import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, symlink, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parse as parseYaml } from 'yaml'
import { parseClickVibeConfigV1 } from '../src/infra/project-binding.ts'
import { previewV02Upgrade } from '../src/infra/v02-upgrade.ts'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function initRepository(path: string): Promise<void> {
  await git(dirname(path), 'init', path)
  await git(path, 'config', 'user.name', 'clickvibe-test')
  await git(path, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(path, 'commit', '--allow-empty', '-m', 'base')
  await git(path, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
}

async function treeDigest(root: string): Promise<string> {
  const entries: string[] = []
  async function visit(path: string, relative: string): Promise<void> {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const child = join(path, entry.name)
      const name = relative === '' ? entry.name : `${relative}/${entry.name}`
      if (entry.isDirectory()) {
        entries.push(`d:${name}`)
        await visit(child, name)
      } else if (entry.isFile()) {
        entries.push(
          `f:${name}:${createHash('sha256')
            .update(await readFile(child))
            .digest('hex')}`,
        )
      } else {
        entries.push(`x:${name}`)
      }
    }
  }
  await visit(root, '')
  return createHash('sha256').update(entries.join('\n')).digest('hex')
}

test('v0.2 preview is zero-write and freezes exact config, state, repository and worktree facts', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-preview-'))
  const repository = join(home, 'repo')
  const clickvibe = join(home, '.clickvibe')
  const configPath = join(clickvibe, 'config.yaml')
  try {
    await initRepository(repository)
    await mkdir(join(clickvibe, 'state', 'o', 'r', 'issue-9'), { recursive: true })
    await writeFile(join(clickvibe, 'state', 'o', 'r', 'issue-9', 'workflow.json'), '{"legacy":true}\n')
    const legacyConfig = [
      'repos:',
      `  o/r: ${repository}`,
      `worktreeRoot: ${join(home, 'worktrees')}`,
      'fetchTtlSeconds: 45',
      'diagnosticsMaxBytes: 10485760',
      '',
    ].join('\n')
    await mkdir(clickvibe, { recursive: true })
    await writeFile(configPath, legacyConfig, { mode: 0o600 })
    const before = await treeDigest(home)

    const preview = await previewV02Upgrade({
      home,
      baselineSha: '553a926405919bd3efc677fbd9bf0388f7c6a26d',
      now: '2026-08-27T16:00:00.000Z',
      nonce: 'preview-a',
      proposedRepositoryIds: { 'o/r': 'repo_11111111-1111-4111-8111-111111111111' },
      choices: { primaryRemotes: { 'o/r': 'origin' }, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })

    assert.equal(preview.status, 'previewed', JSON.stringify(preview))
    assert.equal(await treeDigest(home), before)
    assert.equal(preview.plan.legacyConfig.sha256, createHash('sha256').update(legacyConfig).digest('hex'))
    assert.equal(preview.plan.legacyState.status, 'present')
    assert.equal(preview.plan.legacyState.fileCount, 1)
    assert.equal(preview.plan.bindings[0].container.id, 'o/r')
    assert.equal(preview.plan.bindings[0].repository.primaryRemote, 'origin')
    assert.match(preview.plan.worktrees[0].porcelain, /worktree /)
    assert.match(preview.fingerprint, /^[0-9a-f]{64}$/)
    assert.equal(preview.plan.paths.activeState, join(clickvibe, 'state'))
    assert.equal(preview.plan.paths.stateBackup, join(clickvibe, 'state-v0.1-backup-20260827T160000000Z-preview-a'))
    assert.equal(
      preview.plan.paths.configBackup,
      join(clickvibe, 'config-v0.1-backup-20260827T160000000Z-preview-a.yaml'),
    )

    const parsed = parseClickVibeConfigV1(parseYaml(preview.plan.targetConfig.yaml))
    assert.equal(parsed.projectBindings[0].repository.repositoryId, 'repo_11111111-1111-4111-8111-111111111111')
    assert.equal(parsed.fetchTtlSeconds, 45)
    assert.equal(parsed.diagnosticsMaxBytes, 10_485_760)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('preview fails closed for invalid inputs and binds explicit exclusions into the fingerprint', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-preview-blocked-'))
  const clickvibe = join(home, '.clickvibe')
  const configPath = join(clickvibe, 'config.yaml')
  try {
    await mkdir(clickvibe, { recursive: true })
    await writeFile(configPath, `repos:\n  dead/repo: ${join(home, 'missing')}\nfetchTtlSeconds: 29\n`)
    const invalid = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      now: '2026-08-27T16:00:00.000Z',
      nonce: 'blocked',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(invalid.status, 'blocked')
    assert.match(invalid.blocked.map((item) => item.error).join('\n'), /fetchTtlSeconds/)

    await writeFile(configPath, `repos:\n  dead/repo: ${join(home, 'missing')}\n`)
    const excluded = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      now: '2026-08-27T16:00:00.000Z',
      nonce: 'excluded',
      choices: {
        primaryRemotes: {},
        exclusions: { 'dead/repo': 'clone was intentionally removed' },
      },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(excluded.status, 'previewed')
    assert.equal(excluded.plan.bindings.length, 0)
    assert.deepEqual(
      excluded.plan.exclusions.map(({ repoKey, reason }) => ({ repoKey, reason })),
      [{ repoKey: 'dead/repo', reason: 'clone was intentionally removed' }],
    )

    const changedReason = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      now: '2026-08-27T16:00:00.000Z',
      nonce: 'excluded',
      choices: { primaryRemotes: {}, exclusions: { 'dead/repo': 'different reason' } },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(changedReason.status, 'previewed')
    assert.notEqual(changedReason.fingerprint, excluded.fingerprint)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('an unfinished or corrupt journal takes precedence over a fresh preview', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-preview-recovery-'))
  const clickvibe = join(home, '.clickvibe')
  try {
    await mkdir(clickvibe, { recursive: true })
    await writeFile(join(clickvibe, 'config.yaml'), 'repos: {}\n')
    await writeFile(join(clickvibe, 'upgrade-v0.2.json'), '{broken')
    const preview = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      now: '2026-08-27T16:00:00.000Z',
      nonce: 'recovery',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(preview.status, 'recovery')
    assert.equal(preview.recovery.journal.status, 'corrupt')
    assert.match(preview.recovery.assets.map((asset) => asset.path).join('\n'), /upgrade-v0\.2\.json/)

    await unlink(join(clickvibe, 'upgrade-v0.2.json'))
    await writeFile(join(clickvibe, 'config-v0.1-backup-evidence.yaml'), 'repos: {}\n')
    const missing = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      now: '2026-08-27T16:00:00.000Z',
      nonce: 'missing-journal',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(missing.status, 'recovery')
    if (missing.status === 'recovery') assert.equal(missing.recovery.journal.status, 'missing')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('relative legacy repository paths resolve against the selected home, never the process cwd', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-relative-path-'))
  const repository = join(home, 'relative-repo')
  const root = join(home, '.clickvibe')
  try {
    await initRepository(repository)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'config.yaml'), 'repos:\n  o/r: ./relative-repo\n')
    const preview = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      nonce: 'relative-path',
      proposedRepositoryIds: { 'o/r': 'repo_11111111-1111-4111-8111-111111111111' },
      choices: { primaryRemotes: { 'o/r': 'origin' }, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(preview.status, 'previewed', JSON.stringify(preview))
    if (preview.status === 'previewed')
      assert.equal(preview.plan.bindings[0].repository.localPath, await realpath(repository))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('legacy config validation rejects ambiguous shapes instead of inventing defaults', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-invalid-config-'))
  const root = join(home, '.clickvibe')
  const configPath = join(root, 'config.yaml')
  await mkdir(root, { recursive: true })
  const invalid = [
    '[broken',
    '[]\n',
    'unknown: true\n',
    'repos: null\n',
    'repos: []\n',
    'repos:\n  invalid: /tmp/repo\n',
    'repos:\n  o/r: 42\n',
    "repos:\n  o/r: ''\n",
    'worktreeRoot: 42\n',
    "worktreeRoot: ''\n",
    "fetchTtlSeconds: '45'\n",
    'fetchTtlSeconds: 45.5\n',
    'fetchTtlSeconds: 0\n',
    'fetchTtlSeconds: 29\n',
    'fetchTtlSeconds: 61\n',
    "diagnosticsMaxBytes: 'large'\n",
    'diagnosticsMaxBytes: 0\n',
  ]
  try {
    for (const [index, raw] of invalid.entries()) {
      await writeFile(configPath, raw)
      const result = await previewV02Upgrade({
        home,
        baselineSha: 'baseline',
        now: '2026-08-27T18:00:00.000Z',
        nonce: `invalid-${index}`,
        choices: { primaryRemotes: {}, exclusions: {} },
        hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
      })
      assert.equal(result.status, 'blocked', `${index}: ${JSON.stringify(result)}`)
      if (result.status === 'blocked') assert.equal(result.blocked[0].scope, 'config')
    }

    await writeFile(configPath, 'repos: {}\nworktreeRoot: ~\nfetchTtlSeconds: 30\ndiagnosticsMaxBytes: 1\n')
    const valid = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      now: '2026-08-27T18:00:00.000Z',
      nonce: 'valid-settings',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(valid.status, 'previewed')
    assert.match(valid.plan.targetConfig.yaml, /fetchTtlSeconds: 30/)
    assert.match(valid.plan.targetConfig.yaml, /diagnosticsMaxBytes: 1/)

    await unlink(configPath)
    await writeFile(join(root, 'config-target.yaml'), 'repos: {}\n')
    await symlink(join(root, 'config-target.yaml'), configPath)
    const linked = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      nonce: 'linked-config',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(linked.status, 'blocked')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

test('state and all host activity axes block an otherwise valid preview', async () => {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-v02-host-blocks-'))
  const root = join(home, '.clickvibe')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'config.yaml'), 'repos: {}\n')
  try {
    await writeFile(join(root, 'state'), 'not a directory')
    const stateBlocked = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      nonce: 'state-file',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(stateBlocked.status, 'blocked')
    await rm(join(root, 'state'))

    const hostBlocked = await previewV02Upgrade({
      home,
      baselineSha: 'baseline',
      nonce: 'host-activity',
      choices: { primaryRemotes: {}, exclusions: {} },
      hostActivity: { liveTasks: ['task-1'], liveJobs: ['job-1'], oldPluginProcesses: ['pid-1'] },
    })
    assert.equal(hostBlocked.status, 'blocked')
    if (hostBlocked.status === 'blocked')
      assert.deepEqual(
        hostBlocked.blocked.map((item) => item.scope),
        ['host', 'host', 'host'],
      )
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})
