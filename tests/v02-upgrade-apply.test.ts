import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import { createProjectBinding, parseClickVibeConfigV1 } from '../src/infra/project-binding.ts'
import { readRepositoryId } from '../src/infra/repository-identity.ts'
import { loadConfigFromHome } from '../src/infra/runtime.ts'
import {
  createOfflineV02GenerationFence,
  createOnlineV02GenerationFence,
  resetV02GenerationFenceForTest,
  V02_OFFLINE_HOST_DECLARATION,
} from '../src/infra/v02-generation-fence.ts'
import {
  applyV02Upgrade,
  type V02UpgradeGenerationFence,
  verifyV02UpgradeCutover,
} from '../src/infra/v02-upgrade-execution.ts'
import { previewV02Upgrade, type V02UpgradePlan, v02UpgradePlanFingerprint } from '../src/infra/v02-upgrade.ts'

const execFileAsync = promisify(execFile)

function testNonce(label: string): string {
  const hex = createHash('sha256').update(label).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execFileAsync('git', ['-C', cwd, ...args], { encoding: 'utf8' })
  return result.stdout.trim()
}

async function fixture(name: string, statePresent = true) {
  const home = await mkdtemp(join(tmpdir(), `clickvibe-v02-apply-${name}-`))
  const repository = join(home, 'repo')
  const root = join(home, '.clickvibe')
  await git(dirname(repository), 'init', repository)
  await git(repository, 'config', 'user.name', 'clickvibe-test')
  await git(repository, 'config', 'user.email', 'clickvibe-test@example.invalid')
  await git(repository, 'commit', '--allow-empty', '-m', 'base')
  await git(repository, 'remote', 'add', 'origin', 'https://github.com/o/r.git')
  await mkdir(root, { recursive: true })
  const config = `repos:\n  o/r: ${repository}\nfetchTtlSeconds: 45\n`
  await writeFile(join(root, 'config.yaml'), config, { mode: 0o600 })
  if (statePresent) {
    await mkdir(join(root, 'state', 'o', 'r', 'issue-9'), { recursive: true })
    await writeFile(join(root, 'state', 'o', 'r', 'issue-9', 'workflow.json'), '{"legacy":true}\n')
  }
  const preview = await previewV02Upgrade({
    home,
    baselineSha: '553a926405919bd3efc677fbd9bf0388f7c6a26d',
    now: '2026-08-27T16:30:00.000Z',
    nonce: testNonce(name),
    proposedRepositoryIds: { 'o/r': 'repo_22222222-2222-4222-8222-222222222222' },
    choices: { primaryRemotes: { 'o/r': 'origin' }, exclusions: {} },
    hostActivity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
  })
  assert.equal(preview.status, 'previewed', JSON.stringify(preview))
  return { home, repository, root, config, preview }
}

function offlineFence() {
  resetV02GenerationFenceForTest()
  return createOfflineV02GenerationFence({
    declaration: V02_OFFLINE_HOST_DECLARATION,
    enumerateOldPluginProcesses: async () => [],
  })
}

async function assertNoPreparedAssets(plan: V02UpgradePlan): Promise<void> {
  for (const path of [
    plan.paths.journal,
    plan.paths.configBackup,
    plan.paths.stagedConfig,
    plan.paths.stateBackup,
    plan.paths.stagedState,
  ]) {
    await assert.rejects(stat(path), { code: 'ENOENT' })
  }
  await assert.rejects(readRepositoryId(plan.bindings[0].repository.localPath), /missing/)
}

test('apply rejects an unregistered caller-built fence before the first upgrade write', async () => {
  const item = await fixture('unregistered-fence')
  const unregistered: V02UpgradeGenerationFence = {
    async acquire() {
      return {
        activity: { liveTasks: [], liveJobs: [], oldPluginProcesses: [] },
        async release() {},
      }
    },
  }
  try {
    await assert.rejects(
      applyV02Upgrade({
        plan: item.preview.plan,
        fingerprint: item.preview.fingerprint,
        fence: unregistered,
      }),
      /approved generation fence factory/i,
    )
    await assertNoPreparedAssets(item.preview.plan)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('online apply is disabled before host integration and leaves no prepared asset', async () => {
  const item = await fixture('online-disabled')
  try {
    await assert.rejects(
      applyV02Upgrade({
        plan: item.preview.plan,
        fingerprint: item.preview.fingerprint,
        fence: createOnlineV02GenerationFence(),
      }),
      /online.*disabled.*host integration/i,
    )
    await assertNoPreparedAssets(item.preview.plan)
    assert.equal(
      (await readdir(item.root)).some((name) => name.startsWith('upgrade-v0.2.lock')),
      false,
    )
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('authorized apply durably cold-backs up legacy assets and verifies the v0.2 pair', async () => {
  const item = await fixture('success')
  const fence = offlineFence()
  const beforeHead = await git(item.repository, 'rev-parse', 'HEAD')
  const beforeStatus = await git(item.repository, 'status', '--porcelain=v1', '--untracked-files=all')
  try {
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence,
    })
    assert.equal(result.status, 'verified', JSON.stringify(result))
    assert.equal(await readFile(item.preview.plan.paths.configBackup, 'utf8'), item.config)
    assert.equal(
      await readFile(join(item.preview.plan.paths.stateBackup, 'o', 'r', 'issue-9', 'workflow.json'), 'utf8'),
      '{"legacy":true}\n',
    )
    const marker = JSON.parse(
      await readFile(join(item.preview.plan.paths.activeState, '.clickvibe-state.json'), 'utf8'),
    )
    assert.equal(marker.schemaVersion, 1)
    assert.equal(marker.planFingerprint, item.preview.fingerprint)
    const activeConfig = parseClickVibeConfigV1(parseYaml(await readFile(item.preview.plan.paths.activeConfig, 'utf8')))
    assert.equal(activeConfig.projectBindings.length, 1)
    assert.equal(await readRepositoryId(item.repository), 'repo_22222222-2222-4222-8222-222222222222')
    const journal = JSON.parse(await readFile(item.preview.plan.paths.journal, 'utf8'))
    assert.equal(journal.phase, 'verified')
    assert.equal(journal.planFingerprint, item.preview.fingerprint)
    assert.equal(await git(item.repository, 'rev-parse', 'HEAD'), beforeHead)
    assert.equal(await git(item.repository, 'status', '--porcelain=v1', '--untracked-files=all'), beforeStatus)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('state initially absent is recorded and never fabricated as a legacy rename', async () => {
  const item = await fixture('absent', false)
  const fence = offlineFence()
  try {
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence,
    })
    assert.equal(result.status, 'verified')
    await assert.rejects(stat(item.preview.plan.paths.stateBackup), { code: 'ENOENT' })
    const journal = JSON.parse(await readFile(item.preview.plan.paths.journal, 'utf8'))
    assert.equal(journal.initialState, 'absent')
    assert.equal(journal.actions.stateBackup, 'initially-absent')
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('facts changed after authorization invalidates the plan before any prepared asset is written', async () => {
  const item = await fixture('changed')
  const fence = offlineFence()
  try {
    await writeFile(item.preview.plan.paths.activeConfig, `${item.config}# changed after preview\n`)
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence,
    })
    assert.equal(result.status, 'facts-changed')
    await assertNoPreparedAssets(item.preview.plan)
    assert.equal(
      (await readdir(item.root)).some((name) => name.startsWith('upgrade-v0.2.lock')),
      false,
    )
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('verified v0.2 config/state pair becomes the strict runtime repository view', async () => {
  const item = await fixture('runtime')
  const fence = offlineFence()
  try {
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence,
    })
    assert.equal(result.status, 'verified')
    const config = await loadConfigFromHome(item.home)
    assert.equal(config.schemaVersion, 1)
    assert.deepEqual(config.repos, { 'o/r': item.preview.plan.bindings[0].repository.localPath })
    await writeFile(
      join(item.preview.plan.paths.activeState, '.clickvibe-state.json'),
      '{"schemaVersion":1,"generation":"v0.2","planFingerprint":"wrong"}\n',
    )
    await assert.rejects(loadConfigFromHome(item.home), /marker.*journal|fingerprint/)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('runtime rejects every independently damaged member of the verified v0.2 pair', async () => {
  const item = await fixture('runtime-damage')
  try {
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: offlineFence(),
    })
    assert.equal(result.status, 'verified')
    const journalPath = item.preview.plan.paths.journal
    const markerPath = join(item.preview.plan.paths.activeState, '.clickvibe-state.json')
    const originalJournal = await readFile(journalPath, 'utf8')
    const originalMarker = await readFile(markerPath, 'utf8')
    const originalConfig = await readFile(item.preview.plan.paths.activeConfig, 'utf8')
    const restore = async () => {
      await writeFile(journalPath, originalJournal)
      await writeFile(markerPath, originalMarker)
      await writeFile(item.preview.plan.paths.activeConfig, originalConfig)
    }
    const mutateJournal = async (
      mutation: (journal: { phase: string; schemaVersion: number }) => void,
      expected: RegExp,
    ) => {
      const journal = JSON.parse(originalJournal) as { phase: string; schemaVersion: number }
      mutation(journal)
      await writeFile(journalPath, JSON.stringify(journal))
      await assert.rejects(loadConfigFromHome(item.home), expected)
      await restore()
    }

    await mutateJournal((journal) => {
      journal.phase = 'failed'
    }, /verified upgrade journal/)
    await mutateJournal((journal) => {
      journal.schemaVersion = 2
    }, /verified upgrade journal/)
    await unlink(journalPath)
    await assert.rejects(loadConfigFromHome(item.home), /ENOENT|upgrade-v0\.2\.json/)
    await restore()
    const tamperedJournal = JSON.parse(originalJournal)
    tamperedJournal.planFingerprint = 'tampered'
    const tamperedMarker = JSON.parse(originalMarker)
    tamperedMarker.planFingerprint = 'tampered'
    await writeFile(journalPath, JSON.stringify(tamperedJournal))
    await writeFile(markerPath, JSON.stringify(tamperedMarker))
    await assert.rejects(loadConfigFromHome(item.home), /plan fingerprint is invalid/)
    await restore()

    const wrongPathJournal = JSON.parse(originalJournal)
    wrongPathJournal.plan.paths.root = join(item.home, 'other-home')
    wrongPathJournal.planFingerprint = v02UpgradePlanFingerprint(wrongPathJournal.plan)
    const wrongPathMarker = JSON.parse(originalMarker)
    wrongPathMarker.planFingerprint = wrongPathJournal.planFingerprint
    await writeFile(journalPath, JSON.stringify(wrongPathJournal))
    await writeFile(markerPath, JSON.stringify(wrongPathMarker))
    await assert.rejects(loadConfigFromHome(item.home), /paths do not belong/)
    await restore()

    await writeFile(item.preview.plan.paths.activeConfig, `${originalConfig}# drift\n`)
    await assert.rejects(loadConfigFromHome(item.home), /config fingerprint/)
    await restore()

    await writeFile(item.preview.plan.paths.configBackup, 'damaged backup')
    await assert.rejects(verifyV02UpgradeCutover(result.journal), /config backup/)
    await writeFile(item.preview.plan.paths.configBackup, item.config)
    const stragglerPath = join(item.preview.plan.paths.stateBackup, 'late-v0.1-write.json')
    await writeFile(stragglerPath, '{"late":true}\n')
    await assert.rejects(verifyV02UpgradeCutover(result.journal), /state backup.*authorized legacy state/)
    await rm(stragglerPath)
    const badMarker = JSON.parse(originalMarker)
    badMarker.generation = 'v9'
    await writeFile(markerPath, JSON.stringify(badMarker))
    await assert.rejects(verifyV02UpgradeCutover(result.journal), /state marker/)
    await restore()

    const unsupported = parseClickVibeConfigV1(parseYaml(originalConfig))
    unsupported.projectBindings = [
      createProjectBinding({
        container: { provider: 'gitlab', instance: 'gitlab.example', id: 'o/r' },
        repository: unsupported.projectBindings[0].repository,
      }),
    ]
    const unsupportedRaw = stringifyYaml(unsupported, { lineWidth: 0 })
    const unsupportedJournal = JSON.parse(originalJournal)
    unsupportedJournal.plan.targetConfig = {
      yaml: unsupportedRaw,
      sha256: createHash('sha256').update(unsupportedRaw).digest('hex'),
    }
    unsupportedJournal.planFingerprint = v02UpgradePlanFingerprint(unsupportedJournal.plan)
    const unsupportedMarker = JSON.parse(originalMarker)
    unsupportedMarker.planFingerprint = unsupportedJournal.planFingerprint
    await writeFile(item.preview.plan.paths.activeConfig, unsupportedRaw)
    await writeFile(journalPath, JSON.stringify(unsupportedJournal))
    await writeFile(markerPath, JSON.stringify(unsupportedMarker))
    await assert.rejects(loadConfigFromHome(item.home), /unsupported active ProjectBinding provider/)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('a journal publication collision never overwrites the competing owner evidence', async () => {
  const item = await fixture('journal-collision')
  const foreign = '{"owner":"other-upgrader"}\n'
  try {
    let injected = false
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: offlineFence(),
      async checkpoint(current) {
        if (!injected && current === `before-file-write:${item.preview.plan.paths.journal}`) {
          injected = true
          await writeFile(item.preview.plan.paths.journal, foreign)
        }
      },
    })
    assert.equal(result.status, 'failed')
    assert.equal(await readFile(item.preview.plan.paths.journal, 'utf8'), foreign)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('a late legacy write into the renamed cold backup prevents verified cutover', async () => {
  const item = await fixture('late-backup-write')
  try {
    let injected = false
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: offlineFence(),
      async checkpoint(current) {
        if (
          !injected &&
          current === `after-rename:${item.preview.plan.paths.activeState}->${item.preview.plan.paths.stateBackup}`
        ) {
          injected = true
          await writeFile(join(item.preview.plan.paths.stateBackup, 'late-v0.1-write.json'), '{"late":true}\n')
        }
      },
    })
    assert.equal(result.status, 'failed')
    if (result.status === 'failed') assert.match(result.error, /state backup.*authorized legacy state/)
    assert.equal(JSON.parse(await readFile(item.preview.plan.paths.journal, 'utf8')).phase, 'failed')
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})

test('authorization, plan-shape and durable journal failures release ownership with raw evidence', async () => {
  const wrong = await fixture('wrong-authorization')
  try {
    await assert.rejects(
      applyV02Upgrade({ plan: wrong.preview.plan, fingerprint: 'wrong', fence: offlineFence() }),
      /authorization fingerprint/,
    )
  } finally {
    await rm(wrong.home, { recursive: true, force: true })
  }

  const malformed = await fixture('malformed-plan')
  try {
    const plan = structuredClone(malformed.preview.plan)
    plan.bindings = []
    const result = await applyV02Upgrade({ plan, fingerprint: v02UpgradePlanFingerprint(plan), fence: offlineFence() })
    assert.equal(result.status, 'failed')
    assert.match(result.error, /no binding/)
  } finally {
    await rm(malformed.home, { recursive: true, force: true })
  }

  for (const [name, checkpoint, expected] of [
    ['raw-string', 'before-publish:BACKUP', /raw checkpoint failure/],
    ['journal-replace', 'before-replace:JOURNAL', /journal update failed/],
  ] as const) {
    const item = await fixture(name)
    try {
      const selected = checkpoint
        .replace('BACKUP', item.preview.plan.paths.configBackup)
        .replace('JOURNAL', item.preview.plan.paths.journal)
      const result = await applyV02Upgrade({
        plan: item.preview.plan,
        fingerprint: item.preview.fingerprint,
        fence: offlineFence(),
        checkpoint(current) {
          if (current !== selected) return
          if (name === 'raw-string') throw 'raw checkpoint failure'
          throw new Error('journal replace unavailable')
        },
      })
      assert.equal(result.status, 'failed')
      assert.match(result.error, expected)
    } finally {
      await rm(item.home, { recursive: true, force: true })
    }
  }
})

test('verification rejects a fabricated cold state backup when legacy state was initially absent', async () => {
  const item = await fixture('fabricated-backup', false)
  try {
    const result = await applyV02Upgrade({
      plan: item.preview.plan,
      fingerprint: item.preview.fingerprint,
      fence: offlineFence(),
    })
    assert.equal(result.status, 'verified')
    await mkdir(item.preview.plan.paths.stateBackup)
    await assert.rejects(verifyV02UpgradeCutover(result.journal), /fabricated/)
  } finally {
    await rm(item.home, { recursive: true, force: true })
  }
})
