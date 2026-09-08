/** Evidence probe, not migration code. Run against a dependency-installed old checkout:
 * CLICKVIBE_OLD_REPO=/absolute/old-checkout node --test <this-file>
 * Requires the source tree of b92f150, never contacts GitHub, only writes a temporary HOME.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import test from 'node:test'

const baseline = 'b92f150fb3019d6f9eddf5633826feb74100dbb8'
assert.ok(process.env.CLICKVIBE_OLD_REPO, 'set CLICKVIBE_OLD_REPO to the frozen old checkout')
const repo = resolve(process.env.CLICKVIBE_OLD_REPO)
execFileSync('git', ['-C', repo, 'diff', '--exit-code', baseline, '--', 'src', 'package.json', 'pnpm-lock.yaml'])
const load = (path) => import(pathToFileURL(join(repo, path)).href)
const { stateDir, loadWorkflow, issueKey } = await load('src/infra/state.ts')
const { loadConfigFromHome } = await load('src/infra/runtime.ts')
const { appendDiagnosticRecord, diagnosticRecordForError } = await load('src/infra/diagnostic-record.ts')
const { diagnosticLogPath } = await load('src/infra/state-layout.ts')
const { captureGithubIssueContractObservation } = await load('src/workflow/work-item-contract-repository.ts')
const { workItemContractPaths, readCurrentWorkItemContract } = await load('src/infra/work-item-contract-store.ts')
const { fingerprintWorkItemContract } = await load('src/workflow/work-item-contract.ts')
const workItem = { provider: 'github', instance: 'github.com', container: 'fixture/recovery', id: '170' }
const item = {
  url: 'https://github.com/fixture/recovery/issues/170', number: 170, title: 'fixture', state: 'OPEN',
  updatedAt: '2026-09-09T00:00:00Z',
  body: '## 目标\nPreserve state\n## 验收标准\n- [ ] Do not replay\n## 依赖\n无\n## 非目标\n无\n## 约束\n无',
}

async function digestTree(root) {
  const result = {}
  async function walk(path, prefix = '') {
    for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      assert.equal(entry.isSymbolicLink(), false)
      const name = prefix + entry.name
      if (entry.isDirectory()) await walk(join(path, entry.name), `${name}/`)
      else result[name] = createHash('sha256').update(await readFile(join(path, entry.name))).digest('hex')
    }
  }
  await walk(root)
  return result
}

async function isolated(run) {
  const home = await mkdtemp(join(tmpdir(), 'clickvibe-170-root-isolation-'))
  const oldRoot = join(home, '.clickvibe', 'state')
  const newRoot = join(home, '.clickvibe', 'state-recovery-1')
  const savedHome = process.env.HOME
  await mkdir(oldRoot, { recursive: true })
  await mkdir(join(newRoot, 'fixture', 'recovery', 'issue-170'), { recursive: true })
  await writeFile(join(home, '.clickvibe', 'config.yaml'), 'schemaVersion: 2\n')
  await writeFile(join(newRoot, 'fixture', 'recovery', 'issue-170', 'workflow.json'), JSON.stringify({
    key: issueKey('fixture/recovery', '170'), url: item.url, repoKey: 'fixture/recovery',
    autoRun: { recoveryBudget: { schema: 1, runId: 'run-1', cooldownUsed: true, halted: true } },
  }))
  process.env.HOME = home
  try {
    assert.equal(stateDir(), oldRoot)
    await run({ home, oldRoot, newRoot })
  } finally {
    if (savedHome === undefined) delete process.env.HOME
    else process.env.HOME = savedHome
    await rm(home, { recursive: true, force: true })
  }
}

test('old default diagnostic writer changes old directory, not any new-state file', async () => {
  await isolated(async ({ oldRoot, newRoot }) => {
    const before = await digestTree(newRoot)
    const record = diagnosticRecordForError({ workItem, operation: 'probe', classification: 'unknown', error: new Error('fixture') })
    await appendDiagnosticRecord(stateDir(), record, 4096)
    assert.ok((await readFile(diagnosticLogPath(oldRoot, workItem), 'utf8')).includes(record.diagnosticId))
    assert.deepEqual(await digestTree(newRoot), before)
  })
})

test('old contract publisher writes only its default old root', async () => {
  await isolated(async ({ oldRoot, newRoot }) => {
    const before = await digestTree(newRoot)
    const result = await captureGithubIssueContractObservation({ root: stateDir(), item, blockedBy: [], capturedAt: '2026-09-09T00:00:01Z' })
    assert.equal(result.state, 'known')
    assert.ok((await readFile(workItemContractPaths(oldRoot, workItem).current, 'utf8')).length)
    assert.deepEqual(await digestTree(newRoot), before)
  })
})

test('old workflow enumeration cannot consume new halted state; config reader refuses schema 2', async () => {
  await isolated(async ({ home, newRoot }) => {
    const before = await digestTree(newRoot)
    assert.equal(await loadWorkflow(issueKey('fixture/recovery', '170')), null)
    await assert.rejects(loadConfigFromHome(home), /unsupported ClickVibe config schemaVersion: 2/)
    assert.deepEqual(await digestTree(newRoot), before)
  })
})

test('plain copying contract capture fails path validation; rebasing only ArtifactRef restores validation', async () => {
  await isolated(async ({ oldRoot, newRoot }) => {
    const source = await captureGithubIssueContractObservation({ root: oldRoot, item, blockedBy: [], capturedAt: '2026-09-09T00:00:01Z' })
    assert.equal(source.state, 'known')
    const from = workItemContractPaths(oldRoot, workItem)
    const to = workItemContractPaths(newRoot, workItem)
    const oldCapture = join(from.captures, source.captureId)
    const newCapture = join(to.captures, source.captureId)
    await mkdir(newCapture, { recursive: true })
    const raw = await readFile(join(oldCapture, 'raw.json'))
    await writeFile(join(newCapture, 'raw.json'), raw)
    await writeFile(join(newCapture, 'snapshot.json'), await readFile(join(oldCapture, 'snapshot.json')))
    await writeFile(to.current, await readFile(from.current))
    const read = () => readCurrentWorkItemContract({ root: newRoot, workItem, fingerprintOf: fingerprintWorkItemContract })
    assert.deepEqual(await read(), { state: 'unknown', reason: 'raw-artifact-path-mismatch' })
    const snapshot = JSON.parse(await readFile(join(newCapture, 'snapshot.json'), 'utf8'))
    snapshot.rawArtifact.path = join(newCapture, 'raw.json')
    await writeFile(join(newCapture, 'snapshot.json'), JSON.stringify(snapshot))
    const migrated = await read()
    assert.equal(migrated.state, 'known')
    assert.equal(migrated.snapshot.fingerprint, source.snapshot.fingerprint)
    assert.deepEqual(migrated.raw, raw)
  })
})
