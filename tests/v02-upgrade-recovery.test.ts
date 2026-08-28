import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import type { V02UpgradeGenerationFence } from '../src/infra/v02-upgrade-execution.ts'
import { applyV02Upgrade } from '../src/infra/v02-upgrade-execution.ts'
import { previewV02UpgradeRecovery, resumeV02Upgrade, rollbackV02Upgrade } from '../src/infra/v02-upgrade-recovery.ts'
import { previewV02Upgrade } from '../src/infra/v02-upgrade.ts'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', cwd, ...args])
}

async function fixture(name: string, statePresent = true) {
  const home = await mkdtemp(join(tmpdir(), `clickvibe-v02-recovery-${name}-`))
  const repository = join(home, 'repo')
  const root = join(home, '.clickvibe')
  await git(dirname(repository), 'init', repository)
  await git(repository, 'config', 'user.name', 'clickvibe-test')
  await git(repository, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(repository, 'commit', '--allow-empty', '-m', 'base')
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  await mkdir(root, { recursive: true })
  if (statePresent) await mkdir(join(root, 'state', 'o', 'r', 'issue-9'), { recursive: true })
  const config = `repos:\n  o/r: ${repository}\n`
  await writeFile(join(root, 'config.yaml'), config)
  if (statePresent) await writeFile(join(root, 'state', 'o', 'r', 'issue-9', 'workflow.json'), '{"legacy":true}\n')
  const preview = await previewV02Upgrade({
    home,
    baselineSha: '553a926405919bd3efc677fbd9bf0388f7c6a26d',
    now: '2026-08-27T17:00:00.000Z',
    nonce: name,
    proposedRepositoryIds: { 'o/r': 'repo_33333333-3333-4333-8333-333333333333' },
    choices: { primaryRemotes: { 'o/r': 'origin' }, exclusions: {} },
    hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
  })
  assert.equal(preview.status, 'previewed')
  return { home, root, config, preview }
}

function fence(): V02UpgradeGenerationFence {
  return {
    async acquire() {
      return {
        activity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
        async release() {},
      }
    },
  }
}

async function failBeforeConfigActivation(item: Awaited<ReturnType<typeof fixture>>) {
  const result = await applyV02Upgrade({
    plan: item.preview.plan,
    fingerprint: item.preview.fingerprint,
    fence: fence(),
    checkpoint(name) {
      if (name === `before-rename:${item.preview.plan.paths.stagedConfig}->${item.preview.plan.paths.activeConfig}`) {
        throw new Error('injected config activation crash')
      }
    },
  })
  assert.equal(result.status, 'failed')
  assert.match(result.error, /injected config activation crash/)
  assert.equal(await readFile(item.preview.plan.paths.activeConfig, 'utf8'), item.config)
  assert.equal(
    JSON.parse(await readFile(join(item.preview.plan.paths.activeState, '.clickvibe-state.json'), 'utf8')).generation,
    'v0.2',
  )
}

test('recovery preview is zero-write and authorized resume finishes a mixed-generation cutover', async () => {
  const item = await fixture('resume')
  try {
    await failBeforeConfigActivation(item)
    const journalBefore = await readFile(item.preview.plan.paths.journal)
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed', JSON.stringify(recovery))
    assert.deepEqual(await readFile(item.preview.plan.paths.journal), journalBefore)
    const result = await resumeV02Upgrade({ plan: recovery.plan, fingerprint: recovery.fingerprint, fence: fence() })
    assert.equal(result.status, 'verified', JSON.stringify(result))
    const journal = JSON.parse(await readFile(item.preview.plan.paths.journal, 'utf8'))
    assert.equal(journal.phase, 'verified')
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('authorized rollback restores the exact v0.1 config/state pair without deleting Git or backups', async () => {
  const item = await fixture('rollback')
  try {
    await failBeforeConfigActivation(item)
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed')
    const result = await rollbackV02Upgrade({ plan: recovery.plan, fingerprint: recovery.fingerprint, fence: fence() })
    assert.equal(result.status, 'rolled-back', JSON.stringify(result))
    assert.equal(await readFile(item.preview.plan.paths.activeConfig, 'utf8'), item.config)
    assert.equal(
      await readFile(join(item.preview.plan.paths.activeState, 'o', 'r', 'issue-9', 'workflow.json'), 'utf8'),
      '{"legacy":true}\n',
    )
    assert.equal(await readFile(item.preview.plan.paths.configBackup, 'utf8'), item.config)
    assert.equal((await stat(item.root)).isDirectory(), true)
    assert.equal(JSON.parse(await readFile(item.preview.plan.paths.journal, 'utf8')).phase, 'rolled_back')

    const terminal = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(terminal.status, 'recovery-previewed')
    const invalidResume = await resumeV02Upgrade({
      plan: terminal.plan,
      fingerprint: terminal.fingerprint,
      fence: fence(),
    })
    assert.equal(invalidResume.status, 'failed')
    if (invalidResume.status === 'failed') assert.match(invalidResume.error, /rolled_back.*new upgrade preview/)

    const retry = await previewV02Upgrade({
      home: item.home,
      baselineSha: item.preview.plan.baselineSha,
      now: '2026-08-27T17:10:00.000Z',
      nonce: 'retry-after-rollback',
      choices: { primaryRemotes: { 'o/r': 'origin' }, exclusions: {} },
      hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
    })
    assert.equal(retry.status, 'previewed', JSON.stringify(retry))
    assert.notEqual(retry.plan.expectedJournal, 'absent')
    const reapplied = await applyV02Upgrade({ plan: retry.plan, fingerprint: retry.fingerprint, fence: fence() })
    assert.equal(reapplied.status, 'verified', JSON.stringify(reapplied))
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('resume rejects a verified terminal journal instead of re-entering cutover', async () => {
  const item = await fixture('verified-terminal')
  try {
    const applied = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: fence(),
    })
    assert.equal(applied.status, 'verified')
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed')
    const resumed = await resumeV02Upgrade({ plan: recovery.plan, fingerprint: recovery.fingerprint, fence: fence() })
    assert.equal(resumed.status, 'failed')
    if (resumed.status === 'failed') assert.match(resumed.error, /verified.*terminal/)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('recovery checkpoints preserve resumability across unresolved rename and terminal journal windows', async () => {
  const item = await fixture('recovery-checkpoints')
  try {
    const first = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: fence(),
      checkpoint(current) {
        if (current === `after-rename:${item.preview.plan.paths.activeState}->${item.preview.plan.paths.stateBackup}`) {
          throw new Error('crash after legacy state rename')
        }
      },
    })
    assert.equal(first.status, 'failed')
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed')
    const interrupted = await resumeV02Upgrade({
      plan: recovery.plan,
      fingerprint: recovery.fingerprint,
      fence: fence(),
      checkpoint(current) {
        if (
          current === `before-rename:${item.preview.plan.paths.stagedState}->${item.preview.plan.paths.activeState}`
        ) {
          throw new Error('recovery state activation crash')
        }
      },
    })
    assert.equal(interrupted.status, 'failed')
    const retry = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(retry.status, 'recovery-previewed')
    const resumed = await resumeV02Upgrade({ plan: retry.plan, fingerprint: retry.fingerprint, fence: fence() })
    assert.equal(resumed.status, 'verified', JSON.stringify(resumed))
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('apply exposes a terminal verification checkpoint and never claims verified before its durable journal', async () => {
  const item = await fixture('terminal-checkpoint')
  try {
    const failed = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: fence(),
      checkpoint(current) {
        if (current === 'before-terminal-journal:verified') throw new Error('terminal journal unavailable')
      },
    })
    assert.equal(failed.status, 'failed')
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed')
    const resumed = await resumeV02Upgrade({ plan: recovery.plan, fingerprint: recovery.fingerprint, fence: fence() })
    assert.equal(resumed.status, 'verified', JSON.stringify(resumed))
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('rollback checkpoints preserve enough journal evidence for an exact retry', async () => {
  const item = await fixture('rollback-checkpoint')
  try {
    await failBeforeConfigActivation(item)
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed')
    const interrupted = await rollbackV02Upgrade({
      plan: recovery.plan,
      fingerprint: recovery.fingerprint,
      fence: fence(),
      checkpoint(current) {
        if (current === `after-rename:${item.preview.plan.paths.activeState}->${item.preview.plan.paths.stagedState}`) {
          throw new Error('rollback quarantine crash')
        }
      },
    })
    assert.equal(interrupted.status, 'failed')
    const retry = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(retry.status, 'recovery-previewed')
    const rolledBack = await rollbackV02Upgrade({ plan: retry.plan, fingerprint: retry.fingerprint, fence: fence() })
    assert.equal(rolledBack.status, 'rolled-back', JSON.stringify(rolledBack))
    assert.equal(await readFile(item.preview.plan.paths.activeConfig, 'utf8'), item.config)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('resume handles failures both before state activation and during early prepare', async () => {
  for (const [name, crashAt] of [
    ['before-state', 'before-rename:STATE'],
    ['early-prepare', 'before-publish:CONFIG_BACKUP'],
  ] as const) {
    const item = await fixture(name)
    try {
      const checkpoint = crashAt
        .replace('STATE', `${item.preview.plan.paths.stagedState}->${item.preview.plan.paths.activeState}`)
        .replace('CONFIG_BACKUP', item.preview.plan.paths.configBackup)
      const failed = await applyV02Upgrade({
        plan: item.preview.plan,
        fingerprint: item.preview.fingerprint,
        fence: fence(),
        checkpoint(current) {
          if (current === checkpoint) throw new Error(`injected ${name}`)
        },
      })
      assert.equal(failed.status, 'failed')
      const recovery = await previewV02UpgradeRecovery({ home: item.home })
      assert.equal(recovery.status, 'recovery-previewed')
      const resumed = await resumeV02Upgrade({ plan: recovery.plan, fingerprint: recovery.fingerprint, fence: fence() })
      assert.equal(resumed.status, 'verified', JSON.stringify(resumed))
    } finally {
      await rm(item.home, { recursive: true, force: true })
    }
  }
})

test('rollback preserves an initially absent legacy state and rejects changed recovery evidence', async () => {
  const item = await fixture('absent-rollback', false)
  try {
    const failed = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: fence(),
      checkpoint(current) {
        if (
          current === `before-rename:${item.preview.plan.paths.stagedConfig}->${item.preview.plan.paths.activeConfig}`
        )
          throw new Error('mixed absent state')
      },
    })
    assert.equal(failed.status, 'failed')
    const stale = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(stale.status, 'recovery-previewed')
    await writeFile(item.preview.plan.paths.journal, `${await readFile(item.preview.plan.paths.journal, 'utf8')} `)
    const changed = await rollbackV02Upgrade({ plan: stale.plan, fingerprint: stale.fingerprint, fence: fence() })
    assert.equal(changed.status, 'facts-changed')

    const current = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(current.status, 'recovery-previewed')
    const rolledBack = await rollbackV02Upgrade({
      plan: current.plan,
      fingerprint: current.fingerprint,
      fence: fence(),
    })
    assert.equal(rolledBack.status, 'rolled-back', JSON.stringify(rolledBack))
    await assert.rejects(stat(item.preview.plan.paths.activeState), { code: 'ENOENT' })
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('recovery fence acquisition failure releases the cross-process lock for an immediate retry', async () => {
  const item = await fixture('fence-failure')
  try {
    await failBeforeConfigActivation(item)
    const recovery = await previewV02UpgradeRecovery({ home: item.home })
    assert.equal(recovery.status, 'recovery-previewed')
    const unavailable: V02UpgradeGenerationFence = {
      async acquire() {
        throw new Error('generation fence unavailable')
      },
    }
    const failed = await resumeV02Upgrade({
      plan: recovery.plan,
      fingerprint: recovery.fingerprint,
      fence: unavailable,
    })
    assert.equal(failed.status, 'failed')
    if (failed.status === 'failed') assert.match(failed.error, /generation fence unavailable/)
    await assert.rejects(stat(item.preview.plan.paths.lock), { code: 'ENOENT' })
    const retried = await resumeV02Upgrade({
      plan: recovery.plan,
      fingerprint: recovery.fingerprint,
      fence: fence(),
    })
    assert.equal(retried.status, 'verified', JSON.stringify(retried))
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})
