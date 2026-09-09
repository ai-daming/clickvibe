import { fingerprintWorkItemContract } from '../src/workflow/work-item-contract.ts'
import assert from 'node:assert/strict'
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { v02Home } from './helpers/v02-home.ts'
import {
  createOfflineV02GenerationFence,
  resetV02GenerationFenceForTest,
  V02_OFFLINE_HOST_DECLARATION,
} from '../src/infra/v02-generation-fence.ts'
import {
  previewRecoveryUpgrade,
  applyRecoveryUpgrade,
  rollbackRecoveryUpgrade,
  resumeRecoveryUpgrade,
} from '../src/infra/recovery-upgrade.ts'
import { recoveryStateRoot } from '../src/infra/recovery-layout.ts'
import {
  captureGithubIssueContractObservation,
  readCurrentIssueContract,
} from '../src/workflow/work-item-contract-repository.ts'
const baselineSha = '1a2ea2f02f17bd8df67f878141ac49321a9dbaa8'
const fence = () =>
  createOfflineV02GenerationFence({
    declaration: V02_OFFLINE_HOST_DECLARATION,
    enumerateOldPluginProcesses: async () => [],
  })
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const { home } = await v02Home(['fixture/recovery'])
  t.after(async () => {
    resetV02GenerationFenceForTest()
    await rm(home, { recursive: true, force: true })
  })
  return home
}

test('offline root migration preserves raw contract evidence and isolates old writes', async (t) => {
  const home = await fixture(t)
  const old = join(home, '.clickvibe', 'state')
  const url = 'https://github.com/fixture/recovery/issues/170'
  const original = await captureGithubIssueContractObservation({
    root: old,
    item: {
      url,
      state: 'OPEN',
      title: 'fixture',
      updatedAt: '2026-09-09T00:00:00Z',
      body: '## 目标\nKeep evidence\n## 验收标准\n- [ ] Preserve\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
    },
    blockedBy: [],
    capturedAt: '2026-09-09T00:00:00Z',
  })
  assert.equal(original.state, 'known')
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  const result = await applyRecoveryUpgrade({
    plan,
    fingerprint: plan.fingerprint,
    fingerprintOf: fingerprintWorkItemContract,
    fence: fence(),
  })
  assert.equal(result.phase, 'verified')
  const current = await readCurrentIssueContract(url, recoveryStateRoot(home))
  assert.equal(current.state, 'known')
  if (current.state !== 'known' || original.state !== 'known') assert.fail('known contract required')
  assert.deepEqual(current.raw, original.raw)
  assert.equal(current.snapshot.fingerprint, original.snapshot.fingerprint)
  assert.ok(current.snapshot.rawArtifact.path.startsWith(recoveryStateRoot(home)))
  await writeFile(join(old, 'old-writer.log'), 'old only')
  assert.deepEqual((await readCurrentIssueContract(url, recoveryStateRoot(home))).state, 'known')
  const config = await readFile(join(home, '.clickvibe', 'config.yaml'), 'utf8')
  assert.match(config, /schemaVersion: 2/)
  await assert.rejects(
    rollbackRecoveryUpgrade({
      home,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: fence(),
    }),
    /drift|changed/,
  )
})

test('wrong authorization and changed source perform no conversion', async (t) => {
  const home = await fixture(t)
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  await assert.rejects(
    applyRecoveryUpgrade({ plan, fingerprint: 'wrong', fingerprintOf: fingerprintWorkItemContract, fence: fence() }),
    /fingerprint/,
  )
  await writeFile(join(home, '.clickvibe', 'state', 'late.log'), 'changed')
  await assert.rejects(
    applyRecoveryUpgrade({
      plan,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: fence(),
    }),
    /changed|drift/,
  )
  await assert.rejects(readFile(join(recoveryStateRoot(home), '.clickvibe-state.json')), /ENOENT/)
})

test('root aliases and existing targets cannot be overwritten', async (t) => {
  const home = await fixture(t)
  await symlink(join(home, '.clickvibe', 'state'), recoveryStateRoot(home))
  await assert.rejects(
    previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract }),
    /exist|link|alias/,
  )
})

test('restart resumes after config switch and no-use rollback restores the original config', async (t) => {
  const home = await fixture(t)
  const original = await readFile(join(home, '.clickvibe', 'config.yaml'), 'utf8')
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  await assert.rejects(
    applyRecoveryUpgrade({
      plan,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: fence(),
      checkpoint(name) {
        if (name === 'config-written') throw new Error('crash')
      },
    }),
    /crash/,
  )
  resetV02GenerationFenceForTest()
  assert.equal(
    (
      await resumeRecoveryUpgrade({
        home,
        fingerprint: plan.fingerprint,
        fingerprintOf: fingerprintWorkItemContract,
        fence: fence(),
      })
    ).phase,
    'verified',
  )
  resetV02GenerationFenceForTest()
  assert.equal(
    (
      await rollbackRecoveryUpgrade({
        home,
        fingerprint: plan.fingerprint,
        fingerprintOf: fingerprintWorkItemContract,
        fence: fence(),
      })
    ).phase,
    'rolled-back',
  )
  assert.equal(await readFile(join(home, '.clickvibe', 'config.yaml'), 'utf8'), original)
})

test('a business write after activation prevents downgrade', async (t) => {
  const home = await fixture(t)
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  await applyRecoveryUpgrade({
    plan,
    fingerprint: plan.fingerprint,
    fingerprintOf: fingerprintWorkItemContract,
    fence: fence(),
  })
  resetV02GenerationFenceForTest()
  await mkdir(join(recoveryStateRoot(home), 'new-task'), { recursive: true })
  await writeFile(join(recoveryStateRoot(home), 'new-task', 'workflow.json'), '{}')
  await assert.rejects(
    rollbackRecoveryUpgrade({
      home,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: fence(),
    }),
    /changed|drift|used/,
  )
})

test('plan and runtime journal store hashes, not copies of task history', async (t) => {
  const home = await fixture(t)
  await writeFile(join(home, '.clickvibe', 'state', 'history.log'), 'private-history-'.repeat(100_000))
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  assert.ok(JSON.stringify(plan).length < 100_000, 'history bytes must not be embedded in the authority plan')
  await applyRecoveryUpgrade({
    plan,
    fingerprint: plan.fingerprint,
    fingerprintOf: fingerprintWorkItemContract,
    fence: fence(),
  })
  assert.ok((await readFile(join(home, '.clickvibe', 'upgrade-recovery-1.json'))).length < 100_000)
  assert.equal((await readFile(join(recoveryStateRoot(home), 'history.log'), 'utf8')).length, 1_600_000)
})

test('preview refuses bindings whose derived worktree directories collide', async (t) => {
  const { mkdtemp } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { activateV02Home, initFixtureRepository } = await import('./helpers/v02-home.ts')
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-name-collision-'))
  t.after(async () => {
    resetV02GenerationFenceForTest()
    await rm(home, { recursive: true, force: true })
  })
  const left = join(home, 'left', 'repo'),
    right = join(home, 'right', 'repo')
  await initFixtureRepository(left)
  await initFixtureRepository(right)
  await activateV02Home(home, { 'left/repo': left, 'right/repo': right })
  await assert.rejects(
    previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract }),
    /collision|basename/,
  )
})

test('a changed Git worktree invalidates the migration preview before conversion', async (t) => {
  const home = await fixture(t)
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  await writeFile(join(plan.gitFacts[0].localPath, 'changed-after-preview.txt'), 'new local work')
  await assert.rejects(
    applyRecoveryUpgrade({
      plan,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: fence(),
    }),
    /Git scene changed/,
  )
  await assert.rejects(readFile(join(recoveryStateRoot(home), '.clickvibe-state.json')), /ENOENT/)
})

test('old automatic grants are halted and diagnostic references are relocated without changing bytes', async (t) => {
  const { createHash } = await import('node:crypto')
  const { appendDiagnosticRecord, diagnosticRecordForError, readDiagnosticRecords } = await import(
    '../src/infra/diagnostic-record.ts'
  )
  const { autoRunWorkflowFixture } = await import('./workflow-fixture.ts')
  const home = await fixture(t),
    old = join(home, '.clickvibe', 'state')
  const workflow = autoRunWorkflowFixture(home, '180')
  const directory = join(old, 'owner', 'repo', 'issue-180')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'workflow.json'), JSON.stringify(workflow))
  const workItem = { provider: 'github', instance: 'github.com', container: 'owner/repo', id: '180' }
  const raw = Buffer.from('retained diagnostic evidence')
  const artifact = join(old, 'diagnostic-artifact.json')
  await writeFile(artifact, raw)
  const record = diagnosticRecordForError({
    workItem,
    operation: 'fixture',
    classification: 'unknown',
    error: new Error('original failure'),
    rawArtifact: {
      kind: 'diagnostic',
      artifactId: 'retained',
      path: artifact,
      redaction: 'applied',
      contentHash: `sha256-v1_${createHash('sha256').update(raw).digest('base64url')}`,
    },
  })
  await appendDiagnosticRecord(old, record, 100000)
  await appendDiagnosticRecord(
    old,
    {
      ...record,
      diagnosticId: 'missing-artifact',
      rawArtifact: { ...record.rawArtifact!, path: join(old, 'missing.json') },
    },
    100000,
  )
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  await applyRecoveryUpgrade({
    plan,
    fingerprint: plan.fingerprint,
    fingerprintOf: fingerprintWorkItemContract,
    fence: fence(),
  })
  const current = JSON.parse(
    await readFile(join(recoveryStateRoot(home), 'owner', 'repo', 'issue-180', 'workflow.json'), 'utf8'),
  )
  assert.equal(current.autoRun.status, 'paused')
  assert.equal(current.autoRun.recoveryBudget.halted, true)
  assert.equal(current.autoRun.recoveryBudget.runId, 'legacy-unknown')
  assert.deepEqual(current.events, workflow.events)
  const records = await readDiagnosticRecords(recoveryStateRoot(home), workItem)
  assert.deepEqual(await readFile(records[0].rawArtifact!.path), raw)
  assert.equal(records[1].rawArtifact, null)
  assert.match(records[1].message, /source-ref-missing/)
})

test('every published migration phase resumes by readback and never recopies drifted staging', async (t) => {
  for (const phase of ['prepared', 'staged', 'root-published', 'verified']) {
    const home = await fixture(t)
    const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
    const options = {
      home,
      plan,
      fingerprint: plan.fingerprint,
      fingerprintOf: fingerprintWorkItemContract,
      fence: fence(),
    }
    await assert.rejects(
      applyRecoveryUpgrade({
        ...options,
        checkpoint(name) {
          if (name === phase) throw new Error('crash checkpoint')
        },
      }),
      /crash checkpoint/,
    )
    assert.equal((await resumeRecoveryUpgrade({ ...options, fence: fence() })).phase, 'verified')
  }
  const home = await fixture(t)
  const plan = await previewRecoveryUpgrade({ home, baselineSha, fingerprintOf: fingerprintWorkItemContract })
  await assert.rejects(
    applyRecoveryUpgrade({
      plan,
      fingerprint: plan.fingerprint,
      fence: fence(),
      checkpoint(name) {
        if (name === 'staged') throw new Error('crash')
      },
    }),
    /crash/,
  )
  const marker = join(home, '.clickvibe', `.stage-recovery-${plan.fingerprint}`, '.clickvibe-state.json')
  await writeFile(marker, '{}')
  await assert.rejects(resumeRecoveryUpgrade({ home, fingerprint: plan.fingerprint, fence: fence() }), /drift/)
  assert.equal(await readFile(marker, 'utf8'), '{}')
})
